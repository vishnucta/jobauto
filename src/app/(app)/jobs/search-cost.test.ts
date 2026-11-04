import { describe, expect, it } from "vitest";

import { searchCost } from "./search-fields";

describe("searchCost", () => {
  it("counts Jooble's searches, which are 500 in all, as the plan's like JSearch's month", () => {
    expect(searchCost(["JOOBLE"])).toBe("Uses 1 search from Jooble");
    expect(searchCost(["JSEARCH", "JOOBLE"])).toBe("Uses 1 search each from JSearch and Jooble");
  });

  it("says nothing is used by a source without a quota", () => {
    expect(searchCost(["ARBEITSAGENTUR"])).toBe("No search quota used");
    expect(searchCost([])).toBe("");
  });
});
