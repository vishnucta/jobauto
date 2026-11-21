import "server-only";

import { foundPostingSchema, searchQuerySchema } from "@/lib/job-search/search";
import { prisma } from "@/lib/prisma";

// Every job Dossier has seen, each once: from past searches, saved and
// dismissed postings, and the job agent's finds. The salary guide and the
// hidden titles both learn from it (jobauto fork). Reading every past
// search's postings is the costly part, so the result is kept until a
// search, posting or find is added or removed.

export type SeenPosting = { title: string; company: string; description: string; salary: string };
export type SeenPostings = { postings: SeenPosting[]; searchedKeywords: string[] };

let kept: { stamp: string; value: Promise<SeenPostings> } | null = null;

/** Changes whenever what's seen could have changed. */
async function stamp(): Promise<string> {
  const [searches, postings, candidates] = await Promise.all([
    prisma.postingSearch.aggregate({ _count: true, _max: { createdAt: true } }),
    prisma.posting.aggregate({ _count: true, _max: { updatedAt: true } }),
    prisma.agentCandidate.aggregate({ _count: true, _max: { updatedAt: true } }),
  ]);
  return [searches._count, searches._max.createdAt?.getTime(), postings._count, postings._max.updatedAt?.getTime(), candidates._count, candidates._max.updatedAt?.getTime()].join(":");
}

async function read(): Promise<SeenPostings> {
  const [searches, postings, candidates] = await Promise.all([
    prisma.postingSearch.findMany({ select: { postings: true, query: true } }),
    prisma.posting.findMany({ select: { source: true, externalId: true, title: true, company: true, description: true, salary: true } }),
    prisma.agentCandidate.findMany({ select: { source: true, externalId: true, title: true, company: true, description: true, salary: true } }),
  ]);
  const seen = new Map<string, SeenPosting>();
  const keep = (posting: { source: string; externalId: string } & SeenPosting) =>
    seen.set(`${posting.source}:${posting.externalId}`, { title: posting.title, company: posting.company, description: posting.description, salary: posting.salary });
  const searchedKeywords: string[] = [];
  for (const search of searches) {
    const query = searchQuerySchema.safeParse(search.query);
    if (query.success && query.data.keywords) searchedKeywords.push(query.data.keywords);
    for (const entry of Array.isArray(search.postings) ? search.postings : []) {
      const posting = foundPostingSchema.safeParse(entry);
      if (posting.success) keep(posting.data);
    }
  }
  postings.forEach(keep);
  candidates.forEach(keep);
  return { postings: [...seen.values()], searchedKeywords };
}

/** Every job seen, each once, and the keywords searched. */
export async function seenPostings(): Promise<SeenPostings> {
  const now = await stamp();
  if (kept?.stamp !== now) {
    const value = read();
    kept = { stamp: now, value };
    value.catch(() => {
      if (kept?.value === value) kept = null;
    });
  }
  return kept.value;
}
