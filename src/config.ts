/**
 * Konfiguracja z ENV (wstrzykiwane przez `op run --env-file=.env -- ...`).
 * Sekrety NIE są czytane z dysku — pochodzą z 1Password w runtime.
 */
import type { Party } from "./types.ts";

export type KsefEnv = "test" | "demo" | "prod";
export type KsefAuthMode = "token" | "certificate";

export interface Config {
  port: number;
  stripe: {
    apiKey: string;
    webhookSecret: string;
    /** App signing secret (absec_…) — weryfikuje zapis /config z panelu (fetchStripeSignature). */
    appSecret?: string;
  };
  ksef: {
    env: KsefEnv;
    nip: string;
    authMode: KsefAuthMode;
    certPath?: string;
    certPassword?: string;
    token?: string;
    /** Gdy true: NIE wysyłamy do KSeF — pipeline kończy się syntetycznym UPO (test lokalny). */
    dryRun: boolean;
  };
  seller: Party;
  numbering: {
    /** Format numeru, np. '{n}/{MM}/{YYYY}'. */
    format: string;
    /** Ostatni użyty numer w roku cutoveru (seria kontynuuje od seed+1). */
    seed: number;
    /** Rok, którego dotyczy seed (kolejne lata startują od 1). */
    seedYear: number;
  };
  database: {
    /** libSQL URL: 'file:./data/ksef-bridge.db' lokalnie | 'libsql://...' (Turso) na prod. */
    url: string;
    authToken?: string;
  };
  /** Opcjonalny bearer token chroniący zapis /config (woła go skrypt/panel). */
  bridgeApiToken?: string;
  /** Powiadomienia e-mail (przez MailerSend) o wystawieniu/błędzie/fakturze ręcznej. */
  notify?: {
    /** Adresat alertów (np. ops@example.com). */
    email?: string;
    /** Token MailerSend (mlsn.…) — wysyłka z domeny zweryfikowanej w MailerSend. */
    mailersendToken?: string;
    /** Adres nadawcy (na zweryfikowanej domenie, np. ksef@example.com). */
    from?: string;
    /** Nazwa nadawcy (opcjonalnie). */
    fromName?: string;
  };
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Brak wymaganej zmiennej środowiskowej: ${name}`);
  }
  return v;
}

function optEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function parseKsefEnv(v: string): KsefEnv {
  if (v === "test" || v === "demo" || v === "prod") return v;
  throw new Error(`KSEF_ENV musi być test|demo|prod, otrzymano: ${v}`);
}

function parseAuthMode(v: string): KsefAuthMode {
  if (v === "token" || v === "certificate") return v;
  throw new Error(`KSEF_AUTH_MODE musi być token|certificate, otrzymano: ${v}`);
}

/**
 * Wczytuje pełną konfigurację. Rzuca czytelnym błędem przy braku wymaganych pól.
 * Waliduje też spójność trybu auth KSeF (token vs certificate).
 */
export function loadConfig(): Config {
  const authMode = parseAuthMode(env("KSEF_AUTH_MODE", "token"));
  const dryRun = env("KSEF_DRY_RUN", "false") === "true";

  const ksef: Config["ksef"] = {
    env: parseKsefEnv(env("KSEF_ENV", "test")),
    nip: normalizeNip(env("KSEF_NIP")),
    authMode,
    certPath: optEnv("KSEF_CERT_PATH"),
    certPassword: optEnv("KSEF_CERT_PASSWORD"),
    token: optEnv("KSEF_TOKEN"),
    dryRun,
  };

  // W trybie dry-run nie potrzebujemy sekretów auth (testujemy pipeline lokalnie).
  if (!dryRun && authMode === "token" && !ksef.token) {
    throw new Error("KSEF_AUTH_MODE=token wymaga KSEF_TOKEN (albo ustaw KSEF_DRY_RUN=true)");
  }
  if (!dryRun && authMode === "certificate" && (!ksef.certPath || !ksef.certPassword)) {
    throw new Error(
      "KSEF_AUTH_MODE=certificate wymaga KSEF_CERT_PATH i KSEF_CERT_PASSWORD (albo KSEF_DRY_RUN=true)",
    );
  }

  const seller: Party = {
    nip: normalizeNip(env("SELLER_NIP")),
    name: env("SELLER_NAME"),
    country: env("SELLER_ADDRESS_COUNTRY", "PL"),
    addressL1: env("SELLER_ADDRESS_LINE1"),
    addressL2: `${env("SELLER_ADDRESS_POSTAL")} ${env("SELLER_ADDRESS_CITY")}`,
    regon: optEnv("SELLER_REGON"),
  };

  return {
    port: Number(env("PORT", "3000")),
    stripe: {
      apiKey: env("STRIPE_API_KEY"),
      webhookSecret: env("STRIPE_WEBHOOK_SECRET"),
      appSecret: optEnv("STRIPE_APP_SECRET"),
    },
    ksef,
    seller,
    numbering: {
      format: env("INVOICE_NUMBER_FORMAT", "{n}/{MM}/{YYYY}"),
      seed: Number(env("INVOICE_NUMBER_SEED", "0")),
      seedYear: Number(env("INVOICE_NUMBER_SEED_YEAR", String(new Date().getFullYear()))),
    },
    database: {
      url: env("DATABASE_URL", "file:./data/ksef-bridge.db"),
      authToken: optEnv("DATABASE_AUTH_TOKEN"),
    },
    bridgeApiToken: optEnv("BRIDGE_API_TOKEN"),
    notify: {
      email: optEnv("NOTIFY_EMAIL"),
      mailersendToken: optEnv("MAILERSEND_TOKEN"),
      from: optEnv("NOTIFY_FROM"),
      fromName: optEnv("NOTIFY_FROM_NAME"),
    },
  };
}

/** Usuwa prefiks kraju (PL) i znaki niebędące cyframi. KSeF chce 10 cyfr. */
export function normalizeNip(raw: string): string {
  return raw.replace(/^[A-Za-z]{2}/, "").replace(/\D/g, "");
}
