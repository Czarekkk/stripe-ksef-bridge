/**
 * Oficjalny link weryfikacyjny KSeF — pod nim MF renderuje standardową wizualizację faktury
 * (Aplikacja Podatnika KSeF) i pozwala pobrać oficjalny PDF. Format:
 *   https://qr-{env}.ksef.mf.gov.pl/invoice/{NIP-sprzedawcy}/{DD-MM-YYYY}/{base64url(sha256(xml))}
 * (prod: qr.ksef.mf.gov.pl). Hash liczony z DOKŁADNIE tych bajtów XML, które wysłaliśmy do KSeF.
 */
import { createHash } from "node:crypto";
import type { KsefEnv } from "../config.ts";

export function ksefVerifyUrl(env: KsefEnv, sellerNip: string, fa3Xml: string): string {
  const host = env === "prod" ? "https://qr.ksef.mf.gov.pl" : `https://qr-${env}.ksef.mf.gov.pl`;
  const p1 = fa3Xml.match(/<P_1>([^<]+)<\/P_1>/)?.[1] ?? "";
  const [y, m, d] = p1.split("-");
  const hash = createHash("sha256").update(fa3Xml, "utf8").digest("base64url");
  return `${host}/invoice/${sellerNip}/${d}-${m}-${y}/${hash}`;
}
