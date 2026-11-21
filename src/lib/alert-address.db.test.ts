import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { moveAlertAddress, ntfyTarget } from "./alert-address";

// The fork's phone-alert topic, moved into Notifications, against the test database.
const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));

const prisma = () => db.client!;

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("ntfyTarget", () => {
  it("splits a topic's address into its server and topic", () => {
    expect(ntfyTarget("https://ntfy.sh/jobauto-abc")).toEqual({ server: "https://ntfy.sh/", topic: "jobauto-abc" });
    expect(ntfyTarget(" http://nas.local:8080/ntfy/alerts ")).toEqual({ server: "http://nas.local:8080/ntfy/", topic: "alerts" });
  });

  it("refuses what isn't a topic, or carries a login or a query", () => {
    for (const address of ["", "ntfy.sh/topic", "https://ntfy.sh/", "https://ntfy.sh/a b", "ftp://ntfy.sh/topic", "https://user:pw@ntfy.sh/topic", "https://ntfy.sh/topic?x=1"]) {
      expect(ntfyTarget(address)).toBeNull();
    }
  });
});

describe("moveAlertAddress (jobauto fork)", () => {
  it("makes the saved topic an ntfy channel with the events at their defaults, once", async () => {
    await saveSettings({ alertAddress: "https://ntfy.sh/jobauto-abcdefghijkmnpqr" });
    expect(await moveAlertAddress()).toBe(true);
    const channels = await prisma().notificationChannel.findMany();
    expect(channels).toMatchObject([{ type: "NTFY", name: "Phone", config: { server: "https://ntfy.sh/", topic: "jobauto-abcdefghijkmnpqr" }, events: {}, secretEnc: null }]);
    expect((await loadSettings()).alertAddress).toBeNull();
    // Nothing left to move the next time the server starts.
    expect(await moveAlertAddress()).toBe(false);
    expect(await prisma().notificationChannel.count()).toBe(1);
  });

  it("does nothing without a topic, and drops one it can't read", async () => {
    expect(await moveAlertAddress()).toBe(false);
    await saveSettings({ alertAddress: "not an address" });
    expect(await moveAlertAddress()).toBe(false);
    expect(await prisma().notificationChannel.count()).toBe(0);
    expect((await loadSettings()).alertAddress).toBeNull();
  });
});
