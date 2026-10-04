/**
 * Small, deterministic text-template engine shared by previews and every send
 * path. Templates use `{token}` values and `{{> partial_name}}` includes.
 *
 * Partials are deliberately code-owned for now: persisted organization
 * templates may compose these stable building blocks, while the renderer also
 * accepts a caller-provided registry so a future persisted partial store does
 * not require another rendering rewrite.
 */

export const TEMPLATE_TOKEN_NAMES = [
  "ref",
  "name",
  "first_name",
  "missing_docs",
  "missing_docs_section",
  "checklist",
  "status",
  "institution",
  "case_type",
  "category",
  "read_back",
  "document_issues",
] as const;

export type TemplateTokenName = typeof TEMPLATE_TOKEN_NAMES[number];
export type TemplateValues = Readonly<Record<string, string>>;
export type TemplatePartials = Readonly<Record<string, string>>;

/** Reusable text fragments available to every organization template. */
export const DEFAULT_TEMPLATE_PARTIALS: TemplatePartials = Object.freeze({
  greeting: "Hello {first_name},",
  case_reference: "Case reference: {ref}",
  missing_information: "{missing_docs_section}",
  document_feedback: "{read_back}\n{document_issues}",
  organization_signature: "{institution}",
});

export const TEMPLATE_PARTIAL_DOCS: ReadonlyArray<readonly [string, string]> = [
  ["greeting", "Hello plus the contact's first name"],
  ["case_reference", "a labelled case reference"],
  ["missing_information", "the polite missing-information section"],
  ["document_feedback", "document receipt details and quality issues"],
  ["organization_signature", "the organization name"],
];

export class TemplatePartialError extends Error {
  readonly code = "TEMPLATE_PARTIAL_ERROR" as const;

  constructor(
    message: string,
    readonly partialName: string,
    readonly includeChain: readonly string[]
  ) {
    super(message);
    this.name = "TemplatePartialError";
  }
}

export interface TemplateInspection {
  tokens: string[];
  partials: string[];
  unknownTokens: string[];
  unknownPartials: string[];
  malformedIncludes: string[];
}

const TOKEN_RE = /\{([a-z][a-z0-9_]*)\}/g;
const INCLUDE_RE = /\{\{>\s*([^{}\r\n]*?)\s*\}\}/g;
const PARTIAL_NAME_RE = /^[a-z][a-z0-9_]*$/;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Inspect persisted text without rendering it (used by validation and UI). */
export function inspectTemplate(
  source: string,
  partials: TemplatePartials = DEFAULT_TEMPLATE_PARTIALS,
  knownTokens: readonly string[] = TEMPLATE_TOKEN_NAMES
): TemplateInspection {
  const included: string[] = [];
  const malformedIncludes: string[] = [];
  let match: RegExpExecArray | null;
  INCLUDE_RE.lastIndex = 0;
  while ((match = INCLUDE_RE.exec(source)) !== null) {
    const name = match[1].trim();
    if (PARTIAL_NAME_RE.test(name)) included.push(name);
    else malformedIncludes.push(match[0]);
  }

  // A dangling directive would not be matched by INCLUDE_RE at all.
  const withoutCompleteIncludes = source.replace(INCLUDE_RE, "");
  if (withoutCompleteIncludes.includes("{{>")) malformedIncludes.push("unterminated {{> ... }} include");

  // Remove includes before scanning tokens so braces belonging to the include
  // syntax can never be reported as value placeholders.
  const tokenNames = [...source.replace(INCLUDE_RE, "").matchAll(TOKEN_RE)].map((item) => item[1]);
  const tokens = unique(tokenNames);
  const partialNames = unique(included);
  const known = new Set(knownTokens);
  return {
    tokens,
    partials: partialNames,
    unknownTokens: tokens.filter((name) => !known.has(name)),
    unknownPartials: partialNames.filter((name) => partials[name] === undefined),
    malformedIncludes: unique(malformedIncludes),
  };
}

/**
 * Expand partials recursively, then replace known values. Unknown value tokens
 * intentionally remain literal so the existing editor can warn without
 * discarding an administrator's draft. Unknown/malformed partials throw: an
 * include is structural and must never silently disappear from outgoing mail.
 */
export function renderTpl(
  source: string,
  values: TemplateValues,
  partials: TemplatePartials = DEFAULT_TEMPLATE_PARTIALS
): string {
  const expand = (text: string, chain: readonly string[]): string => {
    INCLUDE_RE.lastIndex = 0;
    const expanded = text.replace(INCLUDE_RE, (directive, rawName: string) => {
      const name = rawName.trim();
      if (!PARTIAL_NAME_RE.test(name)) {
        throw new TemplatePartialError(`Malformed template partial include: ${directive}`, name, chain);
      }
      const partial = partials[name];
      if (partial === undefined) {
        throw new TemplatePartialError(`Unknown template partial '${name}'`, name, [...chain, name]);
      }
      if (chain.includes(name)) {
        const cycle = [...chain, name];
        throw new TemplatePartialError(`Template partial cycle: ${cycle.join(" -> ")}`, name, cycle);
      }
      if (chain.length >= 20) {
        throw new TemplatePartialError(`Template partial nesting exceeds 20 includes at '${name}'`, name, [...chain, name]);
      }
      return expand(partial, [...chain, name]);
    });

    // Catch dangling includes that the complete-directive regex cannot see.
    if (expanded.includes("{{>")) {
      throw new TemplatePartialError("Malformed or unterminated template partial include", "", chain);
    }
    return expanded;
  };

  const composed = expand(source, []);
  TOKEN_RE.lastIndex = 0;
  return composed.replace(TOKEN_RE, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : token
  );
}
