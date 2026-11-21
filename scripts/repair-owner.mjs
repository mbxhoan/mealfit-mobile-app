// Repairs delivery sessions and orders that earlier versions left inconsistent: sessions whose stops are all done but
// still "Đang giao", duplicate open sessions per shipper, and orders left "Đang giao hàng" by a closed session.
//
//   DATABASE_URL=... node scripts/repair-owner.mjs                  dry run for every shipper (writes nothing)
//   DATABASE_URL=... node scripts/repair-owner.mjs --owner hoan     dry run for one shipper
//   DATABASE_URL=... node scripts/repair-owner.mjs --apply          write the repairs
//
// Never point this at Production without explicit approval; run the dry run first and read the report.
import { getSql } from "../server-lib/db.mjs";
import { reconcileAccounts } from "../server-lib/commands.mjs";

const apply = process.argv.includes("--apply");
const ownerFlag = process.argv.indexOf("--owner");
const only = ownerFlag > 0 ? process.argv[ownerFlag + 1] : null;
if (!process.env.DATABASE_URL) { console.error("Set DATABASE_URL explicitly; this script does not read .env files."); process.exit(1); }

console.log(`${apply ? "APPLY" : "DRY RUN"} on database host ${new URL(process.env.DATABASE_URL).host}`);
const owners = only ? [only] : (await getSql()`SELECT id FROM mealfit_accounts WHERE role = 'shipper' ORDER BY id`).map(row => row.id);
const reports = await reconcileAccounts(owners, { dryRun: !apply });
for (const report of reports) {
  console.log(`\n${report.ownerId}: ${report.changed ? "needs repair" : "consistent"}`);
  for (const session of report.sessions) console.log(`  session ${session.id}: ${session.from} -> ${session.to}`);
  for (const order of report.orders) console.log(`  order ${order.code} -> ${order.to}`);
}
console.log(`\n${reports.filter(report => report.changed).length} of ${reports.length} accounts ${apply ? "repaired" : "would be repaired"}.`);
