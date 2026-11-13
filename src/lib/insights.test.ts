import { describe, expect, it } from "vitest";

import { bestRow, insights, type SentApplication } from "./insights";

describe("insights", () => {
  const sent = (extra: Partial<SentApplication>): SentApplication => ({
    status: "SENT",
    furthestStage: "SENT",
    foundVia: "JSearch",
    agency: false,
    language: "English",
    theme: "",
    german: "fits",
    ...extra,
  });

  it("counts replies as moving on to Screening or further, rejections apart, by each grouping with two kinds or more", () => {
    const result = insights([
      sent({ furthestStage: "INTERVIEW", status: "INTERVIEW" }),
      sent({ status: "REJECTED" }),
      sent({ furthestStage: "SCREENING", status: "REJECTED", foundVia: "Careers pages" }),
      sent({ foundVia: "Careers pages", agency: true }),
    ]);
    expect(result).toMatchObject({ sent: 4, replies: 2, early: true });
    expect(result.groups.map((group) => group.id)).toEqual(["found", "agency"]);
    expect(result.groups[0].rows).toEqual([
      { label: "Careers pages", sent: 2, replies: 1, rejections: 0, rate: 50 },
      { label: "JSearch", sent: 2, replies: 1, rejections: 1, rate: 50 },
    ]);
  });

  it("names the kind with the best reply rate among those sent at least three times", () => {
    const result = insights([
      ...Array.from({ length: 4 }, (_, index) => sent({ language: "German", furthestStage: index < 2 ? "SCREENING" : "SENT" })),
      ...Array.from({ length: 3 }, () => sent({ language: "English" })),
      sent({ language: "French", furthestStage: "OFFER" }),
    ]);
    const language = result.groups.find((group) => group.id === "language")!;
    expect(bestRow(language)?.label).toBe("German");
  });
});
