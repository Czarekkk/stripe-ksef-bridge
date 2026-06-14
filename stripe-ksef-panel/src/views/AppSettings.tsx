import { useEffect, useState } from "react";
import { Badge, Banner, Box, List, ListItem, Select, SettingsView, Spinner, TextField } from "@stripe/ui-extension-sdk/ui";
import { fetchStripeSignature } from "@stripe/ui-extension-sdk/utils";
import type { ExtensionContextValue } from "@stripe/ui-extension-sdk/context";
import { BRIDGE_URL as BACKEND } from "../bridge";

interface ConfigData {
  ksefEnv?: string;
  authMode?: string;
  nip?: string;
  dryRun?: boolean;
  tokenSet?: boolean;
  seller?: { name?: string; nip?: string };
  numbering?: { format?: string; seed?: number; seedYear?: number; lastIssued?: number | null; nextNumber?: string };
  writable?: boolean;
  panelWritable?: boolean;
}

/** Widok ustawień (viewport: settings) — edycja konfiguracji mostu wprost z panelu Stripe.
 *  Zapis autoryzowany podpisem Stripe (fetchStripeSignature) — żaden sekret nie ląduje w bundlu panelu. */
const AppSettings = ({ userContext }: ExtensionContextValue) => {
  const [cfg, setCfg] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | undefined>(undefined);

  const uid = userContext?.id ?? "";
  const aid = userContext?.account?.id ?? "";
  const authQuery = `user_id=${encodeURIComponent(uid)}&account_id=${encodeURIComponent(aid)}`;

  // Odczyt /config wymaga teraz podpisu Stripe (jak zapis) — nic nie jest publiczne bez auth.
  const fetchConfig = async (): Promise<ConfigData> => {
    const sig = await fetchStripeSignature();
    const r = await fetch(`${BACKEND}/config?${authQuery}`, { headers: { "Stripe-Signature": sig } });
    return r.json();
  };

  const load = () => {
    setLoading(true);
    return fetchConfig()
      .then((d) => setCfg(d))
      .catch(() => setCfg({}))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    fetchConfig()
      .then((d) => active && setCfg(d))
      .catch(() => active && setCfg({}))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authQuery]);

  // Wartości wyjściowe — wysyłamy do /config TYLKO te, które user zmienił (żeby zapis seeda nie zresetował licznika).
  const orig: Record<string, string> = {
    ksef_env: cfg?.ksefEnv ?? "",
    ksef_dry_run: String(cfg?.dryRun ?? false),
    ksef_auth_mode: cfg?.authMode ?? "",
    invoice_format: cfg?.numbering?.format ?? "",
    invoice_seed: String(cfg?.numbering?.lastIssued ?? cfg?.numbering?.seed ?? 0),
    invoice_seed_year: String(cfg?.numbering?.seedYear ?? new Date().getFullYear()),
  };

  const handleSave = async (values: { [x: string]: string }) => {
    setStatus("Zapisywanie…");
    const body: Record<string, unknown> = {
      user_id: userContext?.id,
      account_id: userContext?.account?.id,
    };
    let changed = 0;
    for (const k of Object.keys(orig)) {
      const v = values[k];
      if (v !== undefined && v !== orig[k]) {
        body[k] = v;
        changed++;
      }
    }
    if (values["ksef_token"]) {
      body["ksef_token"] = values["ksef_token"];
      changed++;
    }
    if (changed === 0) {
      setStatus("Brak zmian");
      return;
    }
    try {
      const res = await fetch(`${BACKEND}/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": await fetchStripeSignature(),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setStatus("Zapisano ✓");
        await load();
      } else {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        setStatus(`Błąd: ${e.error ?? res.status}`);
      }
    } catch (e) {
      setStatus(`Błąd sieci: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (loading && !cfg) {
    return (
      <SettingsView onSave={handleSave}>
        <Spinner />
      </SettingsView>
    );
  }

  return (
    <SettingsView onSave={handleSave} statusMessage={status}>
      <Box css={{ stack: "y", gap: "large" }}>
        <Box css={{ stack: "x", gap: "small", alignY: "center" }}>
          <Badge type={cfg?.dryRun ? "warning" : "positive"}>
            {cfg?.dryRun ? "DRY-RUN (nie wysyła)" : `KSeF ${cfg?.ksefEnv ?? "—"}`}
          </Badge>
          <Badge type={cfg?.tokenSet ? "positive" : "negative"}>
            {cfg?.tokenSet ? "token ustawiony" : "brak tokenu"}
          </Badge>
        </Box>

        {cfg?.panelWritable === false ? (
          <Banner
            type="caution"
            description="Edycja z panelu wyłączona — ustaw STRIPE_APP_SECRET (absec_…) w środowisku mostu. Do czasu: npm run config."
          />
        ) : null}

        <List>
          <ListItem title="NIP sprzedawcy" value={cfg?.seller?.nip ?? cfg?.nip ?? "—"} />
          <ListItem title="Następny numer" value={cfg?.numbering?.nextNumber ?? "—"} />
        </List>

        <Select name="ksef_env" label="Środowisko KSeF" defaultValue={cfg?.ksefEnv ?? "test"}>
          <option value="test">test (sandbox)</option>
          <option value="demo">demo</option>
          <option value="prod">prod (produkcja)</option>
        </Select>

        <Select name="ksef_dry_run" label="Wysyłka do KSeF" defaultValue={String(cfg?.dryRun ?? false)}>
          <option value="false">Wysyłaj faktury do KSeF</option>
          <option value="true">DRY-RUN (nie wysyłaj — test)</option>
        </Select>

        <Select name="ksef_auth_mode" label="Tryb autoryzacji" defaultValue={cfg?.authMode ?? "token"}>
          <option value="token">token KSeF</option>
          <option value="certificate">certyfikat (XAdES)</option>
        </Select>

        <TextField
          name="ksef_token"
          type="password"
          label="Token KSeF"
          description="Wpisz nowy token, aby zmienić. Puste = bez zmian."
          placeholder={cfg?.tokenSet ? "•••••••• (ustawiony)" : "(brak — wklej token)"}
          defaultValue=""
        />

        <TextField
          name="invoice_format"
          label="Format numeracji"
          description="Tokeny: {n} {n3} {MM} {YYYY} {YY}. Np. {n}/{MM}/{YYYY}"
          defaultValue={cfg?.numbering?.format ?? "{n}/{MM}/{YYYY}"}
        />

        <TextField
          name="invoice_seed"
          type="number"
          label="Ostatni numer (kolejna faktura = +1)"
          description="Ustaw na ostatni numer z Saldeo, by kontynuować serię. UWAGA: zapis resetuje licznik."
          defaultValue={String(cfg?.numbering?.lastIssued ?? cfg?.numbering?.seed ?? 0)}
        />

        <TextField
          name="invoice_seed_year"
          type="number"
          label="Rok serii"
          defaultValue={String(cfg?.numbering?.seedYear ?? new Date().getFullYear())}
        />
      </Box>
    </SettingsView>
  );
};

export default AppSettings;
