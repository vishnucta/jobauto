import { describe, expect, it } from "vitest";

import { readByCareersPages } from "./catalog";

describe("the catalog's company job boards (jobauto fork)", () => {
  it("are left to Careers pages: Greenhouse, Lever and Ashby, by id or name", () => {
    expect(readByCareersPages({ id: "GREENHOUSE", name: "Greenhouse job boards" })).toBe(true);
    expect(readByCareersPages({ id: "lever", name: "Lever" })).toBe(true);
    expect(readByCareersPages({ id: "ASHBY_BOARDS", name: "Ashby" })).toBe(true);
    expect(readByCareersPages({ id: "ACME", name: "Ashby job boards" })).toBe(true);
  });

  it("leave every other portal in Browse portals", () => {
    expect(readByCareersPages({ id: "REMOTIVE", name: "Remotive" })).toBe(false);
    expect(readByCareersPages({ id: "LEVERAGED", name: "Leveraged Jobs" })).toBe(false);
  });
});
