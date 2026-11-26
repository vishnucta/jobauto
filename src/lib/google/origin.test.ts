import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ DOSSIER_PUBLIC_URL: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env }));

import { connectorOrigin, lanOrigin, publicOrigin } from "./origin";

const PUBLIC = "https://dossier.example";

const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { host: new URL(url).host, ...headers } });

beforeEach(() => {
  env.DOSSIER_PUBLIC_URL = undefined;
});

describe("publicOrigin", () => {
  it("is DOSSIER_PUBLIC_URL when set, whatever address was called", () => {
    env.DOSSIER_PUBLIC_URL = PUBLIC;
    expect(publicOrigin(request("http://192.168.1.20:3000/api/google/connect"))).toBe(PUBLIC);
  });

  it("is the proxy's forwarded address, else the request's own", () => {
    expect(publicOrigin(request("http://127.0.0.1:3000/x", { "x-forwarded-host": "jobs.example", "x-forwarded-proto": "https" }))).toBe("https://jobs.example");
    expect(publicOrigin(request("http://192.168.1.20:3000/x"))).toBe("http://192.168.1.20:3000");
  });
});

describe("connectorOrigin", () => {
  beforeEach(() => {
    env.DOSSIER_PUBLIC_URL = PUBLIC;
  });

  it("gives an app on the home network the address it called", () => {
    for (const origin of ["http://192.168.1.20:3000", "http://10.0.0.5:3000", "http://172.16.4.2:3000", "http://172.31.255.1"]) {
      expect(connectorOrigin(request(`${origin}/api/mcp`))).toBe(origin);
      // Next.js copies Host into x-forwarded-host on every request it serves.
      expect(connectorOrigin(request(`${origin}/api/mcp`, { "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "http" }))).toBe(origin);
    }
  });

  it("keeps the public address for a request that came through a proxy", () => {
    const forwarded = { "x-forwarded-host": "dossier.example", "x-forwarded-proto": "https" };
    expect(connectorOrigin(request("http://127.0.0.1:3000/api/mcp", forwarded))).toBe(PUBLIC);
    expect(connectorOrigin(request("http://192.168.1.20:3000/api/mcp", forwarded))).toBe(PUBLIC);
  });

  it("keeps the public address for this machine itself, which a proxy beside it calls", () => {
    for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000"]) {
      expect(connectorOrigin(request(`${origin}/api/mcp`))).toBe(PUBLIC);
    }
  });

  it("keeps the public address for names and public addresses, so a rebound domain gets nothing of its own", () => {
    for (const origin of ["http://evil.example:3000", "http://192.168.1.20.evil.example", "http://8.8.8.8:3000", "http://172.32.0.1:3000", "https://dossier.example"]) {
      expect(connectorOrigin(request(`${origin}/api/mcp`))).toBe(PUBLIC);
    }
    expect(connectorOrigin(request("http://dossier.example/api/mcp", { host: "1192.168.1.20:3000" }))).toBe(PUBLIC);
  });

  it("follows publicOrigin when no public address is set", () => {
    env.DOSSIER_PUBLIC_URL = undefined;
    expect(connectorOrigin(request("http://192.168.1.20:3000/api/mcp"))).toBe("http://192.168.1.20:3000");
    expect(connectorOrigin(request("http://127.0.0.1:3000/api/mcp", { "x-forwarded-host": "jobs.example", "x-forwarded-proto": "https" }))).toBe("https://jobs.example");
  });
});

describe("lanOrigin", () => {
  it("is the home-network address a page was opened on, only beside a public address", () => {
    expect(lanOrigin("http://192.168.1.20:3000")).toBeNull();
    env.DOSSIER_PUBLIC_URL = PUBLIC;
    expect(lanOrigin("http://192.168.1.20:3000")).toBe("http://192.168.1.20:3000");
    for (const origin of [PUBLIC, "http://localhost:3000", "http://127.0.0.1:3000", "http://evil.example", "not an address"]) {
      expect(lanOrigin(origin)).toBeNull();
    }
  });
});
