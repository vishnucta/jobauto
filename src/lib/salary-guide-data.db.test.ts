import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_QUERY } from "@/lib/job-search/search";
import { createTestClient, resetDatabase } from "@/test/db";

import { loadSalaryGuide, postingsWithSalary } from "./salary-guide-data";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const prisma = () => db.client!;

const found = (externalId: string, title: string, salary: string) => ({
  source: "ARBEITSAGENTUR",
  externalId,
  title,
  company: "Acme",
  place: "Hamburg",
  remote: null,
  salary,
  postedAt: null,
  url: "",
  via: "",
  description: "",
  complete: false,
});

beforeEach(() => resetDatabase(prisma()));
afterAll(() => prisma().$disconnect());

describe("postingsWithSalary", () => {
  it("counts each job once, from searches, kept postings and the agent's finds", async () => {
    const job = found("a", "Regulatory Reporting Analyst", "55.000 € bis 65.000 € pro Jahr");
    await prisma().postingSearch.create({ data: { sources: ["ARBEITSAGENTUR"], query: EMPTY_QUERY, postings: [job, found("b", "Reporting Specialist", "65.000 € pro Jahr"), found("c", "No salary", "")], found: 3 } });
    await prisma().postingSearch.create({ data: { sources: ["ARBEITSAGENTUR"], query: EMPTY_QUERY, postings: [job], found: 1 } });
    await prisma().posting.create({ data: { source: "ARBEITSAGENTUR", externalId: "a", title: job.title, salary: job.salary } });
    await prisma().agentCandidate.create({ data: { source: "JSEARCH", externalId: "d", title: "Regulatory Reporting Manager", salary: "EUR 75,000–85,000", dedupeKey: "d" } });

    expect((await postingsWithSalary()).map((posting) => posting.title).sort()).toEqual(["Regulatory Reporting Analyst", "Regulatory Reporting Manager", "Reporting Specialist"]);
    expect(await loadSalaryGuide("Regulatory Reporting Analyst")).toMatchObject({ postings: 3, basis: "alike", median: 65_000 });
    expect(await loadSalaryGuide("")).toBeNull();
  });
});
