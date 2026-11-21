import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { dismissPortalsOffNote } from "./portals-off-actions";
import { portalsOffNote } from "./portals-off";
import { SOURCE_INFO, type PortalView } from "./sources";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const prisma = () => db.client!;

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

/** A built-in with its key saved, on or off. */
function keyed(id: "JSEARCH" | "SERPAPI" | "ADZUNA", on = false): PortalView {
  const { name, description, tag, keyUrl, quotaPeriod, countries, kinds } = SOURCE_INFO[id];
  return {
    id,
    name,
    description,
    tag,
    keyUrl,
    quotaPeriod,
    countries: countries ? [...countries] : null,
    kinds: [...kinds],
    installed: null,
    version: "1.0.0",
    withdrawal: null,
    update: null,
    on,
    consent: null,
    acceptedAt: null,
    fields: [{ name: "key", label: "API key", type: "secret", keyState: "set", envName: null }],
  };
}

describe("portalsOffNote (jobauto fork)", () => {
  it("names the portals with a key that are off, until it's dismissed", async () => {
    expect(await portalsOffNote([keyed("JSEARCH"), keyed("SERPAPI")])).toEqual(["JSearch", "SerpApi"]);
    expect((await dismissPortalsOffNote({})).ok).toBe(true);
    expect((await loadSettings()).portalsOffNoteDone).toBe(true);
    expect(await portalsOffNote([keyed("JSEARCH"), keyed("SERPAPI")])).toBeNull();
  });

  it("is done for good once one of them is on, without switching any on itself", async () => {
    expect(await portalsOffNote([keyed("JSEARCH"), keyed("SERPAPI", true)])).toBeNull();
    expect((await loadSettings()).portalsOffNoteDone).toBe(true);
    // Switched off again later: the note doesn't come back.
    expect(await portalsOffNote([keyed("JSEARCH"), keyed("SERPAPI")])).toBeNull();
    expect(await prisma().setting.findUnique({ where: { key: "portals" } })).toBeNull();
  });

  it("isn't done while no portal has a key", async () => {
    expect(await portalsOffNote([])).toBeNull();
    expect((await loadSettings()).portalsOffNoteDone).toBe(false);
    await saveSettings({ portalsOffNoteDone: false });
    expect(await portalsOffNote([keyed("ADZUNA")])).toEqual(["Adzuna"]);
  });
});
