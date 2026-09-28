/**
 * `npm run seed:demo-org` — one-off, idempotent seed of the DEMO second
 * organization ("Aperture People Ops", prefix APO). Adds rows alongside
 * Organization #1 and never modifies Organization #1's data.
 */
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { seedDefaults } from "../db/seed";
import { DEMO_CASE_TYPES, seedDemoOrganization } from "../db/demoOrg";

const cfg = loadConfig();
const repo = new Repo(openDb(cfg.dbPath));
seedDefaults(repo, { live: cfg.mode === "live" });
const result = seedDemoOrganization(repo);
const org = repo.getOrganization(result.organizationId)!;
console.log(`seed:demo-org: ${result.created ? "created" : "already present"} — #${org.id} ${org.name} (prefix ${org.ref_prefix}) in ${cfg.dbPath}`);
for (const def of DEMO_CASE_TYPES) {
  const ct = repo.getCaseType(def.code, org.id)!;
  console.log(`  ${ct.code}: ${repo.listDocumentDefinitions(ct.id).length} document slots; rules: ${def.ruleSummary}`);
}
console.log("seed:demo-org: Organization #1 was not touched. Switch organizations from the sidebar switcher.");
