/**
 * Zapis statusu KSeF z powrotem na obiekt Stripe (metadata), żeby był widoczny
 * w dashboardzie Stripe i w panelu UI extension.
 *
 * One-off (Checkout) -> metadata na PaymentIntent. Subskrypcja -> metadata na Invoice.
 * Wymaga uprawnień WRITE na PaymentIntents / Invoices na kluczu Stripe.
 * Best-effort: wołane w try/catch po stronie procesu — błąd nie blokuje wystawienia w KSeF.
 */
import type Stripe from "stripe";
import type { InvoiceInput, KsefResult } from "./types.ts";

export async function writeBackKsefMetadata(
  stripe: Stripe,
  input: InvoiceInput,
  result: KsefResult,
  ksefEnv: string,
  verifyUrl?: string,
): Promise<void> {
  if (!input.stripeObjectId || !input.stripeObjectType) return;

  const metadata: Record<string, string> = {
    ksef_status: "accepted",
    ksef_number: result.ksefNumber,
    ksef_environment: ksefEnv,
    ksef_reference: result.ksefReferenceNumber,
    ksef_fv: input.fvNumber,
    ksef_sent_at: new Date().toISOString(),
  };
  if (verifyUrl) metadata["ksef_verify_url"] = verifyUrl;

  if (input.stripeObjectType === "payment_intent") {
    await stripe.paymentIntents.update(input.stripeObjectId, { metadata });
  } else {
    await stripe.invoices.update(input.stripeObjectId, { metadata });
  }
  // Subskrypcja: zapisz też na PaymentIncie, żeby numer KSeF był widoczny na stronie płatności.
  if (input.stripeObjectId2) {
    try {
      await stripe.paymentIntents.update(input.stripeObjectId2, { metadata });
    } catch {
      // np. brak uprawnień — nieblokujące
    }
  }
}

/**
 * Write-back dla płatności, których NIE wystawiamy automatycznie (zagraniczny nabywca / waluta ≠ PLN).
 * Oznacza obiekt Stripe statusem 'manual' + powodem, żeby w dashboardzie było widać że czeka na ręczną fakturę.
 */
export async function writeBackManual(
  stripe: Stripe,
  input: Pick<InvoiceInput, "stripeObjectId" | "stripeObjectId2" | "stripeObjectType">,
  reason: string,
): Promise<void> {
  if (!input.stripeObjectId || !input.stripeObjectType) return;

  const metadata: Record<string, string> = {
    ksef_status: "manual",
    ksef_reason: reason,
    ksef_note: "Do ręcznego wystawienia (np. VAT np / odwrotne obciążenie).",
    ksef_marked_at: new Date().toISOString(),
  };

  if (input.stripeObjectType === "payment_intent") {
    await stripe.paymentIntents.update(input.stripeObjectId, { metadata });
  } else {
    await stripe.invoices.update(input.stripeObjectId, { metadata });
  }
  if (input.stripeObjectId2) {
    try {
      await stripe.paymentIntents.update(input.stripeObjectId2, { metadata });
    } catch {
      // np. brak uprawnień — nieblokujące
    }
  }
}
