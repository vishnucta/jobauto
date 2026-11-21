import { describe, expect, it } from "vitest";

import { boardFor } from "./boards";
import { FIELD_EMPLOYERS } from "./field-employers";

describe("employers in her field", () => {
  it("has one entry per employer, each with an https careers page", () => {
    expect(new Set(FIELD_EMPLOYERS.map((employer) => employer.name)).size).toBe(FIELD_EMPLOYERS.length);
    for (const employer of FIELD_EMPLOYERS) expect(employer.careersUrl).toMatch(/^https:\/\//);
  });

  it("offers Follow only for a feed the careers check reads, not a page", () => {
    for (const employer of FIELD_EMPLOYERS.filter((entry) => entry.followUrl)) expect(boardFor(employer.followUrl!)?.kind).not.toBe("page");
  });
});
