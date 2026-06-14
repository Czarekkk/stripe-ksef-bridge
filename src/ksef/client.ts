/**
 * Klient KSeF — wąski interfejs `issueInvoice(xml) -> { numer KSeF, UPO }`.
 *
 * Dwie implementacje:
 *  - DryRunKsefClient: NIE wysyła do KSeF, zwraca syntetyczne UPO. Pozwala przetestować
 *    cały pipeline (webhook -> mapowanie -> FA(3) -> walidacja -> "wystawienie" -> ledger)
 *    lokalnie z Stripe CLI, bez żadnych kredencjałów KSeF.
 *  - LiveKsefClient: realna wysyłka przez `ksef-client-ts` (KSeF 2.0): auth (token/PKCS#12) ->
 *    otwórz sesję online -> wyślij -> zamknij -> pobierz UPO -> wyciągnij numer KSeF.
 *
 * UWAGA: LiveKsefClient jest zaimplementowany wg API ksef-client-ts 0.9 i WYMAGA weryfikacji
 * na środowisku TESTOWYM KSeF z realnym tokenem/certyfikatem (Faza 1 w README). Do tego czasu
 * domyślnie pracujemy z KSEF_DRY_RUN=true.
 */
import { readFileSync } from "node:fs";
import {
  KSeFClient,
  authenticateWithPkcs12,
  authenticateWithToken,
  openOnlineSession,
} from "ksef-client-ts";
import type { Config } from "../config.ts";
import type { KsefResult } from "../types.ts";

export interface KsefClient {
  /**
   * Wysyła XML FA(3) do KSeF i zwraca numer KSeF + UPO.
   * @param fvNumber numer faktury (P_2) — do dopasowania dokumentu w UPO.
   */
  issueInvoice(fa3Xml: string, fvNumber: string): Promise<KsefResult>;
}

const ENV_MAP = { test: "TEST", demo: "DEMO", prod: "PROD" } as const;

/** Tryb testowy — bez sieci. */
export class DryRunKsefClient implements KsefClient {
  async issueInvoice(_fa3Xml: string, fvNumber: string): Promise<KsefResult> {
    return {
      ksefReferenceNumber: `DRYRUN-SES-${fvNumber}`,
      ksefNumber: `DRYRUN-${fvNumber}-${Date.now()}`,
      upoXml: `<DryRun fvNumber="${fvNumber}">KSEF_DRY_RUN=true — brak realnego wystawienia w KSeF</DryRun>`,
    };
  }
}

/** Realna integracja z KSeF 2.0 przez ksef-client-ts. */
export class LiveKsefClient implements KsefClient {
  constructor(private readonly cfg: Config) {}

  async issueInvoice(fa3Xml: string, fvNumber: string): Promise<KsefResult> {
    const { ksef } = this.cfg;
    const client = new KSeFClient({ environment: ENV_MAP[ksef.env] });

    if (ksef.authMode === "token") {
      if (!ksef.token) throw new Error("Brak KSEF_TOKEN dla trybu token");
      await authenticateWithToken(client, { nip: ksef.nip, token: ksef.token });
    } else {
      if (!ksef.certPath || !ksef.certPassword) {
        throw new Error("Brak certyfikatu KSeF (KSEF_CERT_PATH/KSEF_CERT_PASSWORD)");
      }
      const p12 = readFileSync(ksef.certPath);
      await authenticateWithPkcs12(client, { nip: ksef.nip, p12, password: ksef.certPassword });
    }

    // Walidację XSD robimy własnym walidatorem PRZED wysyłką (validate:false tutaj).
    const handle = await openOnlineSession(client, { validate: false });
    const sessionInvoiceRef = await handle.sendInvoice(fa3Xml);
    await handle.close();
    const upo = await handle.waitForUpoParsed();

    const conf = upo.parsed[0];
    if (!conf) throw new Error("KSeF: brak potwierdzenia UPO po wysłaniu faktury");
    const doc = conf.dokumenty.find((d) => d.numerFaktury === fvNumber) ?? conf.dokumenty[0];
    if (!doc) throw new Error("KSeF: UPO nie zawiera dokumentu faktury");

    return {
      ksefReferenceNumber: conf.numerReferencyjnySesji || sessionInvoiceRef,
      ksefNumber: doc.numerKSeFDokumentu,
      upoXml: JSON.stringify(conf),
    };
  }
}

export function createKsefClient(cfg: Config): KsefClient {
  return cfg.ksef.dryRun ? new DryRunKsefClient() : new LiveKsefClient(cfg);
}
