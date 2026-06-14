# stripe-ksef-bridge

Automatyczne wystawianie faktur w **KSeF** po każdej udanej płatności **Stripe**.
Zastępuje ręczne wystawianie w SaldeoSMART: webhook Stripe → faktura FA(3) → KSeF → numer KSeF + UPO w ledgerze.

> 🇬🇧 **English:** A small Node/TypeScript service that auto-issues a Polish **KSeF** e-invoice in the
> official **FA(3)** structure after every successful **Stripe** payment (one-off Checkout and recurring
> invoices), then stores the KSeF number + UPO receipt. Numbering continues your existing series; auth uses
> a KSeF token or certificate (no qualified seal). Only domestic sales (PLN + Polish VAT id) are auto-issued —
> anything else (e.g. a foreign buyer / reverse charge) is flagged for manual issuance. Optional email alerts
> (MailerSend) and an optional Stripe App panel showing live status. The detailed runbook below is in Polish.

```
Stripe (sandbox/prod)  ──webhook──▶  [stripe-ksef-bridge: Node+TS]  ──▶  KSeF API 2.0 (test/demo/prod)
  checkout.session.completed            verify sig · dedup · gate · FA(3) · XSD · send   numer KSeF + UPO → libSQL
  invoice.paid                                                                          ↘ księgowość: Saldeo pobiera z KSeF
```

- **Bezpośrednio Stripe → KSeF** (bez API Saldeo). Numeracja `{nr}/{MM}/{YYYY}` po naszej stronie.
- **Auth KSeF**: token KSeF lub certyfikat KSeF (ten sam mechanizm co w Saldeo) — **bez pieczęci kwalifikowanej**.
- **Bramka compliance**: auto-wystawiamy TYLKO faktury krajowe (`PLN` + polski NIP + kraj PL). Reszta (np. nabywca z UK, GBP, odwrotne obciążenie) → status `manual` do ręcznego wystawienia, NIE zużywa numeru.
- **Powiadomienia e-mail** (MailerSend, opcjonalne): faktura wystawiona / błąd / do ręcznego wystawienia.
- **Panel Stripe** (opcjonalny): status KSeF na płatności/fakturze (live) + edytowalne ustawienia (numeracja, token, env) wprost z dashboardu, autoryzowane podpisem Stripe.
- Stos: Node 24, TypeScript, Hono, **libSQL** (`@libsql/client` — plik lokalnie / wolumen na prod / Turso), `xmlbuilder2`, `libxml2-wasm` (walidacja XSD), `ksef-client-ts` (transport KSeF 2.0).

## Stan / dojrzałość

| Element | Status |
|---|---|
| Webhook + weryfikacja podpisu + dedup + numeracja | ✅ przetestowane lokalnie (podpisany webhook) |
| Budowa FA(3) + walidacja wg oficjalnego XSD | ✅ test wg `schemat_FA(3)_v1-0E` |
| Pipeline end-to-end (dry-run) | ✅ testy jednostkowe + serwer |
| Wysyłka do realnego KSeF (`LiveKsefClient`) | ✅ **zweryfikowane na środowisku TESTOWYM KSeF** (token, sesja, wysyłka, UPO, numer KSeF) — 2026-06-13 |
| Pełen łańcuch webhook→KSeF test | ✅ podpisany webhook → serwer → realny numer KSeF |

Auth na środowisku testowym: certyfikat **personal** (self-signed) z `serialNumber=TINPL-<NIP>` → wygenerowanie tokenu KSeF (`KSEF_AUTH_MODE=token`). Pozostało: podpięcie realnego sandboxa Stripe (`stripe listen`) zamiast ręcznie podpisywanych webhooków.

## Konfiguracja

Sekrety przez 1Password (`op`), nie na dysku. Skopiuj `.env.example` → `.env`, uzupełnij, uruchamiaj:

```bash
op run --env-file=.env -- npm run dev
```

Kluczowe zmienne — patrz `.env.example`. Najważniejsze:
- `STRIPE_WEBHOOK_SECRET` — `whsec_...` (z `stripe listen` lokalnie albo z panelu Stripe).
- `STRIPE_API_KEY` — restricted key. **Dla `invoice.paid` musi mieć `customer read`** (`rak_customer_read`) — dociągamy NIP/adres z Customera.
- `KSEF_ENV` = `test|demo|prod`, `KSEF_AUTH_MODE` = `token|certificate`, `KSEF_TOKEN` lub `KSEF_CERT_PATH`+`KSEF_CERT_PASSWORD`.
- `KSEF_DRY_RUN=true` — testy bez wysyłki do KSeF.
- `SELLER_*` — dane sprzedawcy na fakturze.
- `INVOICE_NUMBER_SEED` — ostatni ręcznie wystawiony numer (z Saldeo), żeby numeracja `{nr}/{MM}/{YYYY}` kontynuowała bez kolizji.
- `NOTIFY_EMAIL` + `MAILERSEND_TOKEN` + `NOTIFY_FROM` — powiadomienia e-mail (MailerSend). Brak = bez maili.
- `BRIDGE_API_TOKEN` (CLI) i/lub `STRIPE_APP_SECRET` (panel) — autoryzacja zapisu `/config`.

## Faza 1 — test lokalny (bez kredencjałów KSeF)

```bash
# 1) instalacja
npm install

# 2) terminal A: forward webhooków (wymaga Stripe CLI: brew install stripe/stripe-cli/stripe)
stripe listen --events checkout.session.completed,invoice.paid \
  --forward-to localhost:3000/webhooks/stripe
#   → skopiuj wypisany whsec_... do .env (STRIPE_WEBHOOK_SECRET)

# 3) terminal B: serwer w dry-run
op run --env-file=.env -- npm run dev      # KSEF_DRY_RUN=true

# 4) terminal C: symulacja płatności
stripe trigger checkout.session.completed
stripe trigger invoice.paid

# 5) podgląd
npm run list
```

Oczekiwane: w `npm run list` faktury ze statusem `accepted` i numerami `{nr}/{MM}/{YYYY}`. Dwukrotne wywołanie tego samego eventu → jedna faktura (dedup).

> Test bez Stripe CLI: serwer i podpis można sprawdzić podpisując payload ręcznie (HMAC-SHA256 z `whsec`), tak jak w testach.

## Faza 2 — środowisko testowe/demo KSeF

Pozyskanie tokenu na **środowisku testowym** (self-signed cert dozwolony, NIP może być realny lub fikcyjny).
Dla auth na kontekst NIP używa się certyfikatu **personal** z `serialNumber=TINPL-<NIP>` (NIE company-seal):

```bash
# 1) self-signed cert personal (TINPL-<NIP> w polu serialNumber)
npx ksef cert generate --env test --type personal \
  --given-name A --surname R --serial-number "TINPL-<NIP>" --cn "A R" \
  --nip <NIP> --out ./secrets --force

# 2) logowanie na env test
npx ksef auth login --env test --cert ./secrets/cert.pem --key ./secrets/key.pem --nip <NIP>

# 3) token KSeF
npx ksef token generate --env test --permissions InvoiceWrite,InvoiceRead --description "stripe-ksef-bridge"
```

Token wklej do `.env` (`KSEF_TOKEN=...`), ustaw `KSEF_AUTH_MODE=token`, `KSEF_ENV=test`, `KSEF_DRY_RUN=false`, `SELLER_NIP=<NIP>` (= kontekst auth).

Weryfikacja realnej wysyłki (bez Stripe): zbuduj fakturę i wyślij do KSeF test — patrz historia w git / `scripts`. Potwierdzone: zwraca numer KSeF + UPO podpisane przez MF (TE).

Na **DEMO** (`api-demo`): realny NIP + realny token KSeF (ten sam mechanizm co w Saldeo, bez pieczęci kwalifikowanej).

## Faza 3 — produkcja

- `KSEF_ENV=prod`, `KSEF_DRY_RUN=false`, produkcyjny token/cert KSeF, live `STRIPE_API_KEY` (+ `customer read`).
- Webhook endpoint publiczny (HTTPS) w panelu Stripe → events `checkout.session.completed`, `invoice.paid`; `whsec_...` z panelu do `.env`.
- `INVOICE_NUMBER_SEED` = ostatni ręczny numer z Saldeo.
- Hosting: **Railway** (patrz niżej) — always-on, trwały wolumen, publiczny HTTPS.
- Księgowość: Saldeo przechodzi w tryb *import-only* (auto-pobieranie z KSeF) — do potwierdzenia z księgową.

### Deploy na Railway

Most działa bez zmian — ledger to plik libSQL na **wolumenie** (trwały), więc bez Turso/zewnętrznej bazy.

1. **Nowy projekt** z tego repo (Railway → Deploy from GitHub repo). Railway wykryje `Dockerfile` / `railway.json`.
2. **Wolumen**: dodaj Volume zamontowany w **`/data`** (Settings → Volumes). Tam ląduje plik bazy.
3. **Zmienne środowiskowe** (Variables) — odpowiedniki `.env`, bez `PORT` (Railway wstrzykuje swój):
   ```
   DATABASE_URL=file:/data/ksef-bridge.db
   KSEF_ENV=test|prod   KSEF_NIP=...   KSEF_AUTH_MODE=token   KSEF_TOKEN=...   KSEF_DRY_RUN=false
   STRIPE_API_KEY=...   STRIPE_WEBHOOK_SECRET=whsec_...   BRIDGE_API_TOKEN=...(opc.)
   SELLER_NIP=...  SELLER_NAME=...  SELLER_ADDRESS_COUNTRY=PL  SELLER_ADDRESS_LINE1=...
   SELLER_ADDRESS_POSTAL=...  SELLER_ADDRESS_CITY=...
   INVOICE_NUMBER_FORMAT={n}/{MM}/{YYYY}  INVOICE_NUMBER_SEED=<ostatni nr Saldeo>  INVOICE_NUMBER_SEED_YEAR=2026
   ```
4. **Domena**: Settings → Networking → Generate Domain → masz publiczny `https://<app>.up.railway.app`.
5. W Stripe (panel → Webhooks) dodaj endpoint `https://<app>.up.railway.app/webhooks/stripe`, eventy `checkout.session.completed` + `invoice.paid`; skopiuj `whsec_...` do zmiennej `STRIPE_WEBHOOK_SECRET`.
6. Health: `GET /health`. Healthcheck skonfigurowany w `railway.json`.

> Free tier Railway ma limit zużycia/kredytu — do produkcji always-on rozważ plan Hobby (~$5/mc). Service nie usypia (brak cold startów).

## Skrypty administracyjne

```bash
npm run list                       # podgląd faktur (read-only, tylko DATABASE_URL)
npm run list -- --status error     # tylko błędy
op run --env-file=.env -- npm run replay -- "9/06/2026"     # ponów wysyłkę (z zapisanego XML)
op run --env-file=.env -- npm run replay -- --all-failed
op run --env-file=.env -- npm run issue-manual -- cs_...    # ręczne wystawienie dla płatności bez webhooka
npm run fetch-schema               # aktualizacja XSD FA(3)
npm test                           # testy
npm run typecheck
```

## Ograniczenia MVP (świadome)

- Jedna stawka VAT na fakturę (23/8/5/0/`zw`). Faktury zagraniczne / odwrotne obciążenie nie są wystawiane automatycznie — bramka compliance kieruje je do ręcznego wystawienia (status `manual`).
- UPO zapisywane jako sparsowany JSON potwierdzenia (numer KSeF, skrót, daty), nie surowy XML.
- Wizualizacja faktury: używamy **oficjalnej z KSeF** — most generuje link weryfikacyjny MF (`/ksef/verify/:id`, też w metadata Stripe `ksef_verify_url`), pod którym MF renderuje fakturę i daje pobrać oficjalny PDF (Aplikacja Podatnika KSeF). Nie utrzymujemy własnego designu PDF.
- Przetwarzanie synchroniczne (1 instancja). Przy dużym wolumenie rozważyć kolejkę.

## Struktura

```
src/
  server.ts        Hono: POST /webhooks/stripe, GET /health
  webhook → process.ts   map → claim → build → validate → send → record
  stripe-map.ts    event Stripe → InvoiceInput
  vat.ts           arytmetyka VAT w groszach (half-up)
  numbering.ts     {nr}/{MM}/{YYYY}
  ledger.ts        libSQL (dedup + stan + numeracja; plik / Turso)
  fa3/build.ts     InvoiceInput → XML FA(3)
  fa3/validate.ts  walidacja wg XSD (libxml2-wasm)
  fa3/schema/      oficjalne XSD (FA(3) v1-0E + 3 importy etd)
  ksef/client.ts   DryRun + Live (ksef-client-ts)
  ksef/verify.ts   oficjalny link weryfikacyjny KSeF (numer KSeF → wizualizacja MF)
  server.ts        + GET /ksef/status|verify|upo|xml/:objectId (dla panelu)
  stripe-writeback.ts  zapis ksef_* (numer, status, verify_url) na PaymentIncie/Invoice
scripts/           list, replay, issue-manual, fetch-schema
stripe-ksef-panel/ Stripe App (UI extension): panel KSeF na płatności/fakturze
test/              vat, fa3, pipeline
```

## Panel w Stripe (opcjonalny)

`stripe-ksef-panel/` to Stripe App (UI extension, scaffold `stripe apps create`) z widokiem `KsefStatus` na `payment.detail` i `invoice.detail`: status KSeF + numer + link „Otwórz/pobierz w KSeF" + UPO/XML, czytane z `/ksef/status/:id` (live polling dopóki wysyłka w toku; osobny badge dla faktur `manual`). Widok **settings** pozwala edytować konfigurację (numeracja, token KSeF, środowisko) wprost z dashboardu — zapis autoryzowany podpisem Stripe (`fetchStripeSignature`), weryfikowanym backendowo app-secretem (`STRIPE_APP_SECRET`), więc żaden sekret nie ląduje w bundlu panelu. Niezależnie od panelu, numer KSeF i tak jest widoczny w sekcji **Metadata** płatności.

**Zanim wgrasz panel** (`cd stripe-ksef-panel && stripe apps upload`) ustaw URL swojego mostu w **dwóch** miejscach (muszą być spójne, inaczej CSP zablokuje zapytania):
1. `stripe-ksef-panel/src/bridge.ts` → `BRIDGE_URL`
2. `stripe-ksef-panel/stripe-app.json` → `ui_extension.content_security_policy.connect-src` (oba wpisy `/ksef/` i `/config`)

> 🇬🇧 Before `stripe apps upload`, set your deployed bridge URL in both `src/bridge.ts` and `stripe-app.json` (connect-src).

## Disclaimer

Narzędzie niezależne, **niezwiązane z Ministerstwem Finansów ani Stripe**. „KSeF" i „Stripe" to znaki ich właścicieli. Używasz na własną odpowiedzialność — przed wystawianiem realnych faktur zweryfikuj poprawność na środowisku testowym/demo KSeF i skonsultuj z księgowością. / Independent tool, **not affiliated with the Polish Ministry of Finance or Stripe**. Use at your own risk; verify on the KSeF test/demo environment before issuing real invoices.

## Licencja / License

[MIT](LICENSE) © 2026 Czarek Michalski
