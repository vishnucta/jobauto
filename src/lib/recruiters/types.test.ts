import { describe, expect, it } from "vitest";

import { RecruiterStatus } from "@/generated/prisma/enums";

import {
  agencyOf,
  followUpDue,
  gmailLink,
  matchesFilter,
  nextStep,
  outreachDraft,
  RECRUITER_STATUSES,
  sameAgency,
  STARTER_RECRUITERS,
  statusMoves,
  type OutreachFacts,
  type RecruiterView,
} from "./types";

const NOW = new Date("2026-11-10T09:00:00.000Z");
const days = (count: number) => new Date(NOW.getTime() + count * 86_400_000).toISOString();

const recruiter = (patch: Partial<RecruiterView> = {}): RecruiterView => ({
  id: "r1",
  name: "Selby Jennings",
  contactName: "",
  email: "",
  website: "",
  speciality: "Financial services, incl. regulatory reporting",
  notes: "",
  source: "you",
  status: "NOT_CONTACTED",
  contactedAt: null,
  followUpAt: null,
  createdAt: days(-20),
  events: [],
  ...patch,
});

const facts: OutreachFacts = {
  name: "Prearna Janardhanan",
  headline: "Financial Analyst, regulatory reporting",
  city: "Hamburg",
  languages: [
    { name: "English", level: "Fluent (C2)" },
    { name: "German", level: "Elementary (A2)" },
  ],
};

describe("the statuses", () => {
  it("are the database's", () => {
    expect([...RECRUITER_STATUSES].sort()).toEqual(Object.values(RecruiterStatus).sort());
  });

  it("offer each status its moves, ending a stalled conversation or starting one again", () => {
    expect(statusMoves("NOT_CONTACTED").map((move) => move.to)).toEqual(["CONTACTED", "NOT_INTERESTED"]);
    expect(statusMoves("CONTACTED").map((move) => move.label)).toEqual(["They replied", "I followed up", "Not interested"]);
    expect(statusMoves("REPLIED").map((move) => move.to)).toEqual(["CONTACTED", "NOT_INTERESTED"]);
    expect(statusMoves("NOT_INTERESTED")).toEqual([{ to: "NOT_CONTACTED", label: "Back to the list" }]);
  });
});

describe("follow-ups", () => {
  it("are due only when waiting for an answer and the day has come", () => {
    expect(followUpDue(recruiter({ status: "CONTACTED", followUpAt: days(-1) }), NOW)).toBe(true);
    expect(followUpDue(recruiter({ status: "CONTACTED", followUpAt: days(0) }), NOW)).toBe(true);
    expect(followUpDue(recruiter({ status: "CONTACTED", followUpAt: days(2) }), NOW)).toBe(false);
    expect(followUpDue(recruiter({ status: "CONTACTED", followUpAt: null }), NOW)).toBe(false);
    // A reply, or no interest, ends the reminder whatever the date says.
    expect(followUpDue(recruiter({ status: "REPLIED", followUpAt: days(-5) }), NOW)).toBe(false);
    expect(followUpDue(recruiter({ status: "NOT_INTERESTED", followUpAt: days(-5) }), NOW)).toBe(false);
  });

  it("filter the list", () => {
    const due = recruiter({ status: "CONTACTED", followUpAt: days(-1) });
    const waiting = recruiter({ status: "CONTACTED", followUpAt: days(3) });
    const replied = recruiter({ status: "REPLIED" });
    const fresh = recruiter();
    const pick = (filter: Parameters<typeof matchesFilter>[1]) => [due, waiting, replied, fresh].filter((entry) => matchesFilter(entry, filter, NOW));
    expect(pick("ALL")).toHaveLength(4);
    expect(pick("TO_CONTACT")).toEqual([fresh]);
    expect(pick("WAITING")).toEqual([due, waiting]);
    expect(pick("REPLIED")).toEqual([replied]);
    expect(pick("DUE")).toEqual([due]);
  });

  it("say what happens next", () => {
    expect(nextStep(recruiter(), NOW)).toBe("Not contacted yet");
    expect(nextStep(recruiter({ status: "CONTACTED", contactedAt: days(-9), followUpAt: days(-2) }), NOW)).toBe("Contacted 9 days ago · follow-up due");
    expect(nextStep(recruiter({ status: "CONTACTED", contactedAt: days(-4), followUpAt: days(3) }), NOW)).toBe("Contacted 4 days ago · follow up in 3 days");
    expect(nextStep(recruiter({ status: "CONTACTED", contactedAt: days(-6), followUpAt: days(1) }), NOW)).toBe("Contacted 6 days ago · follow up in 1 day");
    expect(nextStep(recruiter({ status: "CONTACTED", contactedAt: NOW.toISOString(), followUpAt: days(7) }), NOW)).toBe("Contacted today · follow up in 7 days");
    expect(nextStep(recruiter({ status: "REPLIED", contactedAt: days(-2) }), NOW)).toBe("Replied · you wrote 2 days ago");
    expect(nextStep(recruiter({ status: "NOT_INTERESTED" }), NOW)).toBe("Not interested");
  });
});

describe("telling an agency from an employer", () => {
  it("knows the staffing firms by name, in any spelling of the company", () => {
    expect(agencyOf("Selby Jennings")).toEqual({ name: "Selby Jennings", key: "selby jennings" });
    expect(agencyOf("SELBY JENNINGS (Phaidon)")).toMatchObject({ name: "Selby Jennings" });
    expect(agencyOf("Michael Page International (Germany) GmbH")).toMatchObject({ name: "Michael Page" });
    expect(agencyOf("Robert Walters")).toMatchObject({ name: "Robert Walters" });
    expect(agencyOf("Hays AG")).toMatchObject({ name: "Hays" });
    expect(agencyOf("Randstad Professionals")).toMatchObject({ name: "Randstad" });
    expect(agencyOf("Teil von Phaidon International")).toMatchObject({ name: "Phaidon International" });
  });

  it("takes a company whose own name says it recruits, with its name as written", () => {
    expect(agencyOf("Nord Personalberatung GmbH")).toEqual({ name: "Nord Personalberatung GmbH", key: "nord personalberatung gmbh" });
    expect(agencyOf("Acme  Recruitment")).toMatchObject({ name: "Acme Recruitment" });
    expect(agencyOf("Fischer Executive Search")).not.toBeNull();
    expect(agencyOf("Hamburg Staffing Partners")).not.toBeNull();
  });

  it("leaves employers alone, including ones with a similar word or name", () => {
    for (const company of ["Fielmann AG", "Hamburg Commercial Bank", "Nexperia Germany GmbH", "Hayes Logistics", "Pageant Software", "Walters Brewing", "Kelly Design Studio", "Recruitee B.V.", ""]) {
      expect(agencyOf(company), company).toBeNull();
    }
  });

  it("says when two names are one agency", () => {
    expect(sameAgency("Hays", "Hays Germany")).toBe(true);
    expect(sameAgency("ROBERT WALTERS", "Robert Walters")).toBe(true);
    expect(sameAgency("Hays", "Hayes")).toBe(false);
    expect(sameAgency("Robert Half", "Robert Walters")).toBe(false);
    expect(sameAgency("", "Hays")).toBe(false);
  });
});

describe("the starter list", () => {
  it("names each agency once, with the page its claim comes from, and never an address", () => {
    const names = STARTER_RECRUITERS.map((starter) => starter.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const starter of STARTER_RECRUITERS) {
      expect(starter.website).toMatch(/^https:\/\//);
      expect(starter).not.toHaveProperty("email");
      expect(`${starter.speciality} ${starter.notes}`).not.toMatch(/@/);
    }
  });
});

describe("the message to write", () => {
  it("introduces her, from the profile only, with the languages as the profile has them", () => {
    const { subject, body } = outreachDraft(recruiter({ contactName: "Alex Kuhn" }), "first", facts);
    expect(subject).toBe("Introduction: Financial Analyst, regulatory reporting");
    expect(body).toBe(
      [
        "Hello Alex Kuhn,",
        "I am Prearna Janardhanan, Financial Analyst, regulatory reporting, based in Hamburg. I am looking for my next role and saw that you place people in financial services, incl. regulatory reporting.",
        "My languages: English (Fluent (C2)), German (Elementary (A2)).",
        "My resume is attached. I would be glad to hear whether a short call fits.",
        "Kind regards,\nPrearna Janardhanan",
      ].join("\n\n"),
    );
  });

  it("leaves out what the profile doesn't have rather than making it up", () => {
    const { subject, body } = outreachDraft(recruiter({ speciality: "" }), "first", { name: "Jane Doe", headline: "", city: "", languages: [] });
    expect(subject).toBe("Introduction: Jane Doe");
    expect(body).toBe(["Hello,", "I am Jane Doe. I am looking for my next role.", "My resume is attached. I would be glad to hear whether a short call fits.", "Kind regards,\nJane Doe"].join("\n\n"));
    expect(body).not.toMatch(/undefined|null|years|experience/i);
  });

  it("follows up on the day she wrote, and keeps a long headline out of the subject", () => {
    const written = recruiter({ status: "CONTACTED", contactedAt: "2026-11-02T10:00:00.000Z" });
    const { subject, body } = outreachDraft(written, "follow-up", facts);
    expect(subject).toBe("Following up: Financial Analyst, regulatory reporting");
    expect(body).toContain("I wrote to you on 2 November about roles in financial services, incl. regulatory reporting and wanted to follow up.");
    expect(body).toContain("My resume is attached again.");
    const long = outreachDraft(recruiter(), "first", { ...facts, headline: "Financial Analyst — Regulatory Reporting (EMIR Refit, MiFIR, COREP) & Reconciliation, Transaction Reporting and more" });
    expect(long.subject.length).toBeLessThanOrEqual(90);
    expect(long.subject.endsWith("…")).toBe(true);
  });

  it("opens a Gmail window with the message in it, to the address when there is one", () => {
    const url = new URL(gmailLink("jobs@example.com", "Hi there", "Line one\nLine two"));
    expect(`${url.origin}${url.pathname}`).toBe("https://mail.google.com/mail/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: "cm", fs: "1", su: "Hi there", body: "Line one\nLine two", to: "jobs@example.com" });
    expect(new URL(gmailLink("  ", "S", "B")).searchParams.has("to")).toBe(false);
  });
});
