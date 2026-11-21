import { describe, expect, it } from "vitest";

import { EVENT_NAMES, EVENTS, eventOn, onlyEvent } from "./events";

describe("the events (E26-1)", () => {
  it("are on by default only for agent runs, the fork's alerts, withdrawn portals and documents written", () => {
    expect(EVENT_NAMES.filter((name) => EVENTS[name].on)).toEqual(["agent.run.finished", "matches.strong", "careers.new", "startups.licensed", "portal.withdrawn", "documents.written"]);
    expect(eventOn({}, "draft.ready")).toBe(false);
    expect(eventOn({ "draft.ready": true, "agent.run.finished": false }, "agent.run.finished")).toBe(false);
  });

  it("build an agent run's message: what's new for each search with its best posting, then the failed portals", () => {
    const data = {
      newCount: 15,
      searches: [
        { name: "Backend, Berlin", newCount: 9, best: { title: "Backend Engineer", company: "Zalando", coverage: { hit: 5, total: 6 }, profile: "Backend" } },
        { name: "Remote frontend", newCount: 6, best: { title: "Frontend Developer", company: "Doist", coverage: null, profile: "Frontend" } },
      ],
      failed: [
        { portal: "JSearch", why: "out of searches" },
        { portal: "Jobicy", why: "no answer" },
      ],
      postings: [],
      path: "/jobs?found=agent",
    };
    expect(EVENTS["agent.run.finished"].message(data)).toEqual({
      title: "Agent run finished · 15 new postings",
      text: [
        "Backend, Berlin: 9 new · best Backend Engineer at Zalando, covers 5 of 6 (Backend)",
        "Remote frontend: 6 new · best Frontend Developer at Doist (Frontend)",
        "2 portals failed: JSearch (out of searches), Jobicy (no answer)",
      ].join("\n"),
      path: "/jobs?found=agent",
    });
    expect(EVENTS["agent.run.finished"].hasNews!({ ...data, newCount: 0, failed: [] })).toBe(false);
  });

  it("say who replied about which application, never what the mail says", () => {
    expect(EVENTS["reply.arrived"].message({ applicationId: "a1", from: "Jane at Ledgerly", title: "Senior Product Designer", company: "Ledgerly" })).toEqual({
      title: "A reply from Jane at Ledgerly",
      text: "About Senior Product Designer at Ledgerly.",
      path: "/applications/a1?tab=email",
    });
  });

  it("say which documents New application wrote, never what they say (E31-4)", () => {
    expect(EVENTS["documents.written"].message({ applicationId: "a1", title: "Senior Product Designer", company: "Ledgerly", resume: true, letter: true })).toEqual({
      title: "Your resume and cover letter are ready",
      text: "For Senior Product Designer at Ledgerly. Nothing is sent until you say so.",
      path: "/applications/a1",
    });
    expect(EVENTS["documents.written"].message({ applicationId: "a1", title: "Designer", company: "", resume: true, letter: false }).title).toBe("Your resume is ready");
  });

  it("say which new postings are strong matches, best first, five at most (jobauto fork)", () => {
    const posting = (title: string) => ({ title, company: "Acme", coverage: { hit: 5, total: 6 }, profile: "" });
    expect(EVENTS["matches.strong"].message({ postings: [posting("Regulatory Reporting Analyst")], path: "/jobs?found=agent" })).toEqual({
      title: "A strong new match",
      text: "Regulatory Reporting Analyst at Acme, covers 5 of 6",
      path: "/jobs?found=agent",
    });
    const many = EVENTS["matches.strong"].message({ postings: ["A", "B", "C", "D", "E", "F", "G"].map(posting), path: "/agent" });
    expect(many.title).toBe("7 strong new matches");
    expect(many.text.split("\n")).toEqual(["A at Acme, covers 5 of 6", "B at Acme, covers 5 of 6", "C at Acme, covers 5 of 6", "D at Acme, covers 5 of 6", "E at Acme, covers 5 of 6", "and 2 more"]);
    expect(EVENTS["matches.strong"].hasNews!({ postings: [], path: "/agent" })).toBe(false);
  });

  it("name new jobs on careers pages and newly licensed firms (jobauto fork)", () => {
    expect(
      EVENTS["careers.new"].message({
        postings: [
          { title: "Regulatory Reporting Analyst", company: "Acme" },
          { title: "Spezialist Meldewesen", company: "Acme" },
        ],
        path: "/jobs?found=s1",
      }),
    ).toEqual({ title: "2 new jobs on careers pages you follow", text: "Regulatory Reporting Analyst, Acme\nSpezialist Meldewesen, Acme", path: "/jobs?found=s1" });
    expect(EVENTS["startups.licensed"].message({ firms: [{ company: "Nordlicht Markets GmbH", place: "Frankfurt am Main" }] })).toEqual({
      title: "A newly licensed firm in Germany",
      text: "Nordlicht Markets GmbH, Frankfurt am Main",
      path: "/startups?source=licence",
    });
  });
});

describe("the supporter digest as an event (jobauto fork)", () => {
  it("is off for her own channels, and its message is the digest as written", () => {
    expect(eventOn({}, "supporter.digest")).toBe(false);
    expect(EVENTS["supporter.digest"].message({ title: "Her week: 2 sent, 0 moved on", message: "Sent this week: 2 of 5." })).toEqual({
      title: "Her week: 2 sent, 0 moved on",
      text: "Sent this week: 2 of 5.",
      path: "/",
    });
  });

  it("gives the supporter's channel the digest and nothing else, not even events on by default", () => {
    const events = onlyEvent("supporter.digest");
    expect(EVENT_NAMES.filter((name) => eventOn(events, name))).toEqual(["supporter.digest"]);
  });
});
