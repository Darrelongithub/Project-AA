/** Pure, configured intake signal scorer. Unknown mail is retained, never silently dropped. */
export interface IntakeInput {
  subject: string;
  body: string;
  attachmentFilenames: string[];
  /** The tenant's own case-type names and codes — configured, never bundled. */
  caseTypeNames: string[];
  customHotwords: string[];
  knownContact: boolean;
}
export interface IntakeVerdict {
  category: "application" | "enquiry" | "parked";
  via: "known_contact" | "hotword" | "none";
  score: number;
  enquiryScore: number;
  penalty: number;
  positives: string[];
  negatives: string[];
}
function has(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}
export function classifyIntakeEmail(input: IntakeInput): IntakeVerdict {
  const corpus = `${input.subject}\n${input.body}`;
  const positives: string[] = [];
  const verdict: IntakeVerdict = { category: "parked", via: "none", score: 0, enquiryScore: /\?|\b(?:question|enquiry|inquiry|please advise)\b/i.test(corpus) ? 2 : 0, penalty: 0, positives, negatives: [] };
  if (input.knownContact) return { ...verdict, category: "application", via: "known_contact" };
  // No implicit industry vocabulary. Even invoices, job requests and complaints
  // may be valid intake in an organization that explicitly configures them.
  const configured = [...new Set([...input.customHotwords, ...input.caseTypeNames].map((word) => word.trim()).filter(Boolean))];
  for (const phrase of configured) if (has(corpus, phrase) || input.attachmentFilenames.some((filename) => has(filename.replace(/[_-]+/g, " "), phrase))) {
    positives.push(phrase);
    verdict.score += has(input.subject, phrase) ? 4 : 2;
  }
  if (positives.length) { verdict.category = verdict.enquiryScore ? "enquiry" : "application"; verdict.via = "hotword"; }
  return verdict;
}
