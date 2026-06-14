/**
 * Builder XML FA(3) (schemat_FA(3)_v1-0E) z InvoiceInput.
 *
 * Wzorowany na oficjalnym szablonie MF (ksef-client-csharp: invoice-template-fa-3.xml).
 * Zakres MVP: zwykła faktura VAT (RodzajFaktury=VAT), jedna stawka per pozycja,
 * stawki 23/8/5%. Płatność (Platnosc/Zaplacono) i Stopka świadomie pominięte (opcjonalne).
 */
import { create } from "xmlbuilder2";
import type { InvoiceInput, Party, VatRate } from "../types.ts";
import { groszeToDecimal } from "../vat.ts";

const NS = "http://crd.gov.pl/wzor/2025/06/25/13775/";
const ETD = "http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/";
const SYSTEM_INFO = "stripe-ksef-bridge";

/** ISO datetime z 'Z' bez milisekund (format jak w szablonie MF). */
function dataWytworzeniaFa(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function rateLabel(r: VatRate): string {
  return r === "zw" ? "zw" : String(r);
}

/** Pola sum netto/VAT per stawka (P_13_x / P_14_x). */
function totalFields(r: VatRate): { net: string; vat?: string } {
  switch (r) {
    case 23:
      return { net: "P_13_1", vat: "P_14_1" };
    case 8:
      return { net: "P_13_2", vat: "P_14_2" };
    case 5:
      return { net: "P_13_3", vat: "P_14_3" };
    case "zw":
      return { net: "P_13_7" };
    case 0:
      throw new Error("Stawka 0% nieobsługiwana w MVP — użyj 'zw' dla zwolnienia z VAT");
  }
}

function daneIdentyfikacyjne(p: Party): Record<string, unknown> {
  if (!p.nip || !/^\d{10}$/.test(p.nip)) {
    throw new Error(
      `FA(3) B2B wymaga 10-cyfrowego NIP nabywcy/sprzedawcy (otrzymano: ${p.nip ?? "brak"})`,
    );
  }
  return { NIP: p.nip, Nazwa: p.name };
}

function adres(p: Party): Record<string, unknown> {
  const out: Record<string, unknown> = {
    KodKraju: p.country,
    AdresL1: p.addressL1,
  };
  if (p.addressL2) out["AdresL2"] = p.addressL2;
  return out;
}

/** Blok Adnotacje dla zwykłej faktury VAT (brak procedur specjalnych). */
function adnotacjeStandardVat(): Record<string, unknown> {
  return {
    P_16: 2,
    P_17: 2,
    P_18: 2,
    P_18A: 2,
    Zwolnienie: { P_19N: 1 },
    NoweSrodkiTransportu: { P_22N: 1 },
    P_23: 2,
    PMarzy: { P_PMarzyN: 1 },
  };
}

function faWiersz(line: InvoiceInput["lines"][number], nr: number): Record<string, unknown> {
  return {
    NrWierszaFa: nr,
    P_7: line.name,
    P_8A: line.unit,
    P_8B: String(line.qty),
    P_9A: groszeToDecimal(line.netUnitGrosze),
    P_11: groszeToDecimal(line.netTotalGrosze),
    P_12: rateLabel(line.vatRate),
  };
}

/** Buduje (i zwraca) XML FA(3) jako string. */
export function buildFa3Xml(input: InvoiceInput): string {
  const rate = singleRate(input);
  const tf = totalFields(rate);

  const fa: Record<string, unknown> = {
    KodWaluty: input.currency,
    P_1: input.issueDate,
    P_2: input.fvNumber,
  };
  fa[tf.net] = groszeToDecimal(input.netGrosze);
  if (tf.vat) fa[tf.vat] = groszeToDecimal(input.vatGrosze);
  fa["P_15"] = groszeToDecimal(input.grossGrosze);
  fa["Adnotacje"] = adnotacjeStandardVat();
  fa["RodzajFaktury"] = "VAT";
  fa["FaWiersz"] = input.lines.map((l, i) => faWiersz(l, i + 1));
  // Płatność: tool wystawia dopiero po udanej płatności Stripe (kartą) -> oznacz jako zapłacone.
  fa["Platnosc"] = {
    Zaplacono: 1,
    DataZaplaty: input.saleDate ?? input.issueDate,
    FormaPlatnosci: 2, // 2 = karta
  };

  const stopka = input.seller.regon ? { Stopka: { Rejestry: { REGON: input.seller.regon } } } : {};

  const doc = {
    Faktura: {
      "@xmlns": NS,
      "@xmlns:etd": ETD,
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      Naglowek: {
        KodFormularza: { "@kodSystemowy": "FA (3)", "@wersjaSchemy": "1-0E", "#": "FA" },
        WariantFormularza: 3,
        DataWytworzeniaFa: dataWytworzeniaFa(),
        SystemInfo: SYSTEM_INFO,
      },
      Podmiot1: {
        DaneIdentyfikacyjne: daneIdentyfikacyjne(input.seller),
        Adres: adres(input.seller),
      },
      Podmiot2: {
        DaneIdentyfikacyjne: daneIdentyfikacyjne(input.buyer),
        Adres: adres(input.buyer),
        JST: 2,
        GV: 2,
      },
      Fa: fa,
      ...stopka,
    },
  };

  return create({ version: "1.0", encoding: "UTF-8" }, doc).end({ prettyPrint: true });
}

/** MVP: wszystkie pozycje mają tę samą stawkę. Zwraca tę stawkę. */
function singleRate(input: InvoiceInput): VatRate {
  const rates = new Set(input.lines.map((l) => l.vatRate));
  if (rates.size !== 1) {
    throw new Error(`MVP obsługuje jedną stawkę VAT na fakturę, znaleziono: ${[...rates].join(", ")}`);
  }
  return input.lines[0]!.vatRate;
}
