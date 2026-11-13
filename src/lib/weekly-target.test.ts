import { describe, expect, it } from "vitest";

import { weeklyProgress, weekStart, weekStatus } from "./weekly-target";

describe("weeklyProgress", () => {
  // Friday 13 November 2026, 10:00 in Berlin.
  const now = new Date("2026-11-13T09:00:00Z");
  const at = (iso: string) => new Date(iso);

  it("weeks start on Monday", () => {
    expect(weekStart("2026-11-13")).toBe("2026-11-09");
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
    expect(weekStart("2026-11-15")).toBe("2026-11-09");
  });

  it("counts this week in the user's time zone, with the days left and the last eight weeks", () => {
    const progress = weeklyProgress([at("2026-11-09T08:00:00Z"), at("2026-11-12T12:00:00Z"), at("2026-11-08T23:30:00Z")], 5, now, "Europe/Berlin");
    // 23:30 UTC on Sunday the 8th is already Monday in Berlin.
    expect(progress).toMatchObject({ target: 5, sent: 3, daysLeft: 3, streak: 0 });
    expect(progress.weeks).toHaveLength(8);
    expect(progress.weeks.at(-1)).toEqual({ start: "2026-11-09", sent: 3, met: false });
    expect(weekStatus(progress)).toBe("2 to go, 3 days left");
  });

  it("counts the weeks in a row that met the target, and this one once it's met", () => {
    const sent = [
      ...Array.from({ length: 3 }, () => at("2026-10-20T10:00:00Z")),
      ...Array.from({ length: 3 }, () => at("2026-10-27T10:00:00Z")),
      ...Array.from({ length: 3 }, () => at("2026-11-03T10:00:00Z")),
      at("2026-11-10T10:00:00Z"),
    ];
    expect(weeklyProgress(sent, 3, now, "UTC").streak).toBe(3);
    expect(weeklyProgress([...sent, at("2026-11-11T10:00:00Z"), at("2026-11-12T10:00:00Z")], 3, now, "UTC")).toMatchObject({ streak: 4, sent: 3 });
    expect(weeklyProgress(sent, 0, now, "UTC").streak).toBe(0);
  });

  it("says where the week stands", () => {
    expect(weekStatus({ target: 0, sent: 4, daysLeft: 2 })).toBe("");
    expect(weekStatus({ target: 5, sent: 4, daysLeft: 1 })).toBe("1 to go, today left");
    expect(weekStatus({ target: 5, sent: 5, daysLeft: 3 })).toBe("Done for this week");
    expect(weekStatus({ target: 5, sent: 7, daysLeft: 3 })).toBe("Done for this week, 2 over");
  });
});
