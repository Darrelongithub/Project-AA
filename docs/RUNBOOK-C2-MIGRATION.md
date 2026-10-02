# RUNBOOK — C2 storage migration (`programme` → `case_type_code`, tenant-scoped `intakes`)

**Read this first.** I did **not** run this migration against any real, production or
tenant database. It was developed and verified only against synthetic copies and
fixtures inside this repository — `test/ppr-p07-migration.test.ts` builds a
production-shaped legacy database (old column names, school-scoped staff, frozen
snapshots, audit/decision logs, secrets in the settings bag, global submission
windows) and opens it exactly the way a boot does. Everything below is for **you**
to run on your real file, in this order, with a verified backup in hand.

## What changes when the database is opened

| Object | Before | After | How |
|---|---|---|---|
| `applicants.programme` | column holding the case-type **code** | renamed to `applicants.case_type_code` | declared rename in `migrations/legacy-storage.json` |
| `evaluations.programme` | column holding the case-type code | renamed to `evaluations.case_type_code` | same declared map |
| `intakes` | `name TEXT PRIMARY KEY` (global) | `PRIMARY KEY (organization_id, name)`, new `organization_id INTEGER NOT NULL DEFAULT 1` | column added, then the constraint rebuilt through the tested `rebuildConstraint` path (row ids, indexes, triggers and the AUTOINCREMENT high-water mark preserved) |

Values are **never reinterpreted**: a row that said `programme = 'LEGACY'` says
`case_type_code = 'LEGACY'`. Existing windows and their deadlines are preserved and
attributed to organization 1, which is where every window lived before. Nothing else
in this migration is new — the rest of the v2 migration (declared renames, missing
columns, indexes after columns, tenant stamping, secrets out of settings, the school
dimension dropped with school-scoped staff narrowed to *no* access, one-shot markers)
is unchanged and is covered by the same test.

The migration is **one transaction**. If any step fails, or if it would introduce a
single new foreign-key violation, `openDb` throws and the file is left exactly as it
was — pinned by the test *"a migration that fails half-way leaves the original
database intact"*.

## 0. Stop everything that writes

```bash
systemctl stop email-sorter      # or: pkill -f 'dist/src/cli/serve.js'
pgrep -af 'cli/(serve|ingest|queue|escalate|followups|retain)' || echo "no writers running"
```

Also stop cron/systemd timers for `ingest`, `queue`, `escalate`, `followups`, `retain`.
A migration that runs while another process writes is the one way to make this messy.

## 1. Back up, then VERIFY the backup

```bash
cd /path/to/Project-AA
DB=data/email-sorter.sqlite                      # <-- your real path
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
npm run backup                                   # SQLite online backup API -> backups/

# A plain file copy as well (the DB plus its WAL sidecars):
cp -v "$DB" "backups/pre-c2-$STAMP.sqlite"
[ -f "$DB-wal" ] && cp -v "$DB-wal" "backups/pre-c2-$STAMP.sqlite-wal"
[ -f "$DB-shm" ] && cp -v "$DB-shm" "backups/pre-c2-$STAMP.sqlite-shm"

# Verify the copy opens and matches the original row for row:
node - <<'JS'
const D = require("better-sqlite3");
const tables = ["applicants","emails","documents","audit_log","decision_logs","status_history",
                "outbox","evaluations","intakes","organizations","case_types","staff_users",
                "document_definitions","workflow_rules","organization_templates","templates","settings"];
const count = (file) => { const db = new D(file, { readonly: true });
  const out = {}; for (const t of tables) { try { out[t] = db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch { out[t] = "absent"; } }
  const version = db.pragma("user_version", { simple: true }); db.close(); return { out, version }; };
const a = count(process.argv[1]), b = count(process.argv[2]);
console.log("original user_version:", a.version, "| copy user_version:", b.version);
let same = true;
for (const t of tables) { if (a.out[t] !== b.out[t]) { same = false; console.log("MISMATCH", t, a.out[t], b.out[t]); } else console.log("ok", t, a.out[t]); }
if (!same) { console.error("BACKUP DOES NOT MATCH — do not continue"); process.exit(1); }
console.log("backup verified");
JS
```

(Replace the two file arguments with your real DB path and the copy path.)
**Do not continue unless this prints `backup verified`.**

## 2. Dry run — migrate the COPY, not the original

```bash
cp "backups/pre-c2-$STAMP.sqlite" /tmp/c2-dryrun.sqlite
DB_PATH=/tmp/c2-dryrun.sqlite npm run build
DB_PATH=/tmp/c2-dryrun.sqlite node dist/src/cli/serve.js   # Ctrl-C once it prints "listening"
```

Opening the database *is* the migration. Then verify the dry run:

```bash
node - <<'JS'
const D = require("better-sqlite3");
const db = new D("/tmp/c2-dryrun.sqlite", { readonly: true });
const cols = (t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
const sql = (t) => (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t) || {}).sql || "";
const checks = [
  ["applicants.case_type_code exists", cols("applicants").includes("case_type_code")],
  ["applicants.programme gone",        !cols("applicants").includes("programme")],
  ["evaluations.case_type_code exists",cols("evaluations").includes("case_type_code")],
  ["evaluations.programme gone",       !cols("evaluations").includes("programme")],
  ["intakes is tenant-scoped",         /PRIMARY KEY \(organization_id, name\)/.test(sql("intakes"))],
  ["intakes rows attributed to org 1", db.prepare("SELECT COUNT(*) n FROM intakes WHERE organization_id IS NULL").get().n === 0],
  ["user_version is 2",                db.pragma("user_version", { simple: true }) === 2],
  ["one-shot marker present",          !!db.prepare("SELECT 1 FROM settings WHERE key='generic_storage_v2'").get()],
  ["schools/staff_scopes dropped",     !sql("schools") && !sql("staff_scopes")],
  ["no NULL tenant on cases",          db.prepare("SELECT COUNT(*) n FROM applicants WHERE IFNULL(organization_id,0)=0").get().n === 0],
];
let bad = 0; for (const [name, ok] of checks) { console.log(ok ? "ok  " : "FAIL", name); if (!ok) bad++; }
console.log("\nrow counts:", JSON.stringify(["applicants","emails","documents","audit_log","decision_logs","status_history","outbox","evaluations","intakes"]
  .map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n])));
console.log("\nspot-check five cases (ref, code, outcome, legacy outcome):");
for (const r of db.prepare("SELECT ref_number, case_type_code, outcome, legacy_outcome, lifecycle FROM applicants ORDER BY id LIMIT 5").all()) console.log(" ", JSON.stringify(r));
console.log("\nsubmission windows kept their deadlines:");
for (const r of db.prepare("SELECT organization_id, name, deadline FROM intakes ORDER BY rowid").all()) console.log(" ", JSON.stringify(r));
process.exit(bad ? 1 : 0);
JS
```

Compare the row counts with the numbers you recorded in step 1 — **they must be
identical**. Compare the five spot-check rows against the same five rows in the
original (`SELECT ref_number, programme, outcome, legacy_outcome, lifecycle FROM
applicants ORDER BY id LIMIT 5`): every value must be the same, with `programme`
now spelled `case_type_code`.

If anything fails here, stop. The original is untouched; restore is not even needed.

## 3. Run it on the original

Only after step 2 is clean:

```bash
DB_PATH=data/email-sorter.sqlite node dist/src/cli/serve.js   # Ctrl-C once it prints "listening"
```

Then re-run the exact verification block from step 2 against the real path, and check
the console by hand:

- Overview and Queues load, counts look right;
- open one case: checklist, documents, email history, audit trail and evaluation
  history all render;
- Configuration → Requirements & repairs → **Submission windows** lists your windows
  with their deadlines, and saving a deadline sticks;
- a CSV export downloads and its `case_type` column still holds the codes;
- Mail search and the case-list case-type filter still filter.

## 4. Rollback (exact steps)

Rollback means restoring the pre-migration file **and** running the pre-C2 code,
because the new code reads `case_type_code` and the old file has `programme`.

```bash
systemctl stop email-sorter                       # stop writers first
cd /path/to/Project-AA
rm -f data/email-sorter.sqlite-wal data/email-sorter.sqlite-shm
cp -v "backups/pre-c2-$STAMP.sqlite" data/email-sorter.sqlite
git log --oneline -5                              # find the commit BEFORE the C2 commit
git checkout <pre-c2-commit>                      # detached HEAD is fine for a rollback
npm ci --ignore-scripts && npm run build
DB_PATH=data/email-sorter.sqlite node dist/src/cli/serve.js
```

Verify the rollback the same way: `PRAGMA table_info(applicants)` must contain
`programme` and not `case_type_code`, `intakes` must be `name TEXT PRIMARY KEY`, and
the row counts must match step 1. Then return to the current branch when the problem
is understood: `git checkout arena/01a0f754-project-aa`.

A rollback is never needed for a *failed* migration — a failed migration leaves the
file untouched (that behaviour is tested), so you simply fix the cause and open again.

## 5. If row counts differ after a successful migration

Stop, do not restart the service, restore from step 1, and keep both files. A count
change would mean the migration did something it must not; the test suite asserts it
does not, so treat any difference as a bug report with the two files attached.
