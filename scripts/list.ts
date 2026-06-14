/**
 * Podgląd wystawionych faktur z ledgera.
 *   npm run list            # ostatnie 50
 *   npm run list 200        # ostatnie 200
 *   npm run list -- --status error
 * Read-only: potrzebuje tylko DATABASE_URL (+ ewentualnie DATABASE_AUTH_TOKEN), bez sekretów.
 */
import { Ledger } from "../src/ledger.ts";
import type { InvoiceStatus } from "../src/types.ts";

const url = process.env["DATABASE_URL"] ?? "file:./data/ksef-bridge.db";
const ledger = await Ledger.open(url, process.env["DATABASE_AUTH_TOKEN"]);

const args = process.argv.slice(2);
const statusIdx = args.indexOf("--status");
const status = statusIdx >= 0 ? (args[statusIdx + 1] as InvoiceStatus) : undefined;
const limit = Number(args.find((a) => /^\d+$/.test(a)) ?? 50);

const rows = status ? await ledger.listByStatus(status, limit) : await ledger.list(limit);

if (rows.length === 0) {
  console.log("(brak faktur w ledgerze)");
} else {
  for (const r of rows) {
    const gross = (r.gross_grosze / 100).toFixed(2);
    console.log(
      [
        r.fv_number.padEnd(14),
        r.status.padEnd(9),
        `${gross} ${r.currency}`.padEnd(14),
        (r.buyer_nip ?? "—").padEnd(11),
        (r.ksef_number ?? "—").padEnd(36),
        r.created_at,
      ].join("  "),
    );
    if (r.error) console.log(`   ↳ ${r.error}`);
  }
  console.log(`\n${rows.length} pozycji${status ? ` (status=${status})` : ""}.`);
}
ledger.close();
