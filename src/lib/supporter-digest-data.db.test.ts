import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

// The supporter digest as a Notifications event (jobauto fork), against the
// test database: its old ntfy topic carried over to a channel of its own,
// and the weekly send going out as an event. Nothing is really sent: the
// deliveries are only queued.
const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/time-zone", () => ({ lastKnownTimeZone: async () => "Europe/Berlin" }));
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/jobs/runner")>()), startJob: vi.fn(async () => "job") }));

const { moveSupporterAddress, sendDigest, sendDueDigest } = await import("./supporter-digest-data");
const { saveChannel } = await import("@/lib/notifications/store");

const prisma = () => db.client!;
// A Monday, 09:00 in Berlin.
const monday = new Date("2026-11-16T08:00:00Z");

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("moveSupporterAddress (jobauto fork)", () => {
  it("makes the saved topic the channel Supporter, with only the digest on, once", async () => {
    await saveSettings({ supporterAddress: "https://ntfy.sh/jobauto-theirs", supporterDay: 7, supporterHour: 18 });
    expect(await moveSupporterAddress()).toBe(true);
    const channels = await prisma().notificationChannel.findMany();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ type: "NTFY", name: "Supporter", config: { server: "https://ntfy.sh/", topic: "jobauto-theirs" }, secretEnc: null });
    const events = channels[0].events as Record<string, boolean>;
    expect(Object.entries(events).filter(([, on]) => on)).toEqual([["supporter.digest", true]]);
    // The day and hour stay; the topic lives on in the channel.
    expect(await loadSettings()).toMatchObject({ supporterAddress: null, supporterDay: 7, supporterHour: 18 });
    expect(await moveSupporterAddress()).toBe(false);
    expect(await prisma().notificationChannel.count()).toBe(1);
  });

  it("does nothing without a topic, and leaves one it can't read as it was", async () => {
    expect(await moveSupporterAddress()).toBe(false);
    await saveSettings({ supporterAddress: "not an address" });
    expect(await moveSupporterAddress()).toBe(false);
    expect(await prisma().notificationChannel.count()).toBe(0);
    expect((await loadSettings()).supporterAddress).toBe("not an address");
  });
});

describe("the weekly digest as a Notifications event (jobauto fork)", () => {
  it("sends nothing while no channel has it on, even when it's due", async () => {
    await saveChannel({ type: "NTFY", name: "Phone", config: { server: "https://ntfy.sh/", topic: "jobauto-own" }, secret: { action: "keep" } });
    await saveSettings({ supporterDay: 1, supporterHour: 8 });
    expect(await sendDueDigest(monday)).toBe(false);
    expect(await prisma().notificationDelivery.count()).toBe(0);
  });

  it("goes to the supporter's channel when due, once that day, and never to her own", async () => {
    await saveChannel({ type: "NTFY", name: "Phone", config: { server: "https://ntfy.sh/", topic: "jobauto-own" }, secret: { action: "keep" } });
    await saveSettings({ supporterAddress: "https://ntfy.sh/jobauto-theirs", supporterDay: 1, supporterHour: 8 });
    // The old topic is carried over by the same check.
    expect(await sendDueDigest(monday)).toBe(true);
    const deliveries = await prisma().notificationDelivery.findMany({ include: { channel: { select: { name: true } } } });
    expect(deliveries.map((delivery) => [delivery.event, delivery.channel.name])).toEqual([["supporter.digest", "Supporter"]]);
    expect(deliveries[0].message).toMatchObject({ event: "supporter.digest", title: expect.stringMatching(/^Her week: /) });
    expect((await loadSettings()).supporterSentOn).toBe("2026-11-16");
    expect(await sendDueDigest(new Date(monday.getTime() + 60 * 60_000))).toBe(false);
    expect(await prisma().notificationDelivery.count()).toBe(1);
  });

  it("waits for its day and hour", async () => {
    await saveSettings({ supporterAddress: "https://ntfy.sh/jobauto-theirs", supporterDay: 2, supporterHour: 8 });
    expect(await sendDueDigest(monday)).toBe(false);
    expect(await prisma().notificationDelivery.count()).toBe(0);
  });

  it("sends this week's now, to the channels that have it on", async () => {
    await saveSettings({ supporterAddress: "https://ntfy.sh/jobauto-theirs" });
    await moveSupporterAddress();
    expect(await sendDigest(monday)).toBe(1);
  });
});
