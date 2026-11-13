import { describe, expect, it } from "vitest";

import { browserAddressSchema } from "./browser-address";

const parse = (value: string) => browserAddressSchema.safeParse(value);
const problem = (value: string) => parse(value).error?.issues[0]?.message;

describe("browserAddressSchema", () => {
  it("takes a Tailscale IP address with its port, with or without http://, and saves it with http://", () => {
    expect(parse("100.101.102.103:9222").data).toBe("http://100.101.102.103:9222");
    expect(parse(" http://100.101.102.103:9222/ ").data).toBe("http://100.101.102.103:9222");
    expect(parse("localhost:9222").data).toBe("http://localhost:9222");
    expect(parse("http://[fd7a:115c:a1e0::1]:9222").data).toBe("http://[fd7a:115c:a1e0::1]:9222");
  });

  it("turns down a name, since Chrome doesn't answer one", () => {
    expect(problem("laptop.example-tailnet.ts.net:9222")).toMatch(/Tailscale IP address/);
  });

  it("needs the port and http://", () => {
    expect(problem("100.101.102.103")).toMatch(/port/);
    expect(problem("https://100.101.102.103:9222")).toMatch(/http:\/\//);
    expect(problem("ws://100.101.102.103:9222")).toMatch(/http:\/\//);
  });

  it("turns down an empty address or one that isn't an address", () => {
    expect(problem("  ")).toMatch(/Enter the address/);
    expect(problem("http://")).toMatch(/isn't an address/);
  });
});
