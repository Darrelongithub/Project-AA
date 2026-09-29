/**
 * /admissions/convert — turn legacy structured SystemBlocks into rule trees,
 * and map extraction-detected exam systems onto admission routes.
 * Pure functions; used by the seeder and tests.
 */
import type { RuleNode, SystemBlock } from "../types";
import { admissionsPreset } from "../presets/loader";

/** One SystemBlock → a flat list of root-level rule nodes (AND semantics). */
export function blockToNodes(block: SystemBlock): RuleNode[] {
  const nodes: RuleNode[] = [];
  let pos = 0;
  const cond = (field: RuleNode["field"], value: string, subject: string | null = null): RuleNode => ({
    kind: "condition", logic: undefined, field, subject, comparator: ">=", value, position: pos++,
  });

  if (block.overall) nodes.push(cond("mean_grade", block.overall));
  if (block.minCredits != null) nodes.push(cond("credits", String(block.minCredits)));
  if (block.minPrincipals != null) nodes.push(cond("principals", String(block.minPrincipals)));
  if (block.minSubsidiaries != null) nodes.push(cond("subsidiaries", String(block.minSubsidiaries)));
  if (block.minPoints != null) nodes.push(cond("points", String(block.minPoints)));
  if (block.minGpa != null) nodes.push(cond("gpa", String(block.minGpa)));
  if (block.minClass) nodes.push(cond("class", block.minClass));

  for (const s of block.subjects ?? []) {
    const alts = s.alts ?? [];
    if (alts.length > 0) {
      nodes.push({
        kind: "group",
        logic: "OR",
        position: pos++,
        children: [s.subject, ...alts].map((subj) => cond("subject", s.grade, subj)),
      });
    } else {
      nodes.push(cond("subject", s.grade, s.subject));
    }
  }
  return nodes;
}

/** Subject catalogues — admissions-preset data (same lists as shipped). */
export const NATIONAL_SECONDARY_SUBJECTS: string[] = admissionsPreset().subjects.nationalSecondary;

/** Generic catalogues for the international/tertiary routes. */
export const GENERIC_SUBJECTS: string[] = admissionsPreset().subjects.generic;

const GENERIC_SYSTEMS: string[] = admissionsPreset().subjects.genericSystems;

export const CATALOGUE_SEED: Array<{ system: string; name: string }> = [
  ...NATIONAL_SECONDARY_SUBJECTS.map((name) => ({ system: admissionsPreset().subjects.nationalSecondarySystem, name })),
  ...GENERIC_SYSTEMS.flatMap((system) =>
    GENERIC_SUBJECTS.map((name) => ({ system, name }))
  ),
];
