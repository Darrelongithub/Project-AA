/**
 * Photo reading (round 11) — "improve the OCR to even detect photos".
 *
 * Phone photos are exactly where a vision model beats Tesseract, so image
 * attachments now go to the live vision adapter FIRST when one is
 * configured; Tesseract stays the offline fallback (and the only path
 * without a key). Previously OCR ran first on every image, so a photo whose
 * OCR output looked plausible was used even though the vision model would
 * have read it correctly.
 */
import { describe, expect, it } from "vitest";
import { extractAttachment } from "../src/extraction/extract";
import { MockVisionAdapter } from "../src/extraction/gemini";
import type { Attachment } from "../src/types";

const OCR_TEXT = "REPUBLIC OF KENYA\nNATIONAL ID\nNAME: JOHN DOE\nID NUMBER: 12345678";

/** Controllable OCR stand-in (the real tesseract is irrelevant to ordering). */
const fakeOcr = async () => OCR_TEXT;

function photo(p: Partial<Attachment> = {}): Attachment {
  return {
    filename: "id-photo.jpg",
    mimeType: "image/jpeg",
    content: Buffer.from("fake-jpeg-bytes"),
    ...p,
  } as Attachment;
}

describe("image attachments", () => {
  it("a photo with a live vision adapter is read by the vision model first", async () => {
    const att = photo({
      mockVision: { document_type: "id", text: "VISION-READ: JOHN DOE 12345678", fields: { idNumber: "12345678" }, confidence: "high" },
    });
    const res = await extractAttachment(att, { vision: new MockVisionAdapter(), ocr: fakeOcr });
    expect(res.method).toBe("gemini_vision");
    expect(res.text).toContain("VISION-READ");
  });

  it("when the vision model finds nothing, Tesseract still reads the photo", async () => {
    const res = await extractAttachment(photo(), { vision: new MockVisionAdapter(), ocr: fakeOcr });
    expect(res.method).toBe("ocr");
    expect(res.text).toContain("JOHN DOE");
  });

  it("without any vision adapter the photo goes straight to OCR", async () => {
    const res = await extractAttachment(photo(), { ocr: fakeOcr });
    expect(res.method).toBe("ocr");
    expect(res.text).toContain("NATIONAL ID");
  });
});
