import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { googleConnection } from "./account";
import { calendarWanted } from "./calendar-data";

// Whether the dashboard shows its calendar (jobauto fork), against the test database.
const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("./account", () => ({ googleConnection: vi.fn(async () => ({ status: "disconnected" })) }));

const prisma = () => db.client!;
const now = new Date("2026-11-21T12:00:00Z");

beforeEach(async () => {
  await resetDatabase(prisma());
  vi.mocked(googleConnection).mockResolvedValue({ status: "disconnected" });
});
afterAll(() => prisma().$disconnect());

describe("calendarWanted (jobauto fork)", () => {
  it("leaves the calendar out without Google and without an interview coming", async () => {
    await prisma().application.create({ data: { title: "Analyst", company: "Acme", status: "INTERVIEW", nextInterviewAt: new Date("2026-11-20T09:00:00Z") } });
    expect(await calendarWanted(now)).toBe(false);
  });

  it("shows it for an interview coming, but not an archived one's", async () => {
    const application = await prisma().application.create({ data: { title: "Analyst", company: "Acme", status: "INTERVIEW", nextInterviewAt: new Date("2026-12-20T09:00:00Z") } });
    expect(await calendarWanted(now)).toBe(true);
    await prisma().application.update({ where: { id: application.id }, data: { archivedAt: now } });
    expect(await calendarWanted(now)).toBe(false);
  });

  it("shows it whenever a Google account is connected", async () => {
    vi.mocked(googleConnection).mockResolvedValue({ status: "connected" } as Awaited<ReturnType<typeof googleConnection>>);
    expect(await calendarWanted(now)).toBe(true);
  });
});
