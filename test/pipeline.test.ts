import { afterAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type Stripe from "stripe";
import { Ledger } from "../src/ledger.ts";
import { DryRunKsefClient } from "../src/ksef/client.ts";
import { processStripeEvent } from "../src/process.ts";
import { effectiveConfig } from "../src/effective-config.ts";
import type { Config } from "../src/config.ts";

const cfg: Config = {
  port: 3000,
  stripe: { apiKey: "sk_test", webhookSecret: "whsec_test" },
  ksef: { env: "test", nip: "5260001246", authMode: "token", dryRun: true },
  seller: {
    nip: "5260001246",
    name: "ReceptionOS sp. z o.o.",
    country: "PL",
    addressL1: "ul. Przykładowa 1",
    addressL2: "00-001 Warszawa",
  },
  numbering: { format: "{n}/{MM}/{YYYY}", seed: 0, seedYear: 2026 },
  database: { url: "file::memory:?cache=shared" },
};

// Izolowany ledger per test: unikalny plik tymczasowy (libSQL local nie wspiera nazwanych :memory:).
let memSeq = 0;
const tmpDbs: string[] = [];
function openMem(): Promise<Ledger> {
  const path = `./data/.test-${process.pid}-${++memSeq}.db`;
  tmpDbs.push(path);
  return Ledger.open(`file:${path}`);
}
afterAll(() => {
  for (const p of tmpDbs) {
    for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
  }
});

// Fake Stripe — to, czego dotyka mapowanie checkout + write-back metadata.
const updates: Array<{ id: string; params: unknown }> = [];
const fakeStripe = {
  checkout: {
    sessions: {
      listLineItems: async () => ({ data: [{ description: "Opłata wdrożeniowa — Test" }] }),
    },
  },
  paymentIntents: {
    update: async (id: string, params: unknown) => {
      updates.push({ id, params });
      return {};
    },
  },
} as unknown as Stripe;

function checkoutEvent(id: string): Stripe.Event {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${id}`,
        payment_status: "paid",
        amount_total: 295200,
        currency: "pln",
        customer: "cus_1",
        payment_intent: `pi_${id}`,
        customer_details: {
          name: "Klinika Test Sp. z o.o.",
          email: "k@test.pl",
          address: {
            line1: "ul. Polna 1",
            line2: null,
            postal_code: "30-001",
            city: "Kraków",
            country: "PL",
            state: null,
          },
          tax_ids: [{ type: "eu_vat", value: "PL1111111111" }],
        },
        metadata: { netto_pln: "2400", vat_pct: "23", clinic_slug: "test" },
      },
    },
  } as unknown as Stripe.Event;
}

function foreignEvent(id: string): Stripe.Event {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_${id}`,
        payment_status: "paid",
        amount_total: 100000,
        currency: "gbp",
        customer: "cus_uk",
        payment_intent: `pi_${id}`,
        customer_details: {
          name: "Medissima Ltd",
          email: "k@medissima.co.uk",
          address: {
            line1: "1 High Street",
            line2: null,
            postal_code: "EC1A 1BB",
            city: "London",
            country: "GB",
            state: null,
          },
          tax_ids: [{ type: "gb_vat", value: "GB123456789" }],
        },
        metadata: { clinic_slug: "medissima" },
      },
    },
  } as unknown as Stripe.Event;
}

describe("pipeline (dry-run)", () => {
  it("wystawia fakturę i nadaje numer FV", async () => {
    const ledger = await openMem();
    const deps = { stripe: fakeStripe, ledger, ksef: new DryRunKsefClient(), cfg, today: "2026-06-13" };

    const res = await processStripeEvent(checkoutEvent("evt_1"), deps);
    expect(res.action).toBe("issued");
    expect(res.fvNumber).toBe("1/06/2026");
    expect(res.ksefNumber).toMatch(/^DRYRUN-/);

    const row = await ledger.getByNumber("1/06/2026");
    expect(row?.status).toBe("accepted");
    expect(row?.net_grosze).toBe(240000);
    expect(row?.vat_grosze).toBe(55200);
    expect(row?.gross_grosze).toBe(295200);
    expect(row?.buyer_nip).toBe("1111111111");
    expect(row?.stripe_object_id).toBe("pi_evt_1");

    // lookup po obiekcie (dla panelu UI extension)
    expect((await ledger.getByObjectId("pi_evt_1"))?.fv_number).toBe("1/06/2026");

    // write-back metadata KSeF na PaymentIntent
    const u = updates.find((x) => x.id === "pi_evt_1");
    expect(u).toBeTruthy();
    const md = (u!.params as { metadata: Record<string, string> }).metadata;
    expect(md.ksef_status).toBe("accepted");
    expect(md.ksef_number).toMatch(/^DRYRUN-/);
    expect(md.ksef_fv).toBe("1/06/2026");
    ledger.close();
  });

  it("compliance: GBP + nabywca z UK -> 'manual', bez numeru FV i bez wysyłki do KSeF", async () => {
    const ledger = await openMem();
    const deps = { stripe: fakeStripe, ledger, ksef: new DryRunKsefClient(), cfg, today: "2026-06-13" };

    const res = await processStripeEvent(foreignEvent("evt_uk"), deps);
    expect(res.action).toBe("manual");
    expect(res.fvNumber).toBeUndefined();
    expect(res.reason).toMatch(/GBP/);

    // Wpis 'manual' w ledgerze, nie zużył licznika (następna krajowa = 1/06/2026).
    const row = await ledger.getByObjectId("pi_evt_uk");
    expect(row?.status).toBe("manual");
    expect(await ledger.getCounter(2026)).toBeUndefined();

    // Drugi raz ten sam event = idempotentnie nadal 'manual', jeden wiersz.
    await processStripeEvent(foreignEvent("evt_uk"), deps);
    expect((await ledger.list()).length).toBe(1);
    ledger.close();
  });

  it("idempotencja: ten sam event nie wystawia 2. faktury", async () => {
    const ledger = await openMem();
    const deps = { stripe: fakeStripe, ledger, ksef: new DryRunKsefClient(), cfg, today: "2026-06-13" };

    await processStripeEvent(checkoutEvent("evt_1"), deps);
    const again = await processStripeEvent(checkoutEvent("evt_1"), deps);
    expect(again.action).toBe("duplicate");
    expect(again.fvNumber).toBe("1/06/2026");
    expect((await ledger.list()).length).toBe(1);
    ledger.close();
  });

  it("kolejny event dostaje kolejny numer", async () => {
    const ledger = await openMem();
    const deps = { stripe: fakeStripe, ledger, ksef: new DryRunKsefClient(), cfg, today: "2026-06-13" };

    const a = await processStripeEvent(checkoutEvent("evt_1"), deps);
    const b = await processStripeEvent(checkoutEvent("evt_2"), deps);
    expect(a.fvNumber).toBe("1/06/2026");
    expect(b.fvNumber).toBe("2/06/2026");
    ledger.close();
  });

  it("config nadpisuje numerację (seed + format)", async () => {
    const ledger = await openMem();
    await ledger.setConfig("invoice_format", "FV/{YYYY}/{n3}");
    await ledger.setConfig("invoice_seed", "41");
    await ledger.setConfig("invoice_seed_year", "2026");
    await ledger.setCounter(2026, 41); // start od 41 -> następna 42
    const eff = await effectiveConfig(cfg, ledger);
    const deps = { stripe: fakeStripe, ledger, ksef: new DryRunKsefClient(), cfg: eff, today: "2026-06-13" };

    const res = await processStripeEvent(checkoutEvent("evt_cfg"), deps);
    expect(res.fvNumber).toBe("FV/2026/042");
    ledger.close();
  });

  it("lookup po drugim kluczu (parytet płatność/faktura subskrypcji)", async () => {
    const ledger = await openMem();
    await ledger.claim(
      {
        issueDate: "2026-06-13",
        seller: cfg.seller,
        buyer: { nip: "1111111111", name: "X", country: "PL", addressL1: "a", addressL2: "b" },
        lines: [{ name: "x", qty: 1, unit: "usł.", netUnitGrosze: 100, netTotalGrosze: 100, vatRate: 23 }],
        currency: "PLN",
        netGrosze: 100,
        vatGrosze: 23,
        grossGrosze: 123,
        source: "subscription",
        stripeEventId: "evt_par",
        stripeObjectId: "in_x",
        stripeObjectId2: "pi_x",
        stripeObjectType: "invoice",
      },
      cfg.numbering,
    );
    expect((await ledger.getByObjectId("in_x"))?.stripe_event_id).toBe("evt_par");
    expect((await ledger.getByObjectId("pi_x"))?.stripe_event_id).toBe("evt_par");
    ledger.close();
  });
});
