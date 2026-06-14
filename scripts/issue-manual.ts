/**
 * Ręczne wystawienie faktury dla płatności, która nie weszła webhookiem
 * (np. zapłata sprzed wdrożenia toola). Podajesz ID sesji Checkout lub faktury Stripe.
 *
 *   op run --env-file=.env -- npm run issue-manual -- cs_test_a1b2...
 *   op run --env-file=.env -- npm run issue-manual -- in_1Nxxxx
 *
 * Buduje pseudo-event Stripe i przepuszcza przez ten sam pipeline (z dedupem).
 */
import Stripe from "stripe";
import { loadConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import { createKsefClient } from "../src/ksef/client.ts";
import { processStripeEvent } from "../src/process.ts";

const id = process.argv[2];
if (!id) {
  console.error("Podaj ID sesji Checkout (cs_...) lub faktury (in_...)");
  process.exit(1);
}

const cfg = loadConfig();
const stripe = new Stripe(cfg.stripe.apiKey);
const ledger = await Ledger.open(cfg.database.url, cfg.database.authToken);
const ksef = createKsefClient(cfg);
const today = new Date().toISOString().slice(0, 10);

const isInvoice = id.startsWith("in_");
const object = isInvoice
  ? await stripe.invoices.retrieve(id)
  : await stripe.checkout.sessions.retrieve(id);

// Minimalny event zgodny z tym, czego oczekuje mapEventToDraft.
const event = {
  id: `manual_${id}`,
  type: isInvoice ? "invoice.paid" : "checkout.session.completed",
  data: { object },
} as unknown as Stripe.Event;

const res = await processStripeEvent(event, { stripe, ledger, ksef, cfg, today });
console.log(JSON.stringify(res, null, 2));
ledger.close();
