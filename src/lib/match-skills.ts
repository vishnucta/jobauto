import "server-only";

import { ActionError } from "@/lib/action";
import { extractedSchema, matchSchema, withSkillAdded } from "@/lib/application-data";
import { prisma } from "@/lib/prisma";
import { findOrCreateSkill } from "@/lib/profile-entries";

// "+ Add to profile" on the Job posting tab (E8-7, NEW-5): a skill the
// posting asks for and the profile lacks, added to the profile from the
// application's match. The page and the Claude connector
// (src/lib/connector/tools/documents.ts) both add it here.

export type MissingSkill = { index: number; requirement: string; skill: string };

/** The requirements "+ Add to profile" can add: gaps the posting names as a skill, by their place in the match. */
export function missingSkills(match: unknown, extracted: unknown): MissingSkill[] {
  const parsed = matchSchema.safeParse(match);
  const read = extractedSchema.safeParse(extracted);
  if (!parsed.success || !read.success) return [];
  return parsed.data.items.flatMap((item, index) => {
    const requirement = read.data.requirements[index];
    return item.result === "gap" && requirement?.kind === "skill" && requirement.skill ? [{ index, requirement: item.requirement, skill: requirement.skill }] : [];
  });
}

/**
 * Adds the skill of the match's requirement at `index` to the profile, and
 * the requirement becomes partly covered. Returns the skill's name as the
 * profile has it.
 */
export async function addMissingSkill(applicationId: string, index: number): Promise<{ name: string }> {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { match: true, extracted: true } });
  if (!application) throw new ActionError("That application no longer exists.");
  const missing = missingSkills(application.match, application.extracted).find((entry) => entry.index === index);
  if (!missing) throw new ActionError("That requirement can't be added to your profile. Reload the page to see what's there now.");

  const { skill } = await findOrCreateSkill(missing.skill.trim());
  const items = matchSchema.parse(application.match).items.map((entry, position) => (position === index ? withSkillAdded(entry, skill.name) : entry));
  await prisma.application.update({ where: { id: applicationId }, data: { match: { items } } });
  return { name: skill.name };
}
