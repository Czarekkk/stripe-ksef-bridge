/**
 * Współdzielone typy domenowe. Kwoty pieniężne TRZYMAMY w groszach (integer),
 * żeby uniknąć błędów zmiennoprzecinkowych. Konwersja na PLN tylko przy budowie XML.
 */

/** Stawka VAT: liczba procentowa (23, 8, 5, 0) lub 'zw' (zwolnione). */
export type VatRate = 23 | 8 | 5 | 0 | "zw";

export interface Party {
  /** NIP: 10 cyfr, bez prefiksu kraju i bez spacji. Pusty dla nabywcy bez NIP. */
  nip?: string;
  /** Nazwa firmy / imię i nazwisko. */
  name: string;
  /** Kod kraju ISO (np. 'PL'). */
  country: string;
  /** Adres linia 1 (ulica, nr). FA(3): Adres/AdresL1. */
  addressL1: string;
  /** Adres linia 2 (kod pocztowy + miejscowość). FA(3): Adres/AdresL2. */
  addressL2?: string;
  /** REGON sprzedawcy (opcjonalnie, do Stopki FA(3)). */
  regon?: string;
}

export interface InvoiceLine {
  /** Nazwa towaru/usługi (FA: P_7). */
  name: string;
  /** Ilość (FA: P_8B). */
  qty: number;
  /** Jednostka miary (FA: P_8A), np. 'usł.' / 'szt.' / 'mies.'. */
  unit: string;
  /** Cena jednostkowa netto w groszach (FA: P_9A). */
  netUnitGrosze: number;
  /** Wartość netto pozycji w groszach (FA: P_11). */
  netTotalGrosze: number;
  /** Stawka VAT pozycji (FA: P_12). */
  vatRate: VatRate;
}

export type InvoiceSource = "checkout" | "subscription";

export interface InvoiceInput {
  /** Numer faktury (FA: P_2), np. 'FV-2026-001'. */
  fvNumber: string;
  /** Data wystawienia YYYY-MM-DD (FA: P_1). */
  issueDate: string;
  /** Data dokonania/zakończenia dostawy lub usługi YYYY-MM-DD (FA: P_6). Domyślnie = issueDate. */
  saleDate?: string;
  seller: Party;
  buyer: Party;
  lines: InvoiceLine[];
  /** Kod waluty (FA: KodWaluty), np. 'PLN'. */
  currency: string;
  /** Suma netto w groszach. */
  netGrosze: number;
  /** Suma VAT w groszach. */
  vatGrosze: number;
  /** Kwota należności ogółem (brutto) w groszach (FA: P_15). */
  grossGrosze: number;
  /** Pochodzenie (audyt). */
  source: InvoiceSource;
  /** Id eventu Stripe (idempotencja). */
  stripeEventId: string;
  /** Id Customera Stripe (powiązanie). */
  stripeCustomerId?: string;
  /** Id obiektu Stripe, pod który podpina się panel (PaymentIntent dla one-off, Invoice dla subskrypcji). */
  stripeObjectId?: string;
  /** Pomocniczy id obiektu (dla subskrypcji: PaymentIntent), żeby panel działał i na płatności. */
  stripeObjectId2?: string;
  /** Typ obiektu Stripe powiązanego z fakturą — decyduje gdzie zapisać metadata zwrotnie. */
  stripeObjectType?: "payment_intent" | "invoice";
  /** Dowolna adnotacja, np. „Zapłacono Stripe" / okres subskrypcji. */
  note?: string;
}

/** Status wystawienia w ledgerze. */
export type InvoiceStatus =
  | "pending" // utworzona lokalnie, nie wysłana
  | "sent" // wysłana do KSeF, oczekuje na potwierdzenie
  | "accepted" // KSeF potwierdził (mamy numer KSeF + UPO)
  | "rejected" // KSeF odrzucił
  | "error" // błąd po naszej stronie (np. budowa/walidacja)
  | "manual"; // NIE auto-wystawiono (zagraniczny nabywca / waluta ≠ PLN) — do ręcznego wystawienia

/** Wynik wystawienia w KSeF. */
export interface KsefResult {
  ksefReferenceNumber: string;
  ksefNumber: string;
  upoXml: string;
}
