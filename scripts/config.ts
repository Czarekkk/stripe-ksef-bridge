/**
 * Podgląd i zmiana konfiguracji mostu (numeracja, token KSeF, env) bez redeployu.
 *
 *   npm run config                                  # pokaż aktualną konfigurację
 *   npm run config -- set invoice_seed 8            # numeracja: start od 8 (następna = 9)
 *   npm run config -- set invoice_format "{n}/{MM}/{YYYY}"
 *   npm run config -- set invoice_seed_year 2026
 *   npm run config -- set ksef_env prod
 *   npm run config -- set ksef_token <token>        # token KSeF (prod)
 *   npm run config -- set ksef_dry_run false
 *   npm run config -- unset ksef_token              # wróć do wartości z ENV
 *
 * Zapis wymaga BRIDGE_API_TOKEN (ten sam co na moście) + BRIDGE_URL (URL Twojego mostu).
 */
const BRIDGE = process.env["BRIDGE_URL"] ?? "http://localhost:3000";
const TOKEN = process.env["BRIDGE_API_TOKEN"];

const [cmd, key, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "get" || cmd === "show") {
  const r = await fetch(`${BRIDGE}/config`);
  console.log(JSON.stringify(await r.json(), null, 2));
} else if (cmd === "set" || cmd === "unset") {
  if (!key) {
    console.error("Użycie: npm run config -- set <key> <value>  |  unset <key>");
    process.exit(1);
  }
  if (!TOKEN) {
    console.error("Brak BRIDGE_API_TOKEN — ustaw go w środowisku mostu (Railway) i lokalnie do zapisu.");
    process.exit(1);
  }
  const value = cmd === "unset" ? "" : rest.join(" ");
  const res = await fetch(`${BRIDGE}/config`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ [key]: value }),
  });
  console.log(res.status, await res.text());
} else {
  console.error("Komendy: (brak)=pokaż | set <key> <value> | unset <key>");
  process.exit(1);
}
