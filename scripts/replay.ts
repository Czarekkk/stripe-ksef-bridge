/**
 * Ponawia wysyłkę do KSeF dla faktur, które utknęły (status: pending/sent/error/rejected).
 * Używa zapisanego XML FA(3) z ledgera — nie buduje od nowa (ten sam dokument, ten sam numer).
 *
 *   op run --env-file=.env -- npm run replay -- FV-2026-001
 *   op run --env-file=.env -- npm run replay -- --all-failed
 */
import { loadConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { createKsefClient } from "../src/ksef/client.ts";
import type { InvoiceRow } from "../src/ledger.ts";

const cfg = loadConfig();
const ledger = await Ledger.open(cfg.database.url, cfg.database.authToken);
const ksef = createKsefClient(cfg);

const args = process.argv.slice(2);
let targets: InvoiceRow[];
if (args.includes("--all-failed")) {
  targets = [
    ...(await ledger.listByStatus("error")),
    ...(await ledger.listByStatus("rejected")),
    ...(await ledger.listByStatus("sent")),
  ];
} else {
  const fv = args.find((a) => !a.startsWith("--"));
  if (!fv) {
    console.error("Podaj numer faktury (np. FV-2026-001) albo --all-failed");
    process.exit(1);
  }
  const row = await ledger.getByNumber(fv);
  if (!row) {
    console.error(`Nie znaleziono faktury ${fv}`);
    process.exit(1);
  }
  targets = [row];
}

for (const row of targets) {
  if (row.status === "accepted") {
    console.log(`${row.fv_number}: już accepted (KSeF ${row.ksef_number}) — pomijam`);
    continue;
  }
  if (!row.fa3_xml) {
    console.error(`${row.fv_number}: brak zapisanego XML FA(3) — nie można ponowić`);
    continue;
  }
  try {
    await ledger.setStatus(row.stripe_event_id, "sent");
    const result = await ksef.issueInvoice(row.fa3_xml, row.fv_number);
    await ledger.markAccepted(row.stripe_event_id, result);
    console.log(`${row.fv_number}: OK -> KSeF ${result.ksefNumber}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ledger.markError(row.stripe_event_id, msg);
    console.error(`${row.fv_number}: BŁĄD -> ${msg}`);
  }
}
ledger.close();
