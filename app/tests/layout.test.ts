import { describe, expect, it } from "vitest";
import { sizeFor } from "../src/core/layout";
import { mimeFromName } from "../src/core/files";

describe("window sizes", () => {
  it("switches to the rail below 1024 px and to the phone layout below 700 px", () => {
    expect(sizeFor(1440)).toBe("wide");
    expect(sizeFor(1024)).toBe("wide");
    expect(sizeFor(1023)).toBe("medium");
    expect(sizeFor(700)).toBe("medium");
    expect(sizeFor(699)).toBe("phone");
    expect(sizeFor(380)).toBe("phone");
  });
});

describe("files handed to Courier", () => {
  it("gets each attachment's type from its name", () => {
    expect(mimeFromName("Report.DOCX")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeFromName("scan.pdf")).toBe("application/pdf");
    expect(mimeFromName("photo.jpeg")).toBe("image/jpeg");
    expect(mimeFromName("no-extension")).toBe("application/octet-stream");
  });
});
