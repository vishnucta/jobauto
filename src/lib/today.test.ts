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

  it("puts a match missing a must-have after one that covers as much without", () => {
    const missing = { ...match("m1", 8), coverage: { hit: 8, total: 10, mustMissing: 1 } };
    expect(todaysThree({ drafts: [], reviews: [], matches: [missing, match("m2", 8)] }).map((item) => item.kind === "prepare" && item.candidateId)).toEqual(["m2", "m1"]);
  });
});
