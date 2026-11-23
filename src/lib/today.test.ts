import { describe, expect, it } from "vitest";

import { todaysThree } from "./today";

// Requirements covered out of 10, no must-have missing; found at `at`.
const covers = (hit: number) => ({ hit, total: 10, mustMissing: 0 });
const match = (id: string, hit: number, at = 0) => ({ id, title: `Analyst ${id}`, company: "Bank", coverage: covers(hit), at, url: "", jobId: null });

describe("todaysThree", () => {
  it("puts her own drafts first, then the agent's drafts to review, then the best matches", () => {
    const items = todaysThree({
      drafts: [{ id: "d1", title: "Analyst", company: "Ledgerly" }],
      reviews: [{ applicationId: "r1", title: "Reporting", company: "Berenberg", coverage: covers(8), at: 0 }],
      matches: [match("m1", 7), match("m2", 9)],
    });
    expect(items.map((item) => item.kind)).toEqual(["finish", "review", "prepare"]);
    expect(items[1]).toEqual({ kind: "review", applicationId: "r1", title: "Reporting", company: "Berenberg", coverage: covers(8) });
    expect(items[2]).toMatchObject({ candidateId: "m2", coverage: covers(9) });
  });

  it("never lists more than three, best fit first, and nothing when nothing waits", () => {
    expect(todaysThree({ drafts: [], reviews: [], matches: [match("a", 7), match("b", 8), match("c", 9), match("d", 8, 1)] }).map((item) => item.kind === "prepare" && item.candidateId)).toEqual(["c", "d", "b"]);
    expect(todaysThree({ drafts: [], reviews: [], matches: [] })).toEqual([]);
  });

  it("gives a free slot to a posting in her field ahead of the agent's general matches, in the order given (jobauto fork)", () => {
    const pick = (id: string, candidateId: string | null = null) => ({ postingId: id, candidateId, title: `Reporting ${id}`, company: "Northwind Clearing", coverage: { hit: 0, total: 0, mustMissing: 0 }, url: "", jobId: null, stale: id === "p2" });
    const items = todaysThree({ drafts: [{ id: "d1", title: "Analyst", company: "Ledgerly" }], reviews: [], matches: [match("m1", 9)], field: [pick("p1"), pick("p2")] });
    expect(items.map((item) => item.kind)).toEqual(["finish", "field", "field"]);
    expect(items[1]).toEqual({ kind: "field", postingId: "p1", title: "Reporting p1", company: "Northwind Clearing", coverage: { hit: 0, total: 0, mustMissing: 0 }, url: "", jobId: null, stale: false });
    expect(items[2]).toMatchObject({ postingId: "p2", stale: true });
    // Her drafts and the agent's still come first, and fill the three when there are enough.
    const full = todaysThree({ drafts: [{ id: "d1", title: "A", company: "" }, { id: "d2", title: "B", company: "" }], reviews: [{ applicationId: "r1", title: "C", company: "", coverage: covers(8), at: 0 }], matches: [], field: [pick("p1")] });
    expect(full.map((item) => item.kind)).toEqual(["finish", "finish", "review"]);
  });

  it("shows a match that is also in her field once, as the posting in her field", () => {
    const items = todaysThree({
      drafts: [],
      reviews: [],
      matches: [match("m1", 9), match("m2", 8)],
      field: [{ postingId: "p1", candidateId: "m1", title: "Reporting", company: "Northwind Clearing", coverage: covers(9), url: "", jobId: null, stale: false }],
    });
    expect(items.map((item) => (item.kind === "field" ? item.postingId : item.kind === "prepare" ? item.candidateId : ""))).toEqual(["p1", "m2"]);
  });

  it("puts a match missing a must-have after one that covers as much without", () => {
    const missing = { ...match("m1", 8), coverage: { hit: 8, total: 10, mustMissing: 1 } };
    expect(todaysThree({ drafts: [], reviews: [], matches: [missing, match("m2", 8)] }).map((item) => item.kind === "prepare" && item.candidateId)).toEqual(["m2", "m1"]);
  });
});
