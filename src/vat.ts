/**
 * Arytmetyka VAT w groszach (integer). Zaokrąglenie half-up do grosza.
 * VAT zawsze liczony jako reszta (gross - net) tam, gdzie znamy obie kwoty,
 * żeby net + vat == gross dokładnie (KSeF odrzuca rozjazd o grosz).
 */
import type { VatRate } from "./types.ts";

export interface VatBreakdown {
  netGrosze: number;
  vatGrosze: number;
  grossGrosze: number;
  rate: VatRate;
}

/** Zaokrąglenie half-up (dla kwot nieujemnych). */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

function ratePct(rate: VatRate): number {
  return rate === "zw" ? 0 : rate;
}

/** Z brutto + stawki: net = round(gross / (1+r)), vat = gross - net. */
export function fromGross(grossGrosze: number, rate: VatRate): VatBreakdown {
  assertNonNegInt(grossGrosze, "grossGrosze");
  const r = ratePct(rate);
  if (r === 0) return { netGrosze: grossGrosze, vatGrosze: 0, grossGrosze, rate };
  const netGrosze = roundHalfUp(grossGrosze / (1 + r / 100));
  return { netGrosze, vatGrosze: grossGrosze - netGrosze, grossGrosze, rate };
}

/** Z netto + stawki: vat = round(net * r), gross = net + vat. */
export function fromNet(netGrosze: number, rate: VatRate): VatBreakdown {
  assertNonNegInt(netGrosze, "netGrosze");
  const r = ratePct(rate);
  const vatGrosze = r === 0 ? 0 : roundHalfUp((netGrosze * r) / 100);
  return { netGrosze, vatGrosze, grossGrosze: netGrosze + vatGrosze, rate };
}

/**
 * Z netto + brutto (oba znane, np. netto z metadata Stripe a brutto = realnie pobrane):
 * vat = gross - net. To preferowana ścieżka dla opłaty wdrożeniowej.
 */
export function fromNetAndGross(netGrosze: number, grossGrosze: number, rate: VatRate): VatBreakdown {
  assertNonNegInt(netGrosze, "netGrosze");
  assertNonNegInt(grossGrosze, "grossGrosze");
  if (grossGrosze < netGrosze) {
    throw new Error(`brutto (${grossGrosze}) < netto (${netGrosze}) — niespójne kwoty`);
  }
  return { netGrosze, vatGrosze: grossGrosze - netGrosze, grossGrosze, rate };
}

function assertNonNegInt(v: number, label: string): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new Error(`${label} musi być nieujemną liczbą całkowitą groszy, otrzymano: ${v}`);
  }
}

/** Grosze -> string "123.45" (kropka dziesiętna, dla XML FA). */
export function groszeToDecimal(grosze: number): string {
  const sign = grosze < 0 ? "-" : "";
  const abs = Math.abs(grosze);
  const zl = Math.floor(abs / 100);
  const gr = abs % 100;
  return `${sign}${zl}.${String(gr).padStart(2, "0")}`;
}

/** PLN (liczba lub string) -> grosze (integer). */
export function plnToGrosze(pln: number | string): number {
  const n = typeof pln === "string" ? Number(pln) : pln;
  if (!Number.isFinite(n)) throw new Error(`Nieprawidłowa kwota PLN: ${pln}`);
  return roundHalfUp(n * 100);
}
