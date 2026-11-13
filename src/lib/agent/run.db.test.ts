import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";
import { alertIfOn } from "@/lib/alerts";
import { demoProfile } from "@/lib/demo-profile";
import type { FoundPosting, SearchQuery } from "@/lib/job-search/search";
import type { JobContext } from "@/lib/jobs/runner";
import { sweepFinishedJobs } from "@/lib/jobs/retention";
import { encryptSecret, TYPESAFE_KEY } from "@/lib/secrets";
import { saveSettings, loadSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { MockProvider } from "../ai/providers/mock";

import { agentDedupeKey, candidateData } from "./candidates";
import { runAgentScan } from "./run";
import { saveAgentSearch, listAgentSearches } from "./searches";
import { reserveRun } from "./runs";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("./scan-lock", async (original) => {
  const { withAgentScanLock } = await original<typeof import("./scan-lock")>();
  const { testDatabaseUrl } = await import("@/test/db");
  return { withAgentScanLock: <T>(work: (signal: AbortSignal) => Promise<T>) => withAgentScanLock(work, testDatabaseUrl()) };
});
// Settings → Scoring reads DOSSIER_SCORER (#274).
vi.mock("@/lib/env", () => ({ env: { DOSSIER_SECRET: "a".repeat(32) } }));
// Drafts are their own jobs; here it's enough to see them queued.
vi.mock("@/lib/jobs/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/runner")>()),
  startJob: vi.fn(async () => "draft-job"),
}));
// The sweep also removes old PDF zips, which isn't what's tested here.
vi.mock("@/lib/jobs/zip-pdfs", () => ({ removeOldZips: async () => {} }));
vi.mock("@/lib/profile-data", async () => {
  const { demoProfile } = await import("@/lib/demo-profile");
  return { loadProfile: async () => demoProfile() };
});

// A fake source that counts its requests, and a fake AI that scores by title.
const fake = vi.hoisted(() => ({
  postings: [] as FoundPosting[],
  searches: 0,
  source: "JSEARCH" as "JSEARCH" | "ADZUNA" | "FREEHIRE" | "ARBEITSAGENTUR" | null,
  ai: true,
  failOn: null as string | null,
  onScore: (() => {}) as (title: string) => void,
}));
vi.mock("@/lib/job-search", () => ({
  searchPostings: vi.fn(async () => {
    fake.searches += 1;
    return { postings: fake.postings, next: "page-2" };
  }),
}));
vi.mock("@/lib/job-search/config", () => ({
  loadJobSearchConfig: vi.fn(async () => ({
    source: fake.source,
    saved: true,
    jsearch: { key: "jsearch-key", host: "openwebninja", keyState: "set" },
    adzuna: { appId: "app", key: "adzuna-key", keyState: "set" },
  })),
  credentialsFor: () => ({ key: "jsearch-key", host: "openwebninja" }),
  requestContext: () => ({}),
}));
vi.mock("@/lib/ai/config", () => ({ isAiConfigured: async () => fake.ai }));
vi.mock("@/lib/alerts", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/alerts")>()), alertIfOn: vi.fn(async () => {}) }));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getAiProvider: async () =>
    new MockProvider({
      reply: (call) => {
        const { title } = JSON.parse(call.messages[0].content.split("The posting's facts:\n")[1].split("\n\nThe posting:")[0]) as { title: string };
        fake.onScore(title);
        if (title === fake.failOn) return "not json at all";
        return { score: /senior/i.test(title) ? 90 : /designer/i.test(title) ? 75 : 40, reasons: [`Fits ${title}.`], redFlags: [] };
      },
    }),
}));

const prisma = () => db.client!;
const query: SearchQuery = { keywords: "Product designer", place: "Rotterdam", country: "nl", radiusKm: 25, remoteOnly: false, postedWithin: "any" };
const now = new Date("2026-10-20T08:00:00Z");
const hour = 60 * 60 * 1000;

const posting = (id: string, title: string, posted: string, extra: Partial<FoundPosting> = {}): FoundPosting => ({
  source: "JSEARCH",
  externalId: id,
  title,
  company: `Company ${id}`,
  place: "Rotterdam",
  remote: false,
  salary: "",
  postedAt: posted,
  url: `https://jobs.example/${id}?utm_source=x`,
  via: "LinkedIn",
  description: `${title} at Company ${id}.`,
  complete: false,
  ...extra,
});
const page = [
  posting("a", "Senior Product Designer", "2026-10-19T00:00:00Z"),
  posting("b", "Product Designer", "2026-10-18T00:00:00Z"),
  // No link: its dedupe key is company, title and place.
  posting("c", "Office Manager", "2026-10-17T00:00:00Z", { url: "" }),
];

const context = (abort?: AbortController): JobContext & { steps: string[] } => {
  const steps: string[] = [];
  return { id: "agent-job", steps, step: async (name) => void steps.push(name), signal: (abort ?? new AbortController()).signal };
};

beforeEach(async () => {
  await resetDatabase(prisma());
  Object.assign(fake, { postings: page, searches: 0, source: "JSEARCH", ai: true, failOn: null, onScore: () => {} });
  await saveSettings({ agentEnabled: true });
  await prisma().agentSearch.create({ data: { name: "My search", query } });
});
afterAll(() => prisma().$disconnect());

describe("runAgentScan (E16-3)", () => {
  it("runs recurring searches with FreeHire under the same request budget", async () => {
    fake.source = "FREEHIRE";
    fake.postings = page.map((posting) => ({ ...posting, source: "FREEHIRE" }));
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result).toMatchObject({ found: 3, scored: 3 });
    expect((await loadSettings()).agentRuns[0].sourceRequests).toBe(1);
    expect(await prisma().agentCandidate.count({ where: { source: "FREEHIRE" } })).toBe(3);
  });

  it.each(["ARBEITSAGENTUR", null] as const)("uses its validated source snapshot despite a concurrent switch to %s", async (source) => {
    const { loadJobSearchConfig } = await import("@/lib/job-search/config");
    const original = vi.mocked(loadJobSearchConfig).getMockImplementation()!;
    vi.mocked(loadJobSearchConfig).mockClear();
    vi.mocked(loadJobSearchConfig).mockImplementationOnce(async () => {
      const config = await original();
      fake.source = source;
      return config;
    });
    expect((await runAgentScan({ manual: false }, context(), now)).scored).toBe(3);
    expect(loadJobSearchConfig).toHaveBeenCalledTimes(1);
    expect(fake.searches).toBe(1);
    expect((await loadSettings()).agentRuns[0].sourceRequests).toBe(1);
  });

  it("distinguishes an all-disabled collection from no searches without consuming budget", async () => {
    await prisma().agentSearch.updateMany({ data: { enabled: false } });
    expect((await runAgentScan({ manual: true }, context(), now)).message).toBe("Enable an Agent search in Settings → Job agent first.");
    expect((await loadSettings()).agentRuns).toEqual([]);
    expect(fake.searches).toBe(0);
  });

  it("reconciles a crashed scan only after acquiring scan ownership, even when admission is refused", async () => {
    await reserveRun(now, false, 3);
    const result = await runAgentScan({ manual: true }, context(), new Date(now.getTime() + hour));
    expect(result.message).toContain("needs 1 source request");
    const runs = (await loadSettings()).agentRuns;
    expect(runs).toHaveLength(1);
    expect(runs[0].message).toContain("interrupted");
    expect(runs[0].sourceRequests).toBe(3);
    expect(fake.searches).toBe(0);
  });
  it("collects ordered searches sequentially, fairly scores unique candidates and shares the draft cap", async () => {
    const { searchPostings } = await import("@/lib/job-search");
    const [first] = await listAgentSearches();
    const second = await saveAgentSearch({ name: "Second", query: { ...query, keywords: "Second query" }, sort: 1, enabled: true });
    await saveAgentSearch({ name: "Disabled", query, sort: 2, enabled: false });
    const shared = page[0];
    const secondNew = posting("second", "Senior Second Designer", "2026-10-18T12:00:00Z");
    vi.mocked(searchPostings).mockImplementationOnce(async (_source, _credentials, q, cursor) => {
      expect(q).toEqual(query);
      expect(cursor).toBeNull();
      fake.searches++;
      await Promise.resolve();
      expect(fake.searches).toBe(1); // A parallel second dispatch would already have incremented it.
      return { postings: [page[2], shared, page[1]], next: "page-2" };
    }).mockImplementationOnce(async (_source, _credentials, q, cursor) => {
      expect(q.keywords).toBe("Second query");
      expect(cursor).toBeNull();
      fake.searches++;
      return { postings: [secondNew, shared], next: "page-2" };
    });
    const scores: string[] = [];
    fake.onScore = (title) => { expect(fake.searches).toBe(2); scores.push(title); };
    await saveSettings({ agentMaxScores: 3, agentAutoDraft: true, agentMaxDrafts: 1 });
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(scores).toEqual([shared.title, secondNew.title, page[1].title]);
    expect(result).toMatchObject({ found: 5, fresh: 4, scored: 3, drafted: 1, skipped: 1 });
    const candidate = await prisma().agentCandidate.findUniqueOrThrow({ where: { dedupeKey: agentDedupeKey(shared) } });
    expect((await prisma().agentCandidateSearch.findMany({ where: { candidateId: candidate.id } })).map((link) => link.searchId).sort()).toEqual([first.id, second.id].sort());
    expect((await loadSettings()).agentRuns[0]).toMatchObject({ sourceRequests: 2, searches: [{ searchName: "My search", found: 3, fresh: 3 }, { searchName: "Second", found: 2, fresh: 2 }] });
  });

  it("continues after an individual source error and keeps its durable result", async () => {
    const { searchPostings } = await import("@/lib/job-search");
    await saveAgentSearch({ name: "Second", query, sort: 1, enabled: true });
    vi.mocked(searchPostings).mockRejectedValueOnce(new Error("socket hang up"));
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result.scored).toBe(3);
    expect(result.message).toContain("My search: The job source couldn't be reached.");
    expect((await loadSettings()).agentRuns[0]).toMatchObject({ sourceRequests: 2, searches: [{ found: 0, fresh: 0, error: expect.any(String) }, { found: 3, fresh: 3, error: null }] });
    expect((await runAgentScan({ manual: true }, context(), new Date(now.getTime() + hour))).message).toContain("needs 2 source requests");
  });

  it("keeps source collection success separate from model failure, without inventing candidate attribution", async () => {
    await saveAgentSearch({ name: "Overlap", query, sort: 1, enabled: true });
    fake.postings = [page[1]];
    fake.failOn = page[1].title;
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result).toMatchObject({ found: 2, fresh: 1, scored: 0, drafted: 0, message: "The model's answer didn't come back in the expected shape. Try again." });
    const run = (await loadSettings()).agentRuns[0];
    expect(run).toMatchObject({ sourceRequests: 2, message: result.message, searches: [
      { searchName: "My search", found: 1, fresh: 1, error: null },
      { searchName: "Overlap", found: 1, fresh: 1, error: null },
    ] });
    expect(await prisma().agentCandidate.count()).toBe(0);
    expect(await prisma().agentCandidateSearch.count()).toBe(0);
    expect((await runAgentScan({ manual: true }, context(), new Date(now.getTime() + hour))).message).toContain("needs 2 source requests");
    expect(fake.searches).toBe(2);
  });

  it("attributes existing candidates before dedupe, without restoring dismissed or Find jobs exclusions", async () => {
    const kept = await prisma().agentCandidate.create({ data: candidateData(page[0], { score: 90, reasons: [], redFlags: [] }) });
    const dismissed = await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "b", dedupeKey: agentDedupeKey(page[1]), status: "DISMISSED" } });
    await prisma().posting.create({ data: { source: "JSEARCH", externalId: "c", savedAt: now } });
    const second = await saveAgentSearch({ name: "Overlap", query, sort: 1, enabled: true });
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result).toMatchObject({ scored: 0, fresh: 0 });
    const links = await prisma().agentCandidateSearch.findMany();
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.candidateId === kept.id)).toBe(true);
    expect(links.some((link) => link.searchId === second.id)).toBe(true);
    expect(await prisma().agentCandidate.findUnique({ where: { id: dismissed.id } })).toEqual(dismissed);
  });

  it("prevents overlapping manual/scheduled scans while source dispatch is blocked", async () => {
    const { searchPostings } = await import("@/lib/job-search");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.mocked(searchPostings).mockImplementationOnce(async () => { entered(); await blocked; return { postings: page, next: null }; });
    const running = runAgentScan({ manual: false }, context(), now);
    await started;
    try {
      expect((await runAgentScan({ manual: true }, context(), new Date(now.getTime() + hour))).message).toBe("An agent scan is already running.");
      expect((await loadSettings()).agentRuns).toHaveLength(1);
    } finally { release(); await running; }
  });

  it("doesn't execute a second scheduled job queued before the first one finished", async () => {
    await runAgentScan({ manual: false }, context(), now);
    expect((await runAgentScan({ manual: false }, context(), new Date(now.getTime() + hour))).message).toBe("The agent already ran today.");
    expect(fake.searches).toBe(1);
  });

  it("excludes Bundesagentur for all enabled searches and manual Agent runs too", async () => {
    await saveAgentSearch({ name: "Second", query, sort: 1, enabled: true });
    fake.source = "ARBEITSAGENTUR";
    expect((await runAgentScan({ manual: true }, context(), now)).message).toContain("doesn't search the Bundesagentur");
    expect(fake.searches).toBe(0);
    expect((await loadSettings()).agentRuns).toEqual([]);
  });

  it("searches once, scores the new postings and keeps them, below the minimum too", async () => {
    const run = context();
    const result = await runAgentScan({ manual: false }, run, now);
    expect(fake.searches).toBe(1);
    expect(run.steps).toEqual(["Searching for new postings", "Scoring 3 postings"]);
    expect(result).toEqual({ found: 3, fresh: 3, scored: 3, drafted: 0, skipped: 0, message: "2 new postings are waiting for a look." });
    const candidates = await prisma().agentCandidate.findMany({ orderBy: { score: "desc" } });
    expect(candidates.map((candidate) => [candidate.externalId, candidate.score, candidate.status])).toEqual([
      ["a", 90, "SCORED"],
      ["b", 75, "SCORED"],
      ["c", 40, "SCORED"],
    ]);
    expect(candidates[0]).toMatchObject({ title: "Senior Product Designer", reasons: ["Fits Senior Product Designer."], dedupeKey: agentDedupeKey(page[0]) });
    // Find jobs shows the scores too (#208).
    expect((await prisma().postingScore.findMany({ orderBy: { score: "desc" } })).map((row) => [row.externalId, row.score])).toEqual([["a", 90], ["b", 75], ["c", 40]]);
    // The run is on record, with how it ended.
    expect((await loadSettings()).agentRuns).toEqual([{ at: now.toISOString(), manual: false, message: "2 new postings are waiting for a look.", sourceRequests: 1, sourceRequestAts: [expect.any(String)], searches: [expect.objectContaining({ searchName: "My search", found: 3, fresh: 3, error: null })] }]);
  });

  it("sends one phone alert for the postings scored at least the alert's minimum, best first", async () => {
    await saveSettings({ alertMinScore: 70 });
    await runAgentScan({ manual: false }, context(), now);
    expect(alertIfOn).toHaveBeenCalledTimes(1);
    expect(alertIfOn).toHaveBeenCalledWith({ title: "2 strong new matches", message: "90 · Senior Product Designer, Company a\n75 · Product Designer, Company b", open: "/agent" });
    vi.mocked(alertIfOn).mockClear();
    await saveSettings({ alertMinScore: 95 });
    fake.postings = [posting("e", "Senior Analyst", "2026-10-19T00:00:00Z")];
    await runAgentScan({ manual: true }, context(), now);
    expect(alertIfOn).not.toHaveBeenCalled();
  });

  it("doesn't score postings that need far more German than the profile has (B1)", async () => {
    fake.postings = [...page, posting("d", "Buchhalter", "2026-10-19T00:00:00Z", { description: "Verhandlungssichere Deutschkenntnisse in Wort und Schrift." })];
    const scored: string[] = [];
    fake.onScore = (title) => void scored.push(title);
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(scored).not.toContain("Buchhalter");
    expect(result).toMatchObject({ found: 4, fresh: 4, scored: 3, message: "2 new postings are waiting for a look. 1 more needs more German than your profile has, so it wasn't scored." });
    expect(await prisma().agentCandidate.count({ where: { externalId: "d" } })).toBe(0);
  });

  it("scores with Jev when Settings → Scoring chose it, without an AI provider (#274)", async () => {
    fake.ai = false;
    await saveSettings({ scorer: "JEV" });
    expect(await runAgentScan({ manual: false }, context(), now)).toMatchObject({ found: 0, message: "Enter your TypeSafe key in Settings → Scoring first." });
    expect(fake.searches).toBe(0);

    await saveSettings({ typesafeKeyEnc: encryptSecret(TYPESAFE_KEY, "ts_secret") });
    // Jev at its most sure: every Score at the top for a designer's posting and at the bottom otherwise.
    const requests = stubFetch(({ body }) => {
      const { questions, state } = body as { questions: Record<string, { type: string; criteria?: unknown[] }>; state: { posting: { title: string } } };
      const fits = /designer/i.test(state.posting.title);
      const answer = (id: string, question: { type: string; criteria?: unknown[] }) =>
        question.type === "score"
          ? { type: "score", score: fits ? question.criteria!.length - 1 : 0, confidence: 0.9, probabilities: {} }
          : question.type === "choice"
            ? { type: "choice", choice: "required", confidence: 0.9, probabilities: {} }
            : { type: "noul", noul: id.endsWith("Shown") && fits ? 0.9 : 0.05 };
      return json({ model: "jev-1.14.0", answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, answer(id, question)])) });
    });
    const result = await runAgentScan({ manual: false }, context(), now);
    vi.unstubAllGlobals();

    expect(result).toMatchObject({ found: 3, scored: 3, message: "2 new postings are waiting for a look." });
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual(["Bearer ts_secret", "Bearer ts_secret", "Bearer ts_secret"]);
    const candidates = await prisma().agentCandidate.findMany({ orderBy: { externalId: "asc" } });
    expect(candidates.map((candidate) => [candidate.externalId, candidate.score])).toEqual([["a", 100], ["b", 100], ["c", 0]]);
    expect(candidates[0].reasons).toContain("Covers: Senior Product Designer at Company a.");
    expect(candidates[2].redFlags).toEqual(["The role's level is far from your experience.", "Missing: Office Manager at Company c."]);
    expect((await prisma().postingScore.findFirstOrThrow({ where: { externalId: "a" } })).scoredWith).toBe("score-posting-jev@1 (jev-1.14.0)");
  });

  it("scores the newest new postings first, up to the cap", async () => {
    await saveSettings({ agentMaxScores: 2 });
    const scoredTitles: string[] = [];
    fake.onScore = (title) => scoredTitles.push(title);
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(scoredTitles).toEqual(["Senior Product Designer", "Product Designer"]);
    expect(result).toMatchObject({ fresh: 3, scored: 2 });
  });

  it("never brings back what it has seen, from another run or another source", async () => {
    await runAgentScan({ manual: false }, context(), now);
    const again = await runAgentScan({ manual: true }, context(), new Date(now.getTime() + 2 * hour));
    expect(again).toEqual({ found: 3, fresh: 0, scored: 0, drafted: 0, skipped: 3, message: "No new postings this time." });

    // The same jobs from Adzuna: one by its link, one by company, title and place.
    fake.postings = [
      posting("az-1", "Senior Product Designer", "2026-10-19T00:00:00Z", { source: "ADZUNA", url: "https://jobs.example/a?utm_medium=y" }),
      posting("az-2", "Office  Manager", "2026-10-18T00:00:00Z", { source: "ADZUNA", url: "", company: "COMPANY c" }),
      posting("az-3", "Brand Designer", "2026-10-20T00:00:00Z", { source: "ADZUNA" }),
    ];
    const third = await runAgentScan({ manual: true }, context(), new Date(now.getTime() + 4 * hour));
    expect(third).toMatchObject({ found: 3, fresh: 1, scored: 1, skipped: 2 });
  });

  it("leaves out postings saved, dismissed or applied for in Find jobs", async () => {
    const application = await prisma().application.create({ data: {} });
    await prisma().posting.create({ data: { source: "JSEARCH", externalId: "a", savedAt: now } });
    await prisma().posting.create({ data: { source: "JSEARCH", externalId: "b", dismissedAt: now } });
    await prisma().posting.create({ data: { source: "JSEARCH", externalId: "c", applicationId: application.id } });
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result).toMatchObject({ found: 3, fresh: 0, skipped: 3 });
    expect(await prisma().agentCandidate.count()).toBe(0);
  });

  it("stops without asking the source when it's off, not set up, or has run 3 times in 24 hours", async () => {
    const stop = async (manual = false) => (await runAgentScan({ manual }, context(), now)).message;
    await saveSettings({ agentEnabled: false });
    expect(await stop()).toBe("The job agent is off.");
    await saveSettings({ agentEnabled: true });
    await prisma().agentSearch.deleteMany();
    expect(await stop()).toBe("Add what to look for in Settings → Job agent first.");
    const search = await prisma().agentSearch.create({ data: { name: "My search", query: { ...query, country: "" } } });
    expect(await stop()).toBe("Choose a country for “My search” in Settings → Job agent first.");
    await prisma().agentSearch.update({ where: { id: search.id }, data: { query } });
    fake.ai = false;
    expect(await stop()).toBe("Choose an AI provider in Settings → AI provider first.");
    fake.ai = true;
    fake.source = null;
    expect(await stop()).toBe("Choose a job source in Settings → Job search first.");
    // It never searches the Bundesagentur für Arbeit on its own (#223).
    fake.source = "ARBEITSAGENTUR";
    expect(await stop()).toBe("The job agent doesn't search the Bundesagentur für Arbeit. Choose JSearch, SerpApi, Adzuna or FreeHire in Settings → Job search for it.");
    fake.source = "JSEARCH";
    expect(fake.searches).toBe(0);
    expect((await loadSettings()).agentRuns).toEqual([]);
  });

  it("holds the daily limit from its own record, whatever the task-data sweep deletes", async () => {
    await saveSettings({ jobRetentionHours: 1 });
    for (const hours of [0, 2, 4]) {
      // Each run's Job row, as the runner leaves it, which the sweep deletes an hour later.
      const at = new Date(now.getTime() + hours * hour);
      await prisma().job.create({ data: { type: "agent-scan", key: "agent", status: "DONE", input: { manual: true }, finishedAt: at } });
      await runAgentScan({ manual: true }, context(), at);
      await sweepFinishedJobs(new Date(now.getTime() + (hours + 1.5) * hour));
    }
    expect(fake.searches).toBe(3);
    expect(await prisma().job.count()).toBe(0);
    const fourth = await runAgentScan({ manual: true }, context(), new Date(now.getTime() + 6 * hour));
    expect(fourth.message).toBe("The agent needs 1 source request, but may use only 3 in 24 hours. Next eligible: Wed 21 Oct, 08:00 (UTC).");
    expect(fake.searches).toBe(3);
    // A day after the first, one may go again.
    const firstAttempt = (await loadSettings()).agentRuns.at(-1)!.sourceRequestAts![0];
    await runAgentScan({ manual: true }, context(), new Date(Date.parse(firstAttempt) + 24 * hour));
    expect(fake.searches).toBe(4);
  });

  it("records the run before it asks the source, so a failing source still counts", async () => {
    const { searchPostings } = await import("@/lib/job-search");
    vi.mocked(searchPostings).mockRejectedValueOnce(new Error("socket hang up"));
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result.message).toContain("My search: The job source couldn't be reached.");
    expect((await loadSettings()).agentRuns).toEqual([{ at: now.toISOString(), manual: false, message: result.message, sourceRequests: 1, sourceRequestAts: [expect.any(String)], searches: [expect.objectContaining({ found: 0, fresh: 0, error: "The job source couldn't be reached. Try again." })] }]);
  });

  it("goes on when one score fails, and says what failed when none worked", async () => {
    fake.failOn = "Product Designer";
    const result = await runAgentScan({ manual: false }, context(), now);
    expect(result).toMatchObject({ scored: 2 });
    expect((await prisma().agentCandidate.findMany()).map((candidate) => candidate.externalId).sort()).toEqual(["a", "c"]);

    await prisma().agentCandidate.deleteMany();
    fake.postings = [page[1]];
    const failed = await runAgentScan({ manual: true }, context(), new Date(now.getTime() + 2 * hour));
    expect(failed).toMatchObject({ scored: 0, message: "The model's answer didn't come back in the expected shape. Try again." });
  });

  it("stops between postings when it's cancelled", async () => {
    const abort = new AbortController();
    fake.onScore = () => abort.abort();
    const result = await runAgentScan({ manual: false }, context(abort), now);
    expect(result.scored).toBe(0);
    expect(await prisma().agentCandidate.count()).toBe(0);
  });

  it("queues drafts for the best new postings when auto-draft is on, up to the cap (#197)", async () => {
    const { startJob } = await import("@/lib/jobs/runner");
    vi.mocked(startJob).mockClear();
    expect((await runAgentScan({ manual: false }, context(), now)).drafted).toBe(0);
    expect(startJob).not.toHaveBeenCalled();

    await prisma().agentCandidate.deleteMany();
    await saveSettings({ agentAutoDraft: true, agentMaxDrafts: 1 });
    const result = await runAgentScan({ manual: true }, context(), new Date(now.getTime() + 2 * hour));
    expect(result).toMatchObject({ scored: 3, drafted: 1, message: "2 new postings are waiting for a look. Preparing a draft for the best one." });
    const best = await prisma().agentCandidate.findFirstOrThrow({ where: { externalId: "a" } });
    expect(startJob).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "agent-draft" }), { candidateId: best.id }, { key: `agent-candidate:${best.id}` });
  });

  it("says when nothing reached the minimum score", async () => {
    fake.postings = [page[2]];
    expect((await runAgentScan({ manual: false }, context(), now)).message).toBe("Scored 1 new posting; none reached your minimum score of 70.");
    expect(demoProfile().basics.name).toBe("Jane Doe");
  });
});
