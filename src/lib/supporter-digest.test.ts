import { describe, expect, it } from "vitest";

import { digestDue, supporterDigest, type DigestApplication } from "./supporter-digest";

const now = new Date("2026-11-23T08:00:00Z"); // a Monday
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
const application = (overrides: Partial<DigestApplication>): DigestApplication => ({
  company: "Acme",
  role: "Data analyst",
  status: "SENT",
  sentAt: daysAgo(2),
  nextInterviewAt: null,
  lastChange: daysAgo(2),
  moves: [],
  ...overrides,
});
const options = { target: 5, quietDays: 14, now, timeZone: "Europe/Berlin" };

describe("supporterDigest", () => {
  it("counts the week against the target and asks for an evening to catch up", () => {
    const digest = supporterDigest([application({}), application({ company: "Beta", sentAt: daysAgo(10), lastChange: daysAgo(10) })], options);
    expect(digest.title).toBe("Her week: 1 sent, 0 moved on");
    expect(digest.message).toContain("Sent this week: 1 of 5.");
    expect(digest.message).toContain("No new answers that moved one on this week.");
    expect(digest.message).toContain("Open: 2 applications in progress.");
    expect(digest.message).toContain("How you can help: an evening together to send 4 more applications.");
  });

  it("puts an interview coming first, with its day, and asks to practise it", () => {
    const digest = supporterDigest(
      [application({ company: "Gamma", status: "INTERVIEW", nextInterviewAt: new Date("2026-11-25T09:00:00Z"), moves: [{ to: "INTERVIEW", at: daysAgo(3) }] })],
      options,
    );
    expect(digest.title).toBe("Her week: 1 interview coming");
    expect(digest.message).toContain("Moved on: Data analyst at Gamma.");
    expect(digest.message).toContain("Interview: Data analyst at Gamma, Wed 25 Nov, 10:00.");
    expect(digest.message).toContain("How you can help: practise the call for Data analyst at Gamma");
  });

  it("points at the quiet ones once the target is met", () => {
    const sent = Array.from({ length: 5 }, (_, index) => application({ company: `Firm ${index}` }));
    const quiet = application({ company: "Old", sentAt: daysAgo(20), lastChange: daysAgo(20) });
    const digest = supporterDigest([...sent, quiet], options);
    expect(digest.message).toContain("1 application has had no news for 14+ days: worth a follow-up.");
    expect(digest.message).toContain("How you can help: go through the quiet ones with her and send the follow-ups.");
  });
});

describe("digestDue", () => {
  const when = { weekday: 1, hour: 8, sentOn: null };
  it("is due on its weekday from its hour, in the time zone, once that day", () => {
    expect(digestDue(new Date("2026-11-23T07:00:00Z"), "Europe/Berlin", when)).toBe(true); // 08:00 in Berlin
    expect(digestDue(new Date("2026-11-23T06:30:00Z"), "Europe/Berlin", when)).toBe(false); // 07:30
    expect(digestDue(new Date("2026-11-24T09:00:00Z"), "Europe/Berlin", when)).toBe(false); // Tuesday
    expect(digestDue(new Date("2026-11-23T09:00:00Z"), "Europe/Berlin", { ...when, sentOn: "2026-11-23" })).toBe(false);
  });
});
