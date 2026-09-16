/**
 * `npm run queue` — the human work queue (feature 11) in the terminal.
 * For the full interface run `npm run serve` and open the dashboard.
 */
import { loadConfig } from "../config";
import { openDb } from "../db/db";
import { Repo } from "../db/repo";
import { LIFECYCLE_LABELS } from "../types";

function main(): void {
  const cfg = loadConfig();
  const repo = new Repo(openDb(cfg.dbPath));
  const rows = repo.queueView();

  if (rows.length === 0) {
    console.log("Human queue is empty. 🎉");
    return;
  }

  const urgent = rows.filter((r) => r.priority === "urgent").length;
  const high = rows.filter((r) => r.priority === "high").length;
  console.log(
    `\nHUMAN QUEUE — ${rows.length} case(s)${urgent ? ` — 🔴 ${urgent} urgent` : ""}${high ? ` — 🟠 ${high} high priority` : ""}\n`
  );

  for (const r of rows) {
    const overdue = r.sla_due_at && !r.sla_handled_at && r.sla_due_at < new Date().toISOString();
    console.log("──────────────────────────────────────────────────────────────────────────");
    console.log(`${r.ref_number}  ${r.full_name ?? ""}  <${r.email_address}>`);
    console.log(
      `Verdict: ${r.computed_status} · ${LIFECYCLE_LABELS[r.lifecycle]} · priority ${r.priority}${overdue ? " · ⚠️ OVERDUE" : ""}`
    );
    if (r.flag_summary) console.log(`Flags: ${r.flag_summary}`);
    console.log(`\nReasoning:\n${indent(r.reasoning)}`);
    const outbox = repo.latestOutbox(r.id);
    if (outbox) {
      console.log(`\nSuggested reply: ${outbox.subject}`);
      console.log(indent(outbox.body.split("\n").slice(0, 5).join("\n")) + "\n    …");
    }
    console.log("");
  }
}

function indent(s: string, pad = "    "): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

main();
