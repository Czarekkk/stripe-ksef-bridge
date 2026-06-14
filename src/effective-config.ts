/**
 * Efektywna konfiguracja: wpisy z tabeli `config` (ustawiane w runtime przez /config)
 * NADPISUJĄ wartości z ENV. Dzięki temu numerację i token KSeF zmienia się bez redeployu.
 *
 * Klucze config: ksef_env, ksef_auth_mode, ksef_token, ksef_dry_run,
 *                invoice_format, invoice_seed, invoice_seed_year.
 */
import type { Config, KsefAuthMode, KsefEnv } from "./config.ts";
import type { Ledger } from "./ledger.ts";

function asEnv(v: string | undefined): KsefEnv | undefined {
  return v === "test" || v === "demo" || v === "prod" ? v : undefined;
}
function asAuth(v: string | undefined): KsefAuthMode | undefined {
  return v === "token" || v === "certificate" ? v : undefined;
}

export async function effectiveConfig(base: Config, ledger: Ledger): Promise<Config> {
  const db = await ledger.allConfig();
  return {
    ...base,
    ksef: {
      ...base.ksef,
      env: asEnv(db["ksef_env"]) ?? base.ksef.env,
      authMode: asAuth(db["ksef_auth_mode"]) ?? base.ksef.authMode,
      token: db["ksef_token"] ?? base.ksef.token,
      dryRun: db["ksef_dry_run"] != null ? db["ksef_dry_run"] === "true" : base.ksef.dryRun,
    },
    numbering: {
      format: db["invoice_format"] ?? base.numbering.format,
      seed: db["invoice_seed"] != null ? Number(db["invoice_seed"]) : base.numbering.seed,
      seedYear: db["invoice_seed_year"] != null ? Number(db["invoice_seed_year"]) : base.numbering.seedYear,
    },
  };
}
