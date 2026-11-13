import { describe, expect, it } from "vitest";

import { JOB_SOURCES } from "@/lib/job-search/search";

import { JOB_CHOICES, JOB_KINDS } from "./job-choices";

describe("the setup guide's job sources (E21-3)", () => {
  it("offer a source for each kind of job but none, and only real sources", () => {
    for (const { value } of JOB_KINDS) expect(JOB_CHOICES.some((choice) => choice.kind === value), value).toBe(value !== "none");
    for (const choice of JOB_CHOICES) expect(JOB_SOURCES).toContain(choice.source);
  });

  it("link only to https pages", () => {
    for (const step of JOB_CHOICES.flatMap((choice) => choice.steps)) if (step.link) expect(step.link.href).toMatch(/^https:\/\//);
  });
});
