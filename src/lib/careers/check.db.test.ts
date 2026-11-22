import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emit } from "@/lib/notifications/notify";
import { loadSearch } from "@/lib/posting-searches";
import { createTestClient, resetDatabase } from "@/test/db";

import { careersCheckDue, checkCareersPages } from "./check";
import { politeness } from "./read";
import { createEmployer, listEmployers, updateEmployer } from "./store";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
vi.mock("@/lib/notifications/notify", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications/notify")>()), emit: vi.fn(async () => 0) }));
const prisma = () => db.client!;

const context = { step: async () => {}, signal: new AbortController().signal };
const now = new Date("2026-11-13T07:00:00Z");

const greenhouse = (jobs: { id: number; title: string; place: string }[]) => ({
  jobs: jobs.map((job) => ({ id: job.id, title: job.title, absolute_url: `https://boards.greenhouse.io/acme/jobs/${job.id}`, location: { name: job.place }, content: "" })),
});

function stubFeeds(feeds: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => (url in feeds ? new Response(JSON.stringify(feeds[url])) : new Response("", { status: 404 }))),
  );
}

const ACME = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";

beforeEach(async () => {
  Object.assign(politeness, { pauseMs: 0, retryMs: 0 });
  await resetDatabase(prisma());
  vi.mocked(emit).mockClear();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => prisma().$disconnect());

describe("checkCareersPages", () => {
  it("adds the matching jobs new to Dossier to Positions as one search, once, and sends one notification", async () => {
    await createEmployer({ careersUrl: "https://boards.greenhouse.io/acme", keywords: "Reporting, Meldewesen", places: "Hamburg" });
    stubFeeds({
      [ACME]: greenhouse([
        { id: 1, title: "Regulatory Reporting Analyst", place: "Hamburg" },
        { id: 2, title: "Spezialist Meldewesen", place: "Hamburg" },
        { id: 3, title: "Reporting Analyst", place: "München" },
        { id: 4, title: "Office Manager", place: "Hamburg" },
      ]),
    });
    const first = await checkCareersPages({}, context, now);
    expect(first).toMatchObject({ checked: 1, added: 2, problems: [], message: "2 new jobs added to Positions from 1 careers page." });
    const search = await loadSearch(first.searchId!);
    expect(search).toMatchObject({ source: "CAREERS", addedBy: "Acme" });
    expect(search!.postings.map((posting) => [posting.title, posting.state.new])).toEqual([
      ["Regulatory Reporting Analyst", true],
      ["Spezialist Meldewesen", true],
    ]);
    expect(emit).toHaveBeenCalledWith(
      "careers.new",
      { postings: [expect.objectContaining({ title: "Regulatory Reporting Analyst", company: "Acme" }), expect.objectContaining({ title: "Spezialist Meldewesen", company: "Acme" })], path: `/jobs?found=${first.searchId}` },
      now,
    );
    expect((await listEmployers())[0]).toMatchObject({ name: "Acme", ats: "greenhouse", lastMatched: 2, lastNew: 2, problem: null, lastCheckedAt: now.toISOString() });

    // Not again within the hour: the site isn't asked too often.
    expect(await checkCareersPages({}, context, new Date(now.getTime() + 30 * 60 * 1000))).toMatchObject({
      checked: 0,
      added: 0,
      message: "This careers page was read less than an hour ago: Dossier reads it again later, so the sites aren't asked too often.",
    });

    // The next day, only what's new.
    vi.mocked(emit).mockClear();
    const second = await checkCareersPages({}, context, new Date(now.getTime() + 24 * 60 * 60 * 1000));
    expect(second).toMatchObject({ added: 0, searchId: null, message: "No new jobs from 1 careers page." });
    expect(emit).not.toHaveBeenCalled();
    expect((await listEmployers())[0]).toMatchObject({ lastMatched: 2, lastNew: 0 });
  });

  it("keeps why a page couldn't be read, checks the rest, and clears it once it reads again", async () => {
    const gone = await createEmployer({ name: "Gone", careersUrl: "https://boards.greenhouse.io/gone" });
    await createEmployer({ name: "Acme", careersUrl: "https://boards.greenhouse.io/acme" });
    stubFeeds({ [ACME]: greenhouse([{ id: 1, title: "Analyst", place: "Hamburg" }]) });
    const result = await checkCareersPages({}, context, now);
    expect(result).toMatchObject({ checked: 2, added: 1, problems: ["Gone: The job system doesn't know this careers page. Check its address."] });
    expect(result.message).toBe("1 new job added to Positions from 2 careers pages. 1 page couldn't be read.");
    await updateEmployer(gone.id, { name: "Gone", careersUrl: "https://boards.greenhouse.io/acme" });
    expect((await listEmployers()).find((employer) => employer.id === gone.id)).toMatchObject({ problem: null, lastCheckedAt: null });
  });

  it("keeps what a feed found before it asked for fewer requests, and reads new words right away", async () => {
    const acme = await createEmployer({ careersUrl: "https://acme.wd3.myworkdayjobs.com/Careers", keywords: "EMIR, MiFIR", places: "Hamburg" });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1 ? new Response(JSON.stringify({ total: 1, jobPostings: [{ title: "EMIR Analyst", externalPath: "/job/Hamburg/EMIR-Analyst_R100", locationsText: "Hamburg" }] })) : new Response("", { status: 429 }),
      ),
    );
    const result = await checkCareersPages({}, context, now);
    expect(result).toMatchObject({ checked: 1, added: 1, problems: ["Acme: acme.wd3.myworkdayjobs.com asks for fewer requests just now. Dossier reads it again at the next check."] });
    expect((await listEmployers())[0]).toMatchObject({ lastMatched: 1, lastNew: 1, problem: expect.stringContaining("fewer requests") });

    // New words: read again within the hour.
    await updateEmployer(acme.id, { careersUrl: "https://acme.wd3.myworkdayjobs.com/Careers", keywords: "EMIR", places: "Hamburg" });
    expect((await listEmployers())[0]).toMatchObject({ lastCheckedAt: null });
  });

  it("checks only the employers asked for, and leaves out those turned off", async () => {
    const acme = await createEmployer({ careersUrl: "https://boards.greenhouse.io/acme" });
    await prisma().employer.update({ where: { id: acme.id }, data: { enabled: false } });
    stubFeeds({ [ACME]: greenhouse([{ id: 1, title: "Analyst", place: "Hamburg" }]) });
    expect(await checkCareersPages({}, context, now)).toMatchObject({ checked: 0, message: "There are no careers pages to check. Add an employer first." });
    expect(await checkCareersPages({ ids: [acme.id] }, context, now)).toMatchObject({ checked: 1, added: 1 });
  });
});

describe("careersCheckDue", () => {
  it("is due once a day, from 06:00 in the user's time zone", () => {
    expect(careersCheckDue(new Date("2026-11-13T04:30:00Z"), "Europe/Berlin", null)).toBe(false);
    expect(careersCheckDue(new Date("2026-11-13T05:30:00Z"), "Europe/Berlin", null)).toBe(true);
    expect(careersCheckDue(new Date("2026-11-13T05:30:00Z"), "Europe/Berlin", "2026-11-13")).toBe(false);
    expect(careersCheckDue(new Date("2026-11-14T06:00:00Z"), "Europe/Berlin", "2026-11-13")).toBe(true);
  });
});
