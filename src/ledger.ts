/**
 * Ledger (libSQL / SQLite). Async — działa lokalnie z plikiem (`file:./data/...`)
 * oraz zdalnie z Turso (`libsql://...`) bez zmiany kodu. Turso jest potrzebne na
 * Cloudflare Containers, bo dysk kontenera jest efemeryczny (kasowany przy uśpieniu).
 *
 * Tabela `invoices` = idempotencja (UNIQUE stripe_event_id) + stan + numeracja (z `counter`).
 * `claim()` w jednej transakcji: duplikat ALBO alokacja numeru FV-ROK-NNN + wstawienie `pending`.
 * Retry tego samego eventu -> ten sam numer (brak luk).
 */
import { createClient, type Client } from "@libsql/client";
import type { InvoiceInput, InvoiceStatus, KsefResult } from "./types.ts";
import { formatInvoiceNumber, yearOf } from "./numbering.ts";

export interface InvoiceRow {
  id: number;
  stripe_event_id: string;
  fv_number: string;
  source: string;
  stripe_customer: string | null;
  stripe_object_id: string | null;
  stripe_object_id2: string | null;
  buyer_nip: string | null;
  buyer_name: string | null;
  net_grosze: number;
  vat_grosze: number;
  gross_grosze: number;
  currency: string;
  status: InvoiceStatus;
  ksef_reference: string | null;
  ksef_number: string | null;
  upo_xml: string | null;
  fa3_xml: string | null;
  error: string | null;
  created_at: string;
  issued_at: string | null;
}

export type InvoiceDraft = Omit<InvoiceInput, "fvNumber">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id TEXT    UNIQUE NOT NULL,
  fv_number       TEXT    UNIQUE NOT NULL,
  source          TEXT    NOT NULL,
  stripe_customer TEXT,
  stripe_object_id TEXT,
  stripe_object_id2 TEXT,
  buyer_nip       TEXT,
  buyer_name      TEXT,
  net_grosze      INTEGER NOT NULL,
  vat_grosze      INTEGER NOT NULL,
  gross_grosze    INTEGER NOT NULL,
  currency        TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  ksef_reference  TEXT,
  ksef_number     TEXT,
  upo_xml         TEXT,
  fa3_xml         TEXT,
  error           TEXT,
  created_at      TEXT    NOT NULL,
  issued_at       TEXT
);
CREATE TABLE IF NOT EXISTS counter (
  year     INTEGER PRIMARY KEY,
  last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_object ON invoices(stripe_object_id);
`;

// Kolumny dodawane do istniejących baz (CREATE TABLE IF NOT EXISTS nie zmienia istniejącej tabeli).
const MIGRATIONS = ["ALTER TABLE invoices ADD COLUMN stripe_object_id2 TEXT"];

function nowIso(): string {
  return new Date().toISOString();
}

function asRow(r: unknown): InvoiceRow {
  return r as unknown as InvoiceRow;
}

export class Ledger {
  private constructor(private readonly db: Client) {}

  /** Otwiera ledger i tworzy schemat. url: 'file:./data/x.db' | ':memory:' | 'libsql://...'. */
  static async open(url: string, authToken?: string): Promise<Ledger> {
    const db = createClient(authToken ? { url, authToken } : { url });
    await db.executeMultiple(SCHEMA);
    // Migracje istniejących baz (ignoruj "duplicate column" gdy już są).
    for (const m of MIGRATIONS) {
      try {
        await db.execute(m);
      } catch {
        // kolumna już istnieje
      }
    }
    await db.execute("CREATE INDEX IF NOT EXISTS idx_invoices_object2 ON invoices(stripe_object_id2)");
    return new Ledger(db);
  }

  /** Atomowo: istniejący wiersz (duplikat) ALBO alokacja numeru + nowy wiersz `pending`. */
  async claim(
    draft: InvoiceDraft,
    numbering: { format: string; seed: number; seedYear: number },
  ): Promise<{ row: InvoiceRow; isNew: boolean }> {
    const tx = await this.db.transaction("write");
    try {
      const existing = (
        await tx.execute({
          sql: "SELECT * FROM invoices WHERE stripe_event_id = ?",
          args: [draft.stripeEventId],
        })
      ).rows[0];
      if (existing) {
        await tx.commit();
        return { row: asRow(existing), isNew: false };
      }

      const year = yearOf(draft.issueDate);
      // Seed dotyczy tylko roku cutoveru; kolejne lata startują od 1.
      const initSeq = year === numbering.seedYear ? numbering.seed : 0;
      await tx.execute({
        sql: "INSERT OR IGNORE INTO counter(year, last_seq) VALUES (?, ?)",
        args: [year, initSeq],
      });
      const bumped = (
        await tx.execute({
          sql: "UPDATE counter SET last_seq = last_seq + 1 WHERE year = ? RETURNING last_seq",
          args: [year],
        })
      ).rows[0];
      const fvNumber = formatInvoiceNumber(numbering.format, draft.issueDate, Number(bumped!["last_seq"]));

      await tx.execute({
        sql: `INSERT INTO invoices
          (stripe_event_id, fv_number, source, stripe_customer, stripe_object_id, stripe_object_id2, buyer_nip, buyer_name,
           net_grosze, vat_grosze, gross_grosze, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [
          draft.stripeEventId,
          fvNumber,
          draft.source,
          draft.stripeCustomerId ?? null,
          draft.stripeObjectId ?? null,
          draft.stripeObjectId2 ?? null,
          draft.buyer.nip ?? null,
          draft.buyer.name,
          draft.netGrosze,
          draft.vatGrosze,
          draft.grossGrosze,
          draft.currency,
          nowIso(),
        ],
      });
      const row = (
        await tx.execute({
          sql: "SELECT * FROM invoices WHERE stripe_event_id = ?",
          args: [draft.stripeEventId],
        })
      ).rows[0];
      await tx.commit();
      return { row: asRow(row), isNew: true };
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }

  /**
   * Zapisuje fakturę, której NIE auto-wystawiamy (zagraniczny nabywca / waluta ≠ PLN).
   * Status 'manual', syntetyczny numer (nie zużywa licznika). Idempotentne po event.id.
   */
  async recordManual(draft: InvoiceDraft, reason: string): Promise<{ row: InvoiceRow; isNew: boolean }> {
    const existing = await this.getByEvent(draft.stripeEventId);
    if (existing) return { row: existing, isNew: false };
    await this.db.execute({
      sql: `INSERT INTO invoices
        (stripe_event_id, fv_number, source, stripe_customer, stripe_object_id, stripe_object_id2, buyer_nip, buyer_name,
         net_grosze, vat_grosze, gross_grosze, currency, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
      args: [
        draft.stripeEventId,
        `RĘCZNA/${draft.stripeEventId}`,
        draft.source,
        draft.stripeCustomerId ?? null,
        draft.stripeObjectId ?? null,
        draft.stripeObjectId2 ?? null,
        draft.buyer.nip ?? null,
        draft.buyer.name,
        draft.netGrosze,
        draft.vatGrosze,
        draft.grossGrosze,
        draft.currency,
        reason,
        nowIso(),
      ],
    });
    const row = await this.getByEvent(draft.stripeEventId);
    return { row: row!, isNew: true };
  }

  async getByEvent(eventId: string): Promise<InvoiceRow | undefined> {
    const r = (
      await this.db.execute({ sql: "SELECT * FROM invoices WHERE stripe_event_id = ?", args: [eventId] })
    ).rows[0];
    return r ? asRow(r) : undefined;
  }

  async getByNumber(fvNumber: string): Promise<InvoiceRow | undefined> {
    const r = (
      await this.db.execute({ sql: "SELECT * FROM invoices WHERE fv_number = ?", args: [fvNumber] })
    ).rows[0];
    return r ? asRow(r) : undefined;
  }

  /**
   * Lookup po id obiektu Stripe — pasuje do klucza głównego (PaymentIntent dla one-off,
   * Invoice dla subskrypcji) LUB pomocniczego (PaymentIntent subskrypcji), żeby panel
   * świecił i na fakturze, i na płatności.
   */
  async getByObjectId(objectId: string): Promise<InvoiceRow | undefined> {
    const r = (
      await this.db.execute({
        sql: "SELECT * FROM invoices WHERE stripe_object_id = ? OR stripe_object_id2 = ? ORDER BY id DESC",
        args: [objectId, objectId],
      })
    ).rows[0];
    return r ? asRow(r) : undefined;
  }

  async list(limit = 100): Promise<InvoiceRow[]> {
    const r = await this.db.execute({ sql: "SELECT * FROM invoices ORDER BY id DESC LIMIT ?", args: [limit] });
    return r.rows.map(asRow);
  }

  async listByStatus(status: InvoiceStatus, limit = 100): Promise<InvoiceRow[]> {
    const r = await this.db.execute({
      sql: "SELECT * FROM invoices WHERE status = ? ORDER BY id DESC LIMIT ?",
      args: [status, limit],
    });
    return r.rows.map(asRow);
  }

  async attachXml(eventId: string, fa3Xml: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE invoices SET fa3_xml = ? WHERE stripe_event_id = ?",
      args: [fa3Xml, eventId],
    });
  }

  async setStatus(eventId: string, status: InvoiceStatus): Promise<void> {
    await this.db.execute({
      sql: "UPDATE invoices SET status = ? WHERE stripe_event_id = ?",
      args: [status, eventId],
    });
  }

  async markSent(eventId: string, ksefReference: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE invoices SET status = 'sent', ksef_reference = ? WHERE stripe_event_id = ?",
      args: [ksefReference, eventId],
    });
  }

  async markAccepted(eventId: string, result: KsefResult): Promise<void> {
    await this.db.execute({
      sql: `UPDATE invoices
              SET status = 'accepted', ksef_reference = ?, ksef_number = ?, upo_xml = ?, issued_at = ?
            WHERE stripe_event_id = ?`,
      args: [result.ksefReferenceNumber, result.ksefNumber, result.upoXml, nowIso(), eventId],
    });
  }

  async markRejected(eventId: string, error: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE invoices SET status = 'rejected', error = ? WHERE stripe_event_id = ?",
      args: [error, eventId],
    });
  }

  async markError(eventId: string, error: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE invoices SET status = 'error', error = ? WHERE stripe_event_id = ?",
      args: [error, eventId],
    });
  }

  // --- config (override env w runtime) ---

  /** Wszystkie wpisy config jako mapa. */
  async allConfig(): Promise<Record<string, string>> {
    const r = await this.db.execute("SELECT key, value FROM config");
    const out: Record<string, string> = {};
    for (const row of r.rows) out[String(row["key"])] = String(row["value"]);
    return out;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.execute({
      sql: "INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [key, value],
    });
  }

  async deleteConfig(key: string): Promise<void> {
    await this.db.execute({ sql: "DELETE FROM config WHERE key = ?", args: [key] });
  }

  /** Ustawia licznik dla roku (np. start numeracji od seed: następna faktura = seq+1). */
  async setCounter(year: number, lastSeq: number): Promise<void> {
    await this.db.execute({
      sql: "INSERT INTO counter(year, last_seq) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET last_seq = excluded.last_seq",
      args: [year, lastSeq],
    });
  }

  async getCounter(year: number): Promise<number | undefined> {
    const r = (await this.db.execute({ sql: "SELECT last_seq FROM counter WHERE year = ?", args: [year] })).rows[0];
    return r ? Number(r["last_seq"]) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
