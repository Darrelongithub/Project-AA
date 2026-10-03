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

  it("new request intent", () => {
    expect(categorizeEmail("Service request", "I would like to request a service from your team.", false)).toBe("application");
  });

  it("general service questions", () => {
    expect(categorizeEmail("Service enquiry", "When does the September window close for requests?", false)).toBe("general_enquiry");
  });

  it("an eligibility question with a screenshot remains an enquiry, not document receipt", () => {
    expect(categorizeEmail(
      "Inquiry regarding service request eligibility",
      "I am writing to inquire what you need before I submit my request. I have attached a screenshot of my previous statement for your reference.",
      true
    )).toBe("general_enquiry");
  });

  it("ordinary business mail is an enquiry, not 'other' (domain-free vocabulary)", () => {
    // A plainly-worded request that has nothing to do with enrolment.
    expect(categorizeEmail(
      "Quote request for a 5-tonne consignment",
      "Hello, I need a quote for moving machinery from Mombasa to Nairobi next week. Please advise.",
      false
    )).toBe("general_enquiry");
    expect(categorizeEmail("Booking", "Can I book an appointment for Tuesday?", false)).toBe("general_enquiry");
  });

  it("money questions are fee enquiries", () => {
    expect(categorizeEmail("Invoice 4417", "Your invoice is overdue and payment is required.", false)).toBe("fee_enquiry");
    expect(categorizeEmail("Pricing", "Send me your pricing for the delivery.", false)).toBe("fee_enquiry");
  });

  it("no lender or enrolment vocabulary is baked in", () => {
    // These two Kenyan education lenders used to be hardcoded fee signals.
    expect(categorizeEmail("HELB", "hesb helb", false)).toBe("other");
    expect(categorizeEmail("Prospectus", "matriculation prospectus", false)).not.toBe("fee_enquiry");
  });

  it("fallback → other", () => {
    expect(categorizeEmail("Hello", "Habari yako?", false)).toBe("other");
  });
});
