/**
 * Powiadomienia e-mail przez MailerSend (REST API).
 *
 * Best-effort: NIGDY nie rzuca (błąd maila nie może wywrócić wystawienia faktury) — loguje warn.
 * Wysyłka z domeny zweryfikowanej w MailerSend. Token: MAILERSEND_TOKEN (mlsn.…).
 * Gdy brak konfiguracji (token/adresat/nadawca) — po cichu pomijamy (np. testy lokalne).
 *
 * Stripe (jako platforma) NIE wysyła własnych maili z mostu — dlatego alerty idą stąd, z backendu.
 */
import type { Config } from "./config.ts";

const MAILERSEND_URL = "https://api.mailersend.com/v1/email";

export type NotifyKind = "issued" | "error" | "manual";

export interface NotifyParams {
  kind: NotifyKind;
  fvNumber?: string;
  ksefNumber?: string;
  buyerName?: string;
  grossGrosze?: number;
  currency?: string;
  verifyUrl?: string;
  /** Powód — dla 'error' (komunikat błędu) i 'manual' (dlaczego nie auto-wystawiono). */
  reason?: string;
}

function money(grosze?: number, currency?: string): string {
  if (grosze == null) return "—";
  return `${(grosze / 100).toFixed(2)} ${currency ?? "PLN"}`;
}

interface Mail {
  subject: string;
  lines: string[];
}

function compose(p: NotifyParams): Mail {
  const buyer = p.buyerName ?? "(nieznany nabywca)";
  const amount = money(p.grossGrosze, p.currency);
  switch (p.kind) {
    case "issued":
      return {
        subject: `✅ Faktura ${p.fvNumber ?? ""} wystawiona w KSeF`,
        lines: [
          `Faktura ${p.fvNumber ?? ""} została automatycznie wystawiona w KSeF.`,
          "",
          `Nabywca: ${buyer}`,
          `Kwota: ${amount}`,
          `Numer KSeF: ${p.ksefNumber ?? "—"}`,
          p.verifyUrl ? `Podgląd / pobranie: ${p.verifyUrl}` : "",
        ],
      };
    case "manual":
      return {
        subject: `⚠️ Faktura do RĘCZNEGO wystawienia — ${buyer}`,
        lines: [
          "Płatność NIE została automatycznie zafakturowana w KSeF i wymaga ręcznego wystawienia.",
          "",
          `Nabywca: ${buyer}`,
          `Kwota: ${amount}`,
          `Powód: ${p.reason ?? "—"}`,
          "",
          "Wystaw fakturę ręcznie (np. VAT np / odwrotne obciążenie dla nabywcy zagranicznego).",
        ],
      };
    case "error":
      return {
        subject: `❌ Błąd wystawienia faktury w KSeF${p.fvNumber ? ` (${p.fvNumber})` : ""}`,
        lines: [
          "Wystawienie faktury w KSeF NIE powiodło się. Stripe ponowi webhook; sprawdź most.",
          "",
          `Faktura: ${p.fvNumber ?? "—"}`,
          `Nabywca: ${buyer}`,
          `Kwota: ${amount}`,
          `Błąd: ${p.reason ?? "—"}`,
        ],
      };
  }
}

function htmlOf(lines: string[]): string {
  const body = lines
    .map((l) => (l === "" ? "<br/>" : `<p style="margin:0 0 4px">${escapeHtml(l)}</p>`))
    .join("");
  return `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;color:#1a1a1a">${body}</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wysyła powiadomienie. Cicho pomija gdy brak konfiguracji (token/adresat/nadawca).
 * Nie rzuca — błędy logowane jako warn.
 */
export async function notify(cfg: Config, p: NotifyParams): Promise<void> {
  const { email, mailersendToken, from, fromName } = cfg.notify ?? {};
  if (!email || !mailersendToken || !from) return;

  const mail = compose(p);
  const text = mail.lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");

  try {
    const res = await fetch(MAILERSEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mailersendToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: { email: from, name: fromName ?? "receptionOS KSeF" },
        to: [{ email }],
        subject: mail.subject,
        text,
        html: htmlOf(mail.lines),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notify] MailerSend ${res.status}: ${detail.slice(0, 300)}`);
    }
  } catch (e) {
    console.warn(`[notify] wysyłka maila nieudana: ${e instanceof Error ? e.message : String(e)}`);
  }
}
