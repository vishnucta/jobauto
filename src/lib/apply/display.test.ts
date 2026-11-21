import { describe, expect, it } from "vitest";

import { hasDisplay, noWindowReason } from "./display";

describe("whether the apply assistant's window can open (round 2 of the audit)", () => {
  it("has a screen on Windows and macOS, and on Linux only with a display", () => {
    expect(hasDisplay({ platform: "win32", env: {} })).toBe(true);
    expect(hasDisplay({ platform: "darwin", env: {} })).toBe(true);
    expect(hasDisplay({ platform: "linux", env: {} })).toBe(false);
    expect(hasDisplay({ platform: "linux", env: { DISPLAY: " " } })).toBe(false);
    expect(hasDisplay({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(hasDisplay({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });

  it("says plainly why nothing opens on a server without a screen, unless the laptop's Chrome is set up", () => {
    const nas = { platform: "linux" as const, env: {} };
    expect(noWindowReason(null, nas)).toMatch(/^Dossier runs on a computer without a screen, such as a NAS/);
    expect(noWindowReason("http://100.101.102.103:9222", nas)).toBeNull();
    expect(noWindowReason(null, { platform: "win32", env: {} })).toBeNull();
  });
});
