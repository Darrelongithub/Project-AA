/** Pure, organization-owned document matrices. An upload fills one exact slot. */
import type { DocType } from "../types";

export type Slottable = { document_type: DocType; required?: boolean; blocking?: boolean };
export interface FillResult { filled: DocType[]; missing: Slottable[]; leftover: DocType[] }
export interface CaseTypeDocumentDefinition { key: string; label: string; required: boolean; blocking: boolean; position?: number; axis?: string; values?: string[] }
export interface CaseTypeRequirement { key: string; label: string; required: boolean; blocking: boolean }
export interface OrganizationDocumentAxis { key: string; label: string; values: string[] }

export function documentRequirementsForCaseType(input: { caseType: { id: number; code: string; category?: string }; definitions: CaseTypeDocumentDefinition[] }): CaseTypeRequirement[] {
  return [...input.definitions].sort((left, right) => (left.position ?? 0) - (right.position ?? 0)).map((definition) => ({ key: definition.key, label: definition.label, required: definition.required, blocking: definition.blocking }));
}
export function documentRequirementsFromAxes(input: { axes: OrganizationDocumentAxis[]; selections?: Record<string, string>; definitions: CaseTypeDocumentDefinition[] }): CaseTypeRequirement[] {
  const selected = input.selections ?? {};
  for (const axis of input.axes) if (selected[axis.key] !== undefined && !axis.values.includes(selected[axis.key])) throw new Error(`Invalid selection for ${axis.key}`);
  const definitions = input.definitions.filter((definition) => !definition.axis || selected[definition.axis] === undefined || !definition.values?.length || definition.values.includes(selected[definition.axis]));
  return documentRequirementsForCaseType({ caseType: { id: 0, code: "generic" }, definitions });
}
export function fillSlots<T extends Slottable>(specs: T[], submitted: DocType[]): { filled: DocType[]; missing: T[]; leftover: DocType[] } {
  const pool = [...submitted];
  const filled: DocType[] = [];
  const missing: T[] = [];
  for (const spec of specs) {
    const index = pool.indexOf(spec.document_type);
    if (index >= 0) { pool.splice(index, 1); filled.push(spec.document_type); }
    else if ((spec.required ?? true) && (spec.blocking ?? true)) missing.push(spec);
  }
  return { filled, missing, leftover: pool };
}
