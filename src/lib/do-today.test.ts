import { describe, expect, it } from "vitest";

import type { NeedsYouItem } from "./dashboard";
import { doToday, doTodaySummary, type DoTodayRow } from "./do-today";
import type { TodayItem } from "./today";

const needs = (id: string, status: NeedsYouItem["status"], soon: boolean, extra: Partial<NeedsYouItem> = {}): NeedsYouItem => ({
  id,
  company: `Company ${id}`,
  role: "Analyst",
  status,
  reason: status === "DRAFT" ? "Still a draft. Ready when you are." : "Interview.",
  due: soon ? "tomorrow, 10:00" : null,
  soon,
  action: status === "DRAFT" ? "Finish draft" : status === "OFFER" ? "Review offer" : "Prepare",
  ...extra,
});
const coverage = { hit: 5, total: 6, mustMissing: 0 };
const finish = (id: string): TodayItem => ({ kind: "finish", applicationId: id, title: "Analyst", company: `Company ${id}` });
const review = (id: string): TodayItem => ({ kind: "review", applicationId: id, title: "Reporting", company: "Berenberg", coverage });
const prepare = (id: string): TodayItem => ({ kind: "prepare", candidateId: id, title: "Middle Office", company: "Warburg", coverage, url: "", jobId: null });
const ids = (rows: DoTodayRow[]) => rows.map((row) => (row.kind === "needs" ? row.item.id : row.item.kind === "prepare" ? row.item.candidateId : row.item.applicationId));

describe("doToday (jobauto fork)", () => {
  it("lists her draft once, where Today's three puts it, not again among Needs you", () => {
    // The audit's case: the same draft in both cards.
    const rows = doToday([needs("quaan", "DRAFT", false)], [finish("quaan")]);
    expect(rows).toEqual([{ kind: "needs", item: needs("quaan", "DRAFT", false) }]);
  });

  it("puts what's due first, then undated offers and interviews, then Today's three, then her other drafts", () => {
    const rows = doToday(
      [needs("due", "INTERVIEW", true), needs("offer", "OFFER", false), needs("old-draft", "DRAFT", false), needs("new-draft", "DRAFT", false)],
      [finish("new-draft"), review("agent-draft"), prepare("match")],
    );
    expect(ids(rows)).toEqual(["due", "offer", "new-draft", "agent-draft", "match", "old-draft"]);
    expect(rows.map((row) => row.kind)).toEqual(["needs", "needs", "needs", "agent", "agent", "needs"]);
  });

  it("keeps a draft that's due this week where Needs you has it, once", () => {
    const rows = doToday([needs("deadline", "DRAFT", true, { due: "apply by Thu 1 Oct" })], [finish("deadline")]);
    expect(ids(rows)).toEqual(["deadline"]);
  });

  it("is empty when nothing waits", () => {
    expect(doToday([], [])).toEqual([]);
  });
});

describe("doTodaySummary (jobauto fork)", () => {
  it("counts the undated drafts as well as what's due, so it never contradicts the list", () => {
    expect(doTodaySummary(doToday([needs("quaan", "DRAFT", false)], [finish("quaan")]), { empty: false })).toBe("1 draft is waiting for you.");
    expect(doTodaySummary(doToday([needs("a", "INTERVIEW", true), needs("b", "DRAFT", false)], [review("c")]), { empty: false })).toBe(
      "1 thing needs you this week, and 2 drafts are waiting.",
    );
    expect(doTodaySummary(doToday([needs("a", "INTERVIEW", true), needs("b", "SENT", true)], []), { empty: false })).toBe("2 things need you this week.");
  });

  it("says when nothing needs you, and encourages before the first application", () => {
    expect(doTodaySummary([], { empty: false })).toBe("Nothing needs you this week.");
    expect(doTodaySummary(doToday([needs("offer", "OFFER", false)], [prepare("m")]), { empty: false })).toBe("Nothing is due this week.");
    expect(doTodaySummary([], { empty: true })).toBe("Your first application is only a paste away.");
  });
});
