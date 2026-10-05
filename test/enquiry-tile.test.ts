/**
 * The Cases page counts "an enquiry is waiting on us" from ONE query
 * (`Repo.enquiryApplicantIdsToday`) instead of one query per applicant. The
 * category list that drives it is organization vocabulary, so it has to stay
 * inside `EmailCategory`: it used to name `case_enquiry` (which no classifier,
 * rule or export produces) and omit `general_enquiry` (where ordinary
 * enquiries actually land) — so the tile read zero while mail sat in the queue.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Repo } from "../src/db/repo";
import { openDb } from "../src/db/db";
import { configureTestOrganization } from "./helpers";
import type { EmailCategory } from "../src/types";

/** The five categories that describe a question rather than a submission. */
const ENQUIRY: EmailCategory[] = ["general_enquiry", "fee_enquiry", "follow_up", "complaint", "other"];
/** The three that describe material arriving: never an enquiry. */
const SUBMISSION: EmailCategory[] = ["application", "document_submission", "missing_document"];

function repoWithMail(categories: EmailCategory[]): { repo: Repo; byCategory: Map<EmailCategory, number> } {
  const repo = new Repo(openDb(":memory:"));
  configureTestOrganization(repo);
  const byCategory = new Map<EmailCategory, number>();
  categories.forEach((category, index) => {
    const applicantId = repo.createCase({
      emailAddress: `enquiry-${index}@example.test`,
      threadId: `t-enquiry-${index}`,
      organizationId: 1,
      caseTypeCode: "SERVICE_REQUEST",
    }).id;
    byCategory.set(category, applicantId);
    repo.insertEmail({
      applicant_id: applicantId,
      message_id: `m-${index}`,
      thread_id: `t-enquiry-${index}`,
      direction: "in",
      from_addr: `enquiry-${index}@example.test`,
      to_addr: "intake@example.test",
      subject: `Mail for ${category}`,
      body: "Please advise.",
      category,
      auto: 0,
      at: new Date().toISOString(),
    });
  });
  return { repo, byCategory };
}

describe("today's enquiry set", () => {
  let repo: Repo;
  let byCategory: Map<EmailCategory, number>;

  beforeEach(() => {
    ({ repo, byCategory } = repoWithMail([...ENQUIRY, ...SUBMISSION]));
  });

  it("counts exactly the enquiry categories, today", () => {
    const found = repo.enquiryApplicantIdsToday(new Date(Date.now() - 60_000).toISOString());
    for (const category of ENQUIRY) expect(found.has(byCategory.get(category)!), category).toBe(true);
    for (const category of SUBMISSION) expect(found.has(byCategory.get(category)!), category).toBe(false);
    expect(found.size).toBe(ENQUIRY.length);
  });

  it("leaves mail from an earlier day out of the count", () => {
    const yesterday = repo.createCase({ emailAddress: "old@example.test", threadId: "t-old", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" }).id;
    repo.insertEmail({
      applicant_id: yesterday, message_id: "m-old", thread_id: "t-old", direction: "in",
      from_addr: "old@example.test", to_addr: "intake@example.test", subject: "Yesterday",
      body: "Please advise.", category: "general_enquiry", auto: 0,
      at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
    });
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    expect(repo.enquiryApplicantIdsToday(startOfToday.toISOString()).has(yesterday)).toBe(false);
  });

  it("never treats our own outgoing reply as an enquiry at us", () => {
    const outbound = repo.createCase({ emailAddress: "out@example.test", threadId: "t-out", organizationId: 1, caseTypeCode: "SERVICE_REQUEST" }).id;
    repo.insertEmail({
      applicant_id: outbound, message_id: "m-out", thread_id: "t-out", direction: "out",
      from_addr: "desk@example.test", to_addr: "out@example.test", subject: "Our reply",
      body: "Here you are.", category: "general_enquiry", auto: 1, at: new Date().toISOString(),
    });
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    expect(repo.enquiryApplicantIdsToday(startOfToday.toISOString()).has(outbound)).toBe(false);
  });

  it("respects the staff member's case-type scope", () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const scoped = repo.enquiryApplicantIdsToday(startOfToday.toISOString(), ["VENDOR_INTAKE"]);
    expect(scoped.size).toBe(0);
    expect(repo.enquiryApplicantIdsToday(startOfToday.toISOString(), null).size).toBe(ENQUIRY.length);
  });
});
