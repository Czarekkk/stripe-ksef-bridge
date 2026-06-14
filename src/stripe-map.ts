/**
 * Mapowanie eventów Stripe -> InvoiceDraft (InvoiceInput bez numeru).
 *
 *  - checkout.session.completed  -> opłata jednorazowa (wdrożeniowa). Dane nabywcy + netto/VAT
 *    pochodzą wprost z sesji (skill stripe-payment-link zbiera NIP, adres, metadata.netto_pln).
 *  - invoice.paid                -> subskrypcja. Dane nabywcy dociągamy z Customer (listTaxIds).
 *
 * Zwraca null dla eventów/stanów, których świadomie nie fakturujemy (np. niezapłacone).
 */
import type Stripe from "stripe";
import type { InvoiceDraft } from "./ledger.ts";
import type { Party, VatRate } from "./types.ts";
import { normalizeNip } from "./config.ts";
import { fromGross, fromNetAndGross, plnToGrosze, type VatBreakdown } from "./vat.ts";

/** Eventy, na które reagujemy. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "invoice.paid",
] as const;

export interface MapDeps {
  stripe: Stripe;
  seller: Party;
  /** Data wystawienia/sprzedaży YYYY-MM-DD. */
  today: string;
}

export async function mapEventToDraft(
  event: Stripe.Event,
  deps: MapDeps,
): Promise<InvoiceDraft | null> {
  switch (event.type) {
    case "checkout.session.completed":
      return mapCheckout(event.data.object as Stripe.Checkout.Session, event.id, deps);
    case "invoice.paid":
      return mapInvoice(event.data.object as Stripe.Invoice, event.id, deps);
    default:
      return null;
  }
}

async function mapCheckout(
  session: Stripe.Checkout.Session,
  eventId: string,
  { stripe, seller, today }: MapDeps,
): Promise<InvoiceDraft | null> {
  if (session.payment_status !== "paid") return null;
  if (!session.amount_total || session.amount_total <= 0) return null;

  const grossGrosze = session.amount_total;
  const currency = (session.currency ?? "pln").toUpperCase();
  const md = session.metadata ?? {};

  const rate: VatRate = parseRate(md["vat_pct"], md["vat_exempt"]);
  const breakdown: VatBreakdown =
    md["netto_pln"] != null && md["netto_pln"] !== ""
      ? fromNetAndGross(plnToGrosze(md["netto_pln"]), grossGrosze, rate)
      : fromGross(grossGrosze, rate);

  const buyer = partyFromCheckout(session.customer_details);
  const description = await checkoutLineDescription(stripe, session, md);

  return {
    issueDate: today,
    saleDate: today,
    seller,
    buyer,
    currency,
    lines: [
      {
        name: description,
        qty: 1,
        unit: "usł.",
        netUnitGrosze: breakdown.netGrosze,
        netTotalGrosze: breakdown.netGrosze,
        vatRate: breakdown.rate,
      },
    ],
    netGrosze: breakdown.netGrosze,
    vatGrosze: breakdown.vatGrosze,
    grossGrosze: breakdown.grossGrosze,
    source: "checkout",
    stripeEventId: eventId,
    stripeCustomerId: idOf(session.customer),
    stripeObjectId: idOf(session.payment_intent),
    stripeObjectType: "payment_intent",
    note: "Zapłacono przez Stripe (Checkout)",
  };
}

async function mapInvoice(
  invoice: Stripe.Invoice,
  eventId: string,
  { stripe, seller, today }: MapDeps,
): Promise<InvoiceDraft | null> {
  const grossGrosze = invoice.amount_paid > 0 ? invoice.amount_paid : invoice.amount_due;
  if (!grossGrosze || grossGrosze <= 0) return null;

  const currency = (invoice.currency ?? "pln").toUpperCase();
  const customerId = idOf(invoice.customer);
  if (!customerId) throw new Error(`invoice.paid bez customera (${invoice.id})`);

  // Subskrypcja: domyślnie 23% (Stripe nie rozbija VAT bez Stripe Tax).
  const rate: VatRate = parseRate(invoice.metadata?.["vat_pct"], invoice.metadata?.["vat_exempt"]);
  const breakdown = fromGross(grossGrosze, rate);

  const buyer = await partyFromCustomer(stripe, customerId);
  const line = invoice.lines.data[0];
  const period = formatPeriod(line?.period ?? null, invoice.period_start, invoice.period_end);
  const description = `${line?.description ?? "Abonament ReceptionOS"}${period ? ` — ${period}` : ""}`;

  // PaymentIntent, który opłacił fakturę — drugi klucz lookup, żeby panel działał też na płatności.
  const paymentIntentId = await invoicePaymentIntentId(stripe, invoice);

  return {
    issueDate: today,
    saleDate: today,
    seller,
    buyer,
    currency,
    lines: [
      {
        name: description,
        qty: 1,
        unit: "usł.",
        netUnitGrosze: breakdown.netGrosze,
        netTotalGrosze: breakdown.netGrosze,
        vatRate: breakdown.rate,
      },
    ],
    netGrosze: breakdown.netGrosze,
    vatGrosze: breakdown.vatGrosze,
    grossGrosze: breakdown.grossGrosze,
    source: "subscription",
    stripeEventId: eventId,
    stripeCustomerId: customerId,
    stripeObjectId: invoice.id,
    stripeObjectId2: paymentIntentId,
    stripeObjectType: "invoice",
    note: period ? `Subskrypcja Stripe (${period})` : "Subskrypcja Stripe",
  };
}

/** Wyciąga PaymentIntent powiązany z fakturą (przez expand payments). Null gdy brak. */
async function invoicePaymentIntentId(stripe: Stripe, invoice: Stripe.Invoice): Promise<string | undefined> {
  if (!invoice.id) return undefined;
  try {
    const full = await stripe.invoices.retrieve(invoice.id, { expand: ["payments.data.payment"] });
    const payments = (full as unknown as { payments?: { data?: Array<{ payment?: { type?: string; payment_intent?: unknown } }> } }).payments;
    const pay = payments?.data?.[0]?.payment;
    if (pay?.type === "payment_intent") return idOf(pay.payment_intent as never);
  } catch {
    // brak uprawnień / inny model płatności — pomijamy drugi klucz
  }
  return undefined;
}

// --- helpers ---

function parseRate(vatPct: string | undefined, vatExempt: string | undefined): VatRate {
  if (vatExempt === "true" || vatExempt === "1") return "zw";
  if (vatPct == null || vatPct === "") return 23;
  const n = Number(vatPct);
  if (n === 23 || n === 8 || n === 5 || n === 0) return n;
  throw new Error(`Nieobsługiwana stawka VAT z metadata: ${vatPct}`);
}

function partyFromCheckout(cd: Stripe.Checkout.Session["customer_details"]): Party {
  if (!cd) throw new Error("Brak customer_details w sesji Checkout");
  const nip = pickNip(cd.tax_ids?.map((t) => t.value ?? "") ?? []);
  return {
    nip,
    name: cd.name ?? "(brak nazwy)",
    country: cd.address?.country ?? "PL",
    addressL1: addressLine1(cd.address),
    addressL2: addressLine2(cd.address),
  };
}

async function partyFromCustomer(stripe: Stripe, customerId: string): Promise<Party> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) throw new Error(`Customer ${customerId} usunięty`);
  const taxIds = await stripe.customers.listTaxIds(customerId, { limit: 5 });
  const nip = pickNip(taxIds.data.map((t) => t.value ?? ""));
  return {
    nip,
    name: customer.name ?? "(brak nazwy)",
    country: customer.address?.country ?? "PL",
    addressL1: addressLine1(customer.address),
    addressL2: addressLine2(customer.address),
  };
}

/** Wybiera polski NIP z listy tax id (format 'PL##########' -> 10 cyfr). */
function pickNip(values: string[]): string | undefined {
  for (const v of values) {
    const n = normalizeNip(v);
    if (/^\d{10}$/.test(n)) return n;
  }
  return undefined;
}

function addressLine1(a: Stripe.Address | null | undefined): string {
  if (!a) return "";
  return [a.line1, a.line2].filter(Boolean).join(", ");
}

function addressLine2(a: Stripe.Address | null | undefined): string | undefined {
  if (!a) return undefined;
  const l2 = [a.postal_code, a.city].filter(Boolean).join(" ");
  return l2 || undefined;
}

function idOf(ref: string | { id: string } | null | undefined): string | undefined {
  if (!ref) return undefined;
  return typeof ref === "string" ? ref : ref.id;
}

async function checkoutLineDescription(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  md: Stripe.Metadata,
): Promise<string> {
  try {
    const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 1 });
    const d = items.data[0]?.description;
    if (d) return d;
  } catch {
    // brak uprawnień / sesja bez pozycji — użyj fallbacku
  }
  const slug = md["clinic_slug"];
  return slug ? `Opłata wdrożeniowa — ${slug}` : "Opłata wdrożeniowa ReceptionOS";
}

function formatPeriod(
  period: { start: number | null; end: number | null } | null,
  fallbackStart: number | null | undefined,
  fallbackEnd: number | null | undefined,
): string | null {
  const start = period?.start ?? fallbackStart ?? null;
  if (!start) return null;
  const d = new Date(start * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${mm}/${d.getUTCFullYear()}`;
}
