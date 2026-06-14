/**
 * Orkiestracja: event Stripe -> faktura w KSeF.
 *
 *   map -> claim (atomowy dedup + numer) -> build FA(3) -> walidacja XSD -> wyślij KSeF -> zapisz
 *
 * Idempotencja: ledger.claim wykrywa duplikat po event.id. Przy ponowieniu (np. retry webhooka
 * po chwilowym błędzie KSeF) wiersz istnieje ze statusem != accepted -> wznawiamy z TYM SAMYM numerem.
 */
import type Stripe from "stripe";
import type { Config } from "./config.ts";
import type { Ledger, InvoiceDraft } from "./ledger.ts";
import type { KsefClient } from "./ksef/client.ts";
import { mapEventToDraft } from "./stripe-map.ts";
import { buildFa3Xml } from "./fa3/build.ts";
import { validateFa3 } from "./fa3/validate.ts";
import { writeBackKsefMetadata, writeBackManual } from "./stripe-writeback.ts";
import { ksefVerifyUrl } from "./ksef/verify.ts";
import { notify } from "./notify.ts";
import type { InvoiceInput } from "./types.ts";

export interface ProcessDeps {
  stripe: Stripe;
  ledger: Ledger;
  ksef: KsefClient;
  cfg: Config;
  /** Data wystawienia YYYY-MM-DD. */
  today: string;
}

export type ProcessAction = "skipped" | "duplicate" | "issued" | "reissued" | "error" | "manual";

export interface ProcessResult {
  action: ProcessAction;
  fvNumber?: string;
  ksefNumber?: string;
  reason?: string;
}

interface GateResult {
  eligible: boolean;
  reason: string;
}

/**
 * Bramka compliance: automatycznie wystawiamy w KSeF TYLKO faktury krajowe —
 * waluta PLN + polski NIP nabywcy + kraj PL. Wszystko inne (np. klient z UK,
 * GBP, odwrotne obciążenie / VAT np) trafia do RĘCZNEGO wystawienia. Bezpieczny
 * default: gdy cokolwiek się nie zgadza, NIE wysyłamy automatycznie.
 */
function autoIssueGate(draft: InvoiceDraft): GateResult {
  const reasons: string[] = [];
  if (draft.currency !== "PLN") {
    reasons.push(`waluta ${draft.currency} ≠ PLN (np. odwrotne obciążenie / faktura zagraniczna)`);
  }
  if (!draft.buyer.nip) {
    reasons.push("brak polskiego NIP nabywcy");
  }
  if (draft.buyer.country && draft.buyer.country !== "PL") {
    reasons.push(`nabywca spoza PL (kraj ${draft.buyer.country})`);
  }
  if (reasons.length === 0) return { eligible: true, reason: "" };
  return {
    eligible: false,
    reason: `Nie wystawiono automatycznie w KSeF: ${reasons.join("; ")}. Wystaw ręcznie (np. VAT np / odwrotne obciążenie).`,
  };
}

export async function processStripeEvent(
  event: Stripe.Event,
  deps: ProcessDeps,
): Promise<ProcessResult> {
  const { stripe, ledger, ksef, cfg, today } = deps;

  const draft = await mapEventToDraft(event, { stripe, seller: cfg.seller, today });
  if (!draft) return { action: "skipped", reason: `nieobsługiwany/niepłatny: ${event.type}` };

  // Compliance: auto-KSeF tylko dla krajowych (PLN + polski NIP). Reszta -> ręczne wystawienie.
  const gate = autoIssueGate(draft);
  if (!gate.eligible) {
    const { isNew: firstTime } = await ledger.recordManual(draft, gate.reason);
    if (firstTime) {
      try {
        await writeBackManual(stripe, draft, gate.reason);
      } catch (e) {
        console.warn(`[${draft.stripeEventId}] write-back manual nieudany: ${e instanceof Error ? e.message : String(e)}`);
      }
      await notify(cfg, {
        kind: "manual",
        buyerName: draft.buyer.name,
        grossGrosze: draft.grossGrosze,
        currency: draft.currency,
        reason: gate.reason,
      });
    }
    return { action: "manual", reason: gate.reason };
  }

  const { row, isNew } = await ledger.claim(draft, cfg.numbering);
  if (!isNew && row.status === "accepted") {
    return {
      action: "duplicate",
      fvNumber: row.fv_number,
      ksefNumber: row.ksef_number ?? undefined,
    };
  }

  const input: InvoiceInput = { ...draft, fvNumber: row.fv_number };

  const xml = buildFa3Xml(input);
  await ledger.attachXml(draft.stripeEventId, xml);

  const v = validateFa3(xml);
  if (!v.ok) {
    const reason = "XSD: " + v.errors.join("; ");
    await ledger.markError(draft.stripeEventId, reason);
    await notify(cfg, {
      kind: "error",
      fvNumber: row.fv_number,
      buyerName: input.buyer.name,
      grossGrosze: input.grossGrosze,
      currency: input.currency,
      reason,
    });
    return { action: "error", fvNumber: row.fv_number, reason };
  }

  await ledger.setStatus(draft.stripeEventId, "sent");
  let result;
  try {
    result = await ksef.issueInvoice(xml, row.fv_number);
  } catch (e) {
    // Zapisz powód w ledgerze (widoczny w `list`/panelu), powiadom, potem rzuć dalej (Stripe ponowi).
    const reason = e instanceof Error ? e.message : String(e);
    await ledger.markError(draft.stripeEventId, reason);
    await notify(cfg, {
      kind: "error",
      fvNumber: row.fv_number,
      buyerName: input.buyer.name,
      grossGrosze: input.grossGrosze,
      currency: input.currency,
      reason,
    });
    throw e;
  }
  await ledger.markAccepted(draft.stripeEventId, result);

  // Zapis statusu KSeF na obiekt Stripe (metadata) — best-effort.
  const verifyUrl = input.seller.nip ? ksefVerifyUrl(cfg.ksef.env, input.seller.nip, xml) : undefined;
  try {
    await writeBackKsefMetadata(stripe, input, result, cfg.ksef.env, verifyUrl);
  } catch (e) {
    console.warn(
      `[${row.fv_number}] write-back metadata Stripe nieudany (sprawdź WRITE na kluczu): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  await notify(cfg, {
    kind: "issued",
    fvNumber: row.fv_number,
    ksefNumber: result.ksefNumber,
    buyerName: input.buyer.name,
    grossGrosze: input.grossGrosze,
    currency: input.currency,
    verifyUrl,
  });

  return {
    action: isNew ? "issued" : "reissued",
    fvNumber: row.fv_number,
    ksefNumber: result.ksefNumber,
  };
}
