/**
 * Numeracja faktur — konfigurowalny format. Domyślnie {n}/{MM}/{YYYY} (jak w Saldeo, np. 9/06/2026).
 * Licznik resetuje się co rok; seed dotyczy tylko roku cutoveru (patrz ledger.claim / config).
 *
 * Tokeny formatu:
 *   {n}    sekwencja (bez zer wiodących)      {n3}  sekwencja z min. 3 cyframi
 *   {MM}   miesiąc daty wystawienia (01-12)   {YYYY} rok            {YY} 2-cyfrowy rok
 */
export function formatInvoiceNumber(format: string, isoDate: string, seq: number): string {
  const yyyy = isoDate.slice(0, 4);
  const mm = isoDate.slice(5, 7);
  return format
    .replaceAll("{n3}", String(seq).padStart(3, "0"))
    .replaceAll("{n}", String(seq))
    .replaceAll("{MM}", mm)
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yyyy.slice(2));
}

/** Rok z daty ISO YYYY-MM-DD (klucz licznika). */
export function yearOf(isoDate: string): number {
  const y = Number(isoDate.slice(0, 4));
  if (!Number.isInteger(y) || y < 2000) {
    throw new Error(`Nieprawidłowa data do numeracji: ${isoDate}`);
  }
  return y;
}
