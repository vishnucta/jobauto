import { describe, expect, it } from "vitest";

import { todaysThree } from "./today";

const match = (id: string, score: number) => ({ id, title: `Analyst ${id}`, company: "Bank", score, url: "", jobId: null });

describe("todaysThree", () => {
  it("puts her own drafts first, then the agent's drafts to review, then the best matches", () => {
    const items = todaysThree({
      drafts: [{ id: "d1", title: "Analyst", company: "Ledgerly" }],
      reviews: [{ applicationId: "r1", title: "Reporting", company: "Berenberg", score: 82 }],
      matches: [match("m1", 74), match("m2", 91)],
    });
    expect(items.map((item) => item.kind)).toEqual(["finish", "review", "prepare"]);
    expect(items[2]).toMatchObject({ candidateId: "m2", score: 91 });
  });

  it("never lists more than three, and nothing when nothing waits", () => {
    expect(todaysThree({ drafts: [], reviews: [], matches: [match("a", 70), match("b", 80), match("c", 90), match("d", 85)] }).map((item) => item.kind === "prepare" && item.candidateId)).toEqual(["c", "d", "b"]);
    expect(todaysThree({ drafts: [], reviews: [], matches: [] })).toEqual([]);
  });
});
