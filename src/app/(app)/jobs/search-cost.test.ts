import { describe, expect, it } from "vitest";

import { searchCost } from "./search-fields";

describe("searchCost", () => {
  it("counts a search from each portal with a plan", () => {
    expect(searchCost(["SERPAPI"])).toBe("Uses 1 search from SerpApi");
    expect(searchCost(["JSEARCH", "SERPAPI", "ARBEITSAGENTUR"])).toBe("Uses 1 search each from JSearch and SerpApi");
  });

  it("says nothing is used by a source without a quota", () => {
    expect(searchCost(["ARBEITSAGENTUR"])).toBe("No search quota used");
    expect(searchCost([])).toBe("");
  });
});
