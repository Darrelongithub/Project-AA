import { describe, expect, it } from "vitest";
import { categorizeEmail, priorityForCategory } from "../src/categorize";

describe("email categorization (feature 26)", () => {
  it("attachments + document words → Document Submission", () => {
    expect(categorizeEmail("Documents", "Please find attached my certificates.", true)).toBe("document_submission");
  });

  it("complaints win even with attachments", () => {
    expect(categorizeEmail("Complaint", "This is unacceptable, I have been ignored. Docs attached.", true)).toBe("complaint");
    expect(priorityForCategory("complaint")).toBe("high");
  });

  it("fee keywords → Fee Enquiry", () => {
    expect(categorizeEmail("Fees", "How much is the tuition per semester?", false)).toBe("fee_enquiry");
  });

  it("'have you received my documents?' → Missing Document category", () => {
    expect(categorizeEmail("Follow up", "Have you received my documents? Please confirm receipt.", false)).toBe("missing_document");
  });

  it("follow-ups and reminders", () => {
    expect(categorizeEmail("Following up", "Just following up on my previous email, any update?", false)).toBe("follow_up");
  });

  it("new application intent", () => {
    expect(categorizeEmail("Application", "I would like to apply for the BCS programme.", false)).toBe("application");
  });

  it("general admissions questions", () => {
    expect(categorizeEmail("Admission enquiry", "When does the January intake close for admission?", false)).toBe("admission_enquiry");
  });

  it("fallback → other", () => {
    expect(categorizeEmail("Hello", "Habari yako?", false)).toBe("other");
  });
});
