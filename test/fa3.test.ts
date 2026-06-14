import { describe, expect, it } from "vitest";
import { buildFa3Xml } from "../src/fa3/build.ts";
import { validateFa3 } from "../src/fa3/validate.ts";
import type { InvoiceInput } from "../src/types.ts";

const sample: InvoiceInput = {
  fvNumber: "FV-2026-001",
  issueDate: "2026-06-13",
  saleDate: "2026-06-13",
  seller: {
    nip: "5260001246",
    name: "Przykładowy Sprzedawca sp. z o.o.",
    country: "PL",
    addressL1: "ul. Przykładowa 1",
    addressL2: "00-001 Warszawa",
    regon: "000000000",
  },
  buyer: {
    nip: "1111111111",
    name: "Klinika Dentystyczna Sp. z o.o.",
    country: "PL",
    addressL1: "ul. Polna 1",
    addressL2: "30-001 Kraków",
  },
  lines: [
    {
      name: "Opłata wdrożeniowa — Klinika Dentystyczna",
      qty: 1,
      unit: "usł.",
      netUnitGrosze: 240000,
      netTotalGrosze: 240000,
      vatRate: 23,
    },
  ],
  currency: "PLN",
  netGrosze: 240000,
  vatGrosze: 55200,
  grossGrosze: 295200,
  source: "checkout",
  stripeEventId: "evt_test_1",
  note: "test",
};

describe("FA(3) builder", () => {
  it("builds XML that validates against the official XSD (23%)", () => {
    const xml = buildFa3Xml(sample);
    const res = validateFa3(xml);
    if (!res.ok) console.error("XSD errors:\n" + res.errors.join("\n"));
    expect(res.ok).toBe(true);
  });

  it("rejects buyer without NIP", () => {
    const bad = { ...sample, buyer: { ...sample.buyer, nip: undefined } };
    expect(() => buildFa3Xml(bad)).toThrow(/NIP/);
  });
});
