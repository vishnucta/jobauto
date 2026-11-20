import "server-only";

import { foundPostingSchema, searchQuerySchema } from "@/lib/job-search/search";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { prisma } from "@/lib/prisma";
import type { ProfileData } from "@/lib/profile";

import { hiddenTitles, REPORTING_PROFILE, REPORTING_TERMS, type HiddenTitle } from "./hidden-titles";

/** Words too general to tell what a posting asks for. */
const GENERIC = /^(excel|english|deutsch|german|ms office|microsoft office|word|powerpoint|communication|teamwork|sql)$/i;

/** Hidden titles for her: from every posting seen, against her skills and her field's words, leaving out what she searches already. */
export async function loadHiddenTitles(profile: Pick<ProfileData, "basics" | "skills" | "experience">, now = new Date()): Promise<HiddenTitle[]> {
  const [searches, postings, candidates] = await Promise.all([
    prisma.postingSearch.findMany({ select: { postings: true, query: true } }),
    prisma.posting.findMany({ select: { source: true, externalId: true, title: true, description: true } }),
    prisma.agentCandidate.findMany({ select: { source: true, externalId: true, title: true, description: true } }),
  ]);
  const seen = new Map<string, { title: string; description: string }>();
  const keep = (posting: { source: string; externalId: string; title: string; description: string }) => seen.set(`${posting.source}:${posting.externalId}`, posting);
  const searched = new Set<string>(searchChips(searchWords(profile, now), 12));
  for (const search of searches) {
    const query = searchQuerySchema.safeParse(search.query);
    if (query.success && query.data.keywords) searched.add(query.data.keywords);
    for (const entry of Array.isArray(search.postings) ? search.postings : []) {
      const posting = foundPostingSchema.safeParse(entry);
      if (posting.success) keep(posting.data);
    }
  }
  postings.forEach(keep);
  candidates.forEach(keep);

  const profileText = [profile.basics.headline, profile.basics.summary, ...profile.experience.flatMap((role) => [role.role, role.bullets]), ...profile.skills.map((skill) => skill.name)].join(" ");
  const terms = [...profile.skills.map((skill) => skill.name.trim()).filter((name) => name.length > 2 && !GENERIC.test(name)), ...(REPORTING_PROFILE.test(profileText) ? REPORTING_TERMS : [])];
  return hiddenTitles([...seen.values()], terms, [...searched]);
}
