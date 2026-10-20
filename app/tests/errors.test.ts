import { describe, expect, it } from "vitest";
import { errorText, failureText } from "../src/ipc/api";

describe("error text on screen", () => {
  it("never shows a server's or a library's own words", () => {
    const raw = [
      "server: 400: Precondition check failed.",
      "network: error sending request for url (https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=1)",
      "database: no such column: x",
      "imap: Bad Response: NO [CANNOT] Mailbox doesn't exist",
      "smtp: permanent error (554): 5.7.1 rejected",
      "json: expected value at line 1 column 1",
      "io: No such file or directory (os error 2)",
      "not found: 18f00000000067",
    ];
    for (const e of raw) {
      const t = failureText("move the conversation to Trash", e);
      expect(t).toMatch(/^Couldn't move the conversation to Trash\. [A-Z].*\.$/);
      expect(t).not.toMatch(/\d{3}|precondition|request for url|column|os error|NO \[|5\.7\.1|18f0/i);
    }
  });

  it("says what kind of trouble it was", () => {
    expect(errorText("offline: connection refused")).toBe("You're offline.");
    expect(errorText("auth: invalid_grant")).toMatch(/sign in again/);
    expect(errorText("server: 400: Precondition check failed.")).toBe("The mail server didn't accept the request.");
  });

  it("keeps messages written for people", () => {
    expect(errorText("Only Trash and Spam can be emptied.")).toBe("Only Trash and Spam can be emptied.");
    expect(errorText(new Error("Gmail is busy right now. Courier will try again shortly."))).toBe("Gmail is busy right now. Courier will try again shortly.");
  });
});
