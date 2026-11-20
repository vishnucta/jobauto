import "server-only";

import { foundPostingSchema } from "@/lib/job-search/search";
import { prisma } from "@/lib/prisma";

import { salaryGuide, type SalaryGuide } from "./salary-guide";

/**
 * Every job Dossier has seen with a salary stated, each once: from past
 * searches, saved and dismissed postings, and the job agent's finds.
 */
export async function postingsWithSalary(): Promise<{ title: string; salary: string }[]> {
  const [searches, postings, candidates] = await Promise.all([
    prisma.postingSearch.findMany({ select: { postings: true } }),
    prisma.posting.findMany({ where: { salary: { not: "" } }, select: { source: true, externalId: true, title: true, salary: true } }),
    prisma.agentCandidate.findMany({ where: { salary: { not: "" } }, select: { source: true, externalId: true, title: true, salary: true } }),
  ]);
  const seen = new Map<string, { title: string; salary: string }>();
  const keep = (posting: { source: string; externalId: string; title: string; salary: string }) => {
    if (posting.salary.trim()) seen.set(`${posting.source}:${posting.externalId}`, { title: posting.title, salary: posting.salary });
  };
  for (const search of searches) {
    for (const entry of Array.isArray(search.postings) ? search.postings : []) {
      const posting = foundPostingSchema.safeParse(entry);
      if (posting.success) keep(posting.data);
    }
  }
  postings.forEach(keep);
  candidates.forEach(keep);
  return [...seen.values()];
}

/** The salary guide for a job title, from everything seen; null when too few postings state a salary. */
export async function loadSalaryGuide(title: string): Promise<SalaryGuide | null> {
  return title.trim() ? salaryGuide(title, await postingsWithSalary()) : null;
}
