import { describe, expect, it } from "vitest";
import {
  fromGross,
  fromNet,
  fromNetAndGross,
  groszeToDecimal,
  plnToGrosze,
  roundHalfUp,
} from "../src/vat.ts";

describe("vat", () => {
  it("fromNet 23%", () => {
    expect(fromNet(240000, 23)).toEqual({
      netGrosze: 240000,
      vatGrosze: 55200,
      grossGrosze: 295200,
      rate: 23,
    });
  });

  it("fromGross 23% — VAT jako reszta, net+vat=gross", () => {
    const b = fromGross(295200, 23);
    expect(b.netGrosze).toBe(240000);
    expect(b.vatGrosze).toBe(55200);
    expect(b.netGrosze + b.vatGrosze).toBe(b.grossGrosze);
  });

  it("fromNetAndGross liczy VAT jako różnicę", () => {
    expect(fromNetAndGross(240000, 295200, 23).vatGrosze).toBe(55200);
  });

  it("fromNetAndGross odrzuca brutto < netto", () => {
    expect(() => fromNetAndGross(300000, 295200, 23)).toThrow();
  });

  it("zwolnienie (zw) — VAT 0, net=gross", () => {
    expect(fromNet(100000, "zw").vatGrosze).toBe(0);
    expect(fromGross(100000, "zw").netGrosze).toBe(100000);
  });

  it("zaokrąglenie half-up", () => {
    expect(roundHalfUp(81.5)).toBe(82);
    const b = fromGross(100, 23); // 100/1.23 = 81.3 -> 81, vat 19
    expect(b.netGrosze).toBe(81);
    expect(b.vatGrosze).toBe(19);
  });

  it("groszeToDecimal", () => {
    expect(groszeToDecimal(295200)).toBe("2952.00");
    expect(groszeToDecimal(5)).toBe("0.05");
    expect(groszeToDecimal(100)).toBe("1.00");
  });

  it("plnToGrosze", () => {
    expect(plnToGrosze("2400")).toBe(240000);
    expect(plnToGrosze(2400)).toBe(240000);
  });
});
