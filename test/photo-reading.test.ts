/**
 * Image extraction is OCR-first by design: local OCR avoids a model call when
 * it clears the document-type quality gate, while Gemini remains the fallback
 * for poor or unreadable scans.
 */
import { describe, expect, it, vi } from "vitest";
import { extractAttachment } from "../src/extraction/extract";
import type { Attachment } from "../src/types";

const OCR_TEXT = "REPUBLIC OF KENYA\nNATIONAL ID\nNAME: JOHN DOE\nID NUMBER: 12345678";

function photo(p: Partial<Attachment> = {}): Attachment {
  return {
    filename: "id-photo.jpg",
    mimeType: "image/jpeg",
    content: Buffer.from("fake-jpeg-bytes"),
    ...p,
  } as Attachment;
}

describe("image attachments", () => {
  it("uses good local OCR first and does not send the image to Gemini", async () => {
    const order: string[] = [];
    const vision = {
      extractDocument: vi.fn(async () => {
        order.push("gemini");
        return {
          document_type: "id",
          text: "GEMINI-READ: JOHN DOE 12345678",
          fields: { idNumber: "12345678" },
          confidence: "high" as const,
        };
      }),
    };
    const ocr = vi.fn(async () => {
      order.push("ocr");
      return OCR_TEXT;
    });

    const res = await extractAttachment(photo(), { vision, ocr });

    expect(order).toEqual(["ocr"]);
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(vision.extractDocument).not.toHaveBeenCalled();
    expect(res.method).toBe("ocr");
    expect(res.text).toBe(OCR_TEXT);
  });

  it("calls Gemini only after local OCR fails the quality gate", async () => {
    const order: string[] = [];
    const vision = {
      extractDocument: vi.fn(async () => {
        order.push("gemini");
        return {
          document_type: "id",
          text: "GEMINI-READ: REPUBLIC OF KENYA NATIONAL ID NAME: JOHN DOE ID NUMBER: 12345678",
          fields: { idNumber: "12345678" },
          confidence: "high" as const,
        };
      }),
    };
    const ocr = vi.fn(async () => {
      order.push("ocr");
      return "1111 llll ???";
    });

    const res = await extractAttachment(photo(), { vision, ocr });

    expect(order).toEqual(["ocr", "gemini"]);
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(vision.extractDocument).toHaveBeenCalledTimes(1);
    expect(res.method).toBe("gemini_vision");
    expect(res.text).toContain("GEMINI-READ");
  });

  it("reads with local OCR when no vision adapter is configured", async () => {
    const res = await extractAttachment(photo(), { ocr: async () => OCR_TEXT });
    expect(res.method).toBe("ocr");
    expect(res.text).toContain("NATIONAL ID");
  });
});
