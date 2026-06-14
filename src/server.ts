/**
 * Serwer webhooków Stripe -> KSeF.
 *
 *   POST /webhooks/stripe        — weryfikuje podpis, filtruje typy, przetwarza, odsyła 2xx
 *   GET  /health                 — status
 *   GET  /ksef/status|upo|xml/:id — dane dla panelu (CORS)
 *   GET  /config                 — podgląd efektywnej konfiguracji (zamaskowany)
 *   POST /config                 — zapis konfiguracji (numeracja, token KSeF, env) — bearer
 *
 * Konfiguracja z tabeli `config` NADPISUJE ENV (zmiana numeracji/tokenu bez redeployu).
 * Uruchamianie:  op run --env-file=.env -- npm run dev
 */
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import Stripe from "stripe";
import { loadConfig } from "./config.ts";
import { Ledger } from "./ledger.ts";
import { createKsefClient } from "./ksef/client.ts";
import { HANDLED_EVENT_TYPES } from "./stripe-map.ts";
import { processStripeEvent } from "./process.ts";
import { ksefVerifyUrl } from "./ksef/verify.ts";
import { effectiveConfig } from "./effective-config.ts";
import { formatInvoiceNumber, yearOf } from "./numbering.ts";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const cfg = loadConfig();
const stripe = new Stripe(cfg.stripe.apiKey);
const ledger = await Ledger.open(cfg.database.url, cfg.database.authToken);
const handled = new Set<string>(HANDLED_EVENT_TYPES);

const app = new Hono();

app.get("/health", async (c) => {
  const eff = await effectiveConfig(cfg, ledger);
  return c.json({ ok: true, ksefEnv: eff.ksef.env, authMode: eff.ksef.authMode, dryRun: eff.ksef.dryRun });
});

// CORS dla endpointów wołanych przez panel/skrypt.
// ACAO:* jest OK, bo właściwą kontrolą jest podpis/bearer (CORS nie chroni przed curl, podpis tak).
function cors(c: Context) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Stripe-Signature");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// Podpisy z panelu (fetchStripeSignature) mają znacznik czasu; dłuższa tolerancja dla odczytów,
// żeby podpisane linki UPO/XML działały też po chwili (replay tych danych jest mało wrażliwy).
const READ_SIG_TOLERANCE = 60 * 60 * 24; // 24h

function bearerOk(c: Context): boolean {
  return Boolean(cfg.bridgeApiToken) && c.req.header("authorization") === `Bearer ${cfg.bridgeApiToken}`;
}

/** Weryfikuje podpis Stripe (fetchStripeSignature) nad payloadem {user_id, account_id} app-secretem. */
async function verifySig(sig: string | undefined, userId: unknown, accountId: unknown, tolerance = 300): Promise<boolean> {
  const verifier = stripe.webhooks.signature;
  if (!sig || !cfg.stripe.appSecret || !verifier) return false;
  try {
    await verifier.verifyHeaderAsync(JSON.stringify({ user_id: userId, account_id: accountId }), sig, cfg.stripe.appSecret, tolerance);
    return true;
  } catch {
    return false;
  }
}

/** Auth odczytów: panel (podpis w nagłówku lub ?sig= + ?user_id&account_id) albo CLI (bearer). */
async function readAuthorized(c: Context): Promise<boolean> {
  if (bearerOk(c)) return true;
  const sig = c.req.header("stripe-signature") ?? c.req.query("sig");
  return verifySig(sig, c.req.query("user_id"), c.req.query("account_id"), READ_SIG_TOLERANCE);
}

// Reads dla panelu — wymagają podpisu Stripe (panel) lub bearera (CLI). OPTIONS przepuszczamy (preflight).
app.use("/ksef/*", async (c, next) => {
  cors(c);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  if (!(await readAuthorized(c))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/ksef/status/:objectId", async (c) => {
  const row = await ledger.getByObjectId(c.req.param("objectId"));
  if (!row) return c.json({ found: false });
  const eff = await effectiveConfig(cfg, ledger);
  const verifyUrl =
    row.status === "accepted" && row.fa3_xml && eff.seller.nip
      ? ksefVerifyUrl(eff.ksef.env, eff.seller.nip, row.fa3_xml)
      : null;
  return c.json({
    found: true,
    status: row.status,
    ksefNumber: row.ksef_number,
    ksefReference: row.ksef_reference,
    environment: eff.ksef.env,
    fvNumber: row.fv_number,
    buyerName: row.buyer_name,
    sentAt: row.issued_at,
    grossGrosze: row.gross_grosze,
    currency: row.currency,
    verifyUrl,
    error: row.error,
    hasUpo: Boolean(row.upo_xml),
    hasXml: Boolean(row.fa3_xml),
  });
});

app.get("/ksef/upo/:objectId", async (c) => {
  const row = await ledger.getByObjectId(c.req.param("objectId"));
  if (!row?.upo_xml) return c.json({ error: "brak UPO" }, 404);
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="UPO-${row.fv_number.replace(/\//g, "-")}.json"`);
  return c.body(row.upo_xml);
});

app.get("/ksef/xml/:objectId", async (c) => {
  const row = await ledger.getByObjectId(c.req.param("objectId"));
  if (!row?.fa3_xml) return c.json({ error: "brak XML" }, 404);
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${row.fv_number.replace(/\//g, "-")}.xml"`);
  return c.body(row.fa3_xml);
});

// --- konfiguracja (numeracja, token KSeF, env) ---
const CONFIG_KEYS = [
  "ksef_token",
  "ksef_env",
  "ksef_auth_mode",
  "ksef_dry_run",
  "invoice_format",
  "invoice_seed",
  "invoice_seed_year",
] as const;

app.use("/config", async (c, next) => {
  cors(c);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/config", async (c) => {
  if (!(await readAuthorized(c))) return c.json({ error: "unauthorized" }, 401);
  const eff = await effectiveConfig(cfg, ledger);
  const year = yearOf(new Date().toISOString().slice(0, 10));
  const last = await ledger.getCounter(year);
  const nextSeq = (last ?? (year === eff.numbering.seedYear ? eff.numbering.seed : 0)) + 1;
  return c.json({
    ksefEnv: eff.ksef.env,
    authMode: eff.ksef.authMode,
    nip: eff.ksef.nip,
    dryRun: eff.ksef.dryRun,
    tokenSet: Boolean(eff.ksef.token),
    seller: { name: eff.seller.name, nip: eff.seller.nip },
    numbering: {
      format: eff.numbering.format,
      seed: eff.numbering.seed,
      seedYear: eff.numbering.seedYear,
      lastIssued: last ?? null,
      nextNumber: formatInvoiceNumber(eff.numbering.format, new Date().toISOString().slice(0, 10), nextSeq),
    },
    writable: Boolean(cfg.bridgeApiToken || cfg.stripe.appSecret),
    panelWritable: Boolean(cfg.stripe.appSecret),
  });
});

app.post("/config", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Autoryzacja: ALBO podpis Stripe z panelu (fetchStripeSignature), ALBO bearer (CLI `npm run config`).
  // Podpis weryfikujemy app secretem (absec_…) na payloadzie {user_id, account_id} — nic tajnego w bundlu panelu.
  if (!cfg.bridgeApiToken && !cfg.stripe.appSecret) {
    return c.json({ error: "Zapis wyłączony — ustaw BRIDGE_API_TOKEN (CLI) lub STRIPE_APP_SECRET (panel)." }, 403);
  }
  const authorized =
    bearerOk(c) || (await verifySig(c.req.header("stripe-signature"), body["user_id"], body["account_id"]));
  if (!authorized) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const applied: string[] = [];
  for (const k of CONFIG_KEYS) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null || v === "") {
      await ledger.deleteConfig(k);
      applied.push(`${k}=∅`);
      continue;
    }
    const s = String(v);
    if (k === "ksef_env" && !["test", "demo", "prod"].includes(s)) return c.json({ error: "ksef_env: test|demo|prod" }, 400);
    if (k === "ksef_auth_mode" && !["token", "certificate"].includes(s)) return c.json({ error: "ksef_auth_mode: token|certificate" }, 400);
    if (k === "ksef_dry_run" && !["true", "false"].includes(s)) return c.json({ error: "ksef_dry_run: true|false" }, 400);
    if ((k === "invoice_seed" || k === "invoice_seed_year") && !/^\d+$/.test(s)) return c.json({ error: `${k}: liczba` }, 400);
    await ledger.setConfig(k, s);
    applied.push(`${k}=${k === "ksef_token" ? "***" : s}`);
  }
  // Ustawienie seed/seed_year inicjuje licznik (następna faktura = seed+1).
  if ("invoice_seed" in body || "invoice_seed_year" in body) {
    const eff = await effectiveConfig(cfg, ledger);
    await ledger.setCounter(eff.numbering.seedYear, eff.numbering.seed);
    applied.push(`counter[${eff.numbering.seedYear}]=${eff.numbering.seed}`);
  }
  return c.json({ ok: true, applied });
});

app.post("/webhooks/stripe", async (c) => {
  const sig = c.req.header("stripe-signature");
  if (!sig) return c.json({ error: "brak nagłówka stripe-signature" }, 400);

  const raw = await c.req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, cfg.stripe.webhookSecret);
  } catch (e) {
    return c.json({ error: `weryfikacja podpisu nieudana: ${errMsg(e)}` }, 400);
  }

  if (!handled.has(event.type)) {
    return c.json({ received: true, skipped: event.type });
  }

  const today = new Date().toISOString().slice(0, 10);
  try {
    const eff = await effectiveConfig(cfg, ledger);
    const ksef = createKsefClient(eff);
    const res = await processStripeEvent(event, { stripe, ledger, ksef, cfg: eff, today });
    console.log(`[${event.id}] ${event.type} -> ${res.action} ${res.fvNumber ?? ""} ${res.ksefNumber ?? ""}`.trim());
    if (res.action === "error") return c.json({ received: true, ...res }, 422);
    return c.json({ received: true, ...res });
  } catch (e) {
    console.error(`[${event.id}] błąd przetwarzania:`, e);
    return c.json({ received: true, error: errMsg(e) }, 500);
  }
});

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(
    `stripe-ksef-bridge nasłuchuje na :${info.port}  | KSeF=${cfg.ksef.env} auth=${cfg.ksef.authMode} dryRun=${cfg.ksef.dryRun}`,
  );
});
