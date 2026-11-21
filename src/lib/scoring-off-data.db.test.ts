import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase, TEST_PROFILE_ID } from "@/test/db";

import { loadSettingsStatus } from "./settings-status-data";
import { loadScoringOff } from "./scoring-off-data";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32), DOSSIER_BACKUP_RETENTION_DAYS: 14, DATABASE_URL: process.env.DATABASE_URL, DOSSIER_DATA_DIR: "/tmp/dossier-scoring-off-test" } }));
// An AI provider is set up for scoring, so only the levels are in question.
const ai = vi.hoisted(() => ({ usable: false }));
vi.mock("@/lib/ai/config", async (original) => ({ ...(await original<typeof import("@/lib/ai/config")>()), isAiUsable: async () => ai.usable, isAiConfigured: async () => true }));
const prisma = () => db.client!;

beforeEach(async () => {
  ai.usable = false;
  await resetDatabase(prisma());
});
afterAll(() => prisma().$disconnect());

const profile = (name: string, sort: number, levels: { levelFrom: string; levelTo: string } | null = null) =>
  prisma().profile.create({ data: { name, sort, ...(levels ?? {}) }, select: { id: true } }).then((row) => row.id);
const chosen = { levelFrom: "mid", levelTo: "senior" };
/** The profile every test starts with (resetDatabase), without its levels: then it's the only one. */
const onlyProfile = () => prisma().profile.update({ where: { id: TEST_PROFILE_ID }, data: { levelFrom: null, levelTo: null } }).then((row) => row.id);

describe("loadScoringOff (jobauto fork)", () => {
  it("is off while the only profile has no levels, as scoring itself sees it, and on once they're chosen", async () => {
    const id = await onlyProfile();
    expect(await loadScoringOff()).toEqual({
      title: "Scoring is off: choose the levels your profile is for.",
      body: expect.stringContaining("no posting gets a score"),
      reason: "Choose the levels your profile is for. Nothing is scored until you do.",
      href: `/profile?section=target&profile=${id}`,
      profileId: id,
      canGuess: false,
    });
    await prisma().profile.update({ where: { id }, data: chosen });
    expect(await loadScoringOff()).toBeNull();
  });

  it("offers Guess with AI only when Dossier's AI model can guess", async () => {
    await profile("Erika Mustermann", 0);
    ai.usable = true;
    expect((await loadScoringOff())?.canGuess).toBe(true);
  });

  it("names the profiles that wait among several", async () => {
    await profile("Controlling", 0, chosen);
    const reporting = await profile("Reporting", 1);
    expect(await loadScoringOff()).toMatchObject({ title: "Scoring is off for “Reporting”: choose the levels it's for.", profileId: reporting });
  });

  it("for the Agent screen, asks only about the profiles its switched-on searches score against", async () => {
    const first = await profile("Controlling", 0, chosen);
    const reporting = await profile("Reporting", 1);
    // No search switched on: the first profile, which has its levels.
    expect(await loadScoringOff("agent")).toBeNull();
    await prisma().agentSearch.create({ data: { name: "Hamburg", query: { keywords: "Analyst", country: "de" }, profileId: first } });
    await prisma().agentSearch.create({ data: { name: "Off", query: { keywords: "Analyst", country: "de" }, profileId: reporting, enabled: false } });
    expect(await loadScoringOff("agent")).toBeNull();
    await prisma().agentSearch.create({ data: { name: "Reporting", query: { keywords: "Meldewesen", country: "de" }, profileId: reporting } });
    expect(await loadScoringOff("agent")).toMatchObject({ title: "Scoring is off for “Reporting”: choose the levels it's for." });
  });

  it("for the Agent screen, asks about every profile when a search scores against all of them", async () => {
    await profile("Controlling", 0, chosen);
    await profile("Reporting", 1);
    await prisma().agentSearch.create({ data: { name: "All", query: { keywords: "Analyst", country: "de" }, allProfiles: true } });
    expect((await loadScoringOff("agent"))?.title).toBe("Scoring is off for “Reporting”: choose the levels it's for.");
  });

  it("makes Settings' Scoring card need a look instead of On", async () => {
    const id = await onlyProfile();
    const { scoring } = await loadSettingsStatus();
    expect(scoring).toMatchObject({ tone: "look", meta: "Choose the levels your profile is for. Nothing is scored until you do.", problem: { fix: "Choose levels", href: `/profile?section=target&profile=${id}` } });
    await prisma().profile.update({ where: { id }, data: chosen });
    expect((await loadSettingsStatus()).scoring.problem?.fix).not.toBe("Choose levels");
  });
});
