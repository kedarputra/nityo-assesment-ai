import { describe, expect, it } from "vitest";
import { DataPackError, parseCents, readEmails } from "./data-pack";

describe("parseCents", () => {
  it.each([
    ["68.0", 6800],
    ["48.60", 4860],
    ["35.1", 3510],
    ["20000", 2_000_000],
    ["0", 0],
  ])("reads %s dollars as %i cents", (dollars, cents) => {
    expect(parseCents(dollars)).toBe(cents);
  });

  it.each(["", "12.345", "-5", "1e3", "$10", " 10"])("refuses %j", (value) => {
    expect(() => parseCents(value)).toThrow(DataPackError);
  });
});

describe("readEmails", () => {
  const email = {
    email_id: "E999",
    received_at: "2026-11-02T07:02:00-05:00",
    from_name: "Test",
    from_email: "test@example.example",
    to: "orders@harborpointsupply.example",
    subject: "Hi",
    body: "  line one\n\nline two  ",
    attachments: [],
  };

  it("keeps the body exactly as written", () => {
    const [read] = readEmails(`${JSON.stringify(email)}\n`);

    expect(read?.body).toBe(email.body);
  });

  it("refuses an email with an attachment rather than drop it", () => {
    expect(() => readEmails(JSON.stringify({ ...email, attachments: ["po.pdf"] }))).toThrow(
      DataPackError,
    );
  });

  it("refuses a timestamp without an offset", () => {
    expect(() => readEmails(JSON.stringify({ ...email, received_at: "2026-11-02 07:02" }))).toThrow(
      DataPackError,
    );
  });
});
