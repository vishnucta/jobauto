import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { loadInsights, loadWeeklyProgress } from "./insights-data";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const prisma = () => db.client!;

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("loadInsights and loadWeeklyProgress", () => {
  it("groups the sent applications by where they were found, agency and German, and counts this week's", async () => {
    const sentAt = new Date("2026-11-11T10:00:00Z");
    await prisma().language.create({ data: { name: "German", level: "A2" } });
    await prisma().application.create({
      data: { company: "Acme", status: "INTERVIEW", furthestStage: "INTERVIEW", sentAt, language: "English", postingText: "Our working language is English.", posting: { create: { source: "CAREERS", externalId: "greenhouse:acme:1" } } },
    });
    await prisma().application.create({ data: { company: "Hays", status: "REJECTED", furthestStage: "SENT", sentAt, postingText: "Verhandlungssichere Deutschkenntnisse." } });
    await prisma().application.create({ data: { company: "Beta", origin: "AGENT", status: "SENT", furthestStage: "SENT", sentAt: new Date("2026-10-01T10:00:00Z") } });
    await prisma().application.create({ data: { company: "Draft GmbH", status: "DRAFT" } });

    const result = await loadInsights();
    expect(result).toMatchObject({ sent: 3, replies: 1 });
    const rows = (id: string) => result.groups.find((group) => group.id === id)?.rows.map((row) => [row.label, row.sent, row.replies]);
    expect(rows("found")).toEqual([["Careers pages", 1, 1], ["Job agent", 1, 0], ["Pasted or by hand", 1, 0]]);
    expect(rows("agency")).toEqual([["Straight to the employer", 2, 1], ["Through an agency", 1, 0]]);
    expect(rows("german")).toEqual([["Needed more German", 1, 0], ["No posting text", 1, 0], ["Within your German", 1, 1]]);

    await saveSettings({ weeklyTarget: 3 });
    expect(await loadWeeklyProgress("Europe/Berlin", new Date("2026-11-13T09:00:00Z"))).toMatchObject({ target: 3, sent: 2 });
  });
});
