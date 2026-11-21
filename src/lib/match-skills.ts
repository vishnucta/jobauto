import "server-only";

import { ActionError } from "@/lib/action";
import { addableSkill, extractedSchema, matchSchema, withSkillAdded } from "@/lib/application-data";
import { prisma } from "@/lib/prisma";
import { findOrCreateSkill } from "@/lib/profile-entries";
import { applicationProfileId } from "@/lib/profiles";

// "+ Add to profile" on the Job posting tab (E8-7, NEW-5): a skill the
// posting asks for and the profile lacks, added to the profile from the
// application's match. The page and the Claude connector
// (src/lib/connector/tools/documents.ts) both add it here.

export type MissingSkill = { index: number; requirement: string; skill: string };

/**
 * The requirements "+ Add to profile" can add: gaps with a skill to add, by
 * their place in the match. The skill is the scoring engine's, or the
 * extracted requirement's in a match from before (addableSkill, #439).
 */
export function missingSkills(match: unknown, extracted: unknown): MissingSkill[] {
  const parsed = matchSchema.safeParse(match);
  const read = extractedSchema.safeParse(extracted);
  if (!parsed.success) return [];
  return parsed.data.items.flatMap((item, index) => {
    const skill = item.result === "gap" ? addableSkill(item, read.success ? read.data.requirements[index] : undefined)?.trim() : undefined;
    return skill ? [{ index, requirement: item.requirement, skill }] : [];
  });
}

/**
 * Adds the skill of the match's requirement at `index` to the profile the
 * application was made from (E24-6). Given the role it was used in (E30-5),
 * the skill is linked to that role, `did` becomes a line of its points, and
 * the requirement is covered there; without one it becomes partly covered.
 * Returns the skill's name as the profile has it, and where it was used.
 */
export async function addMissingSkill(
  applicationId: string,
  index: number,
  { experienceId, did }: { experienceId?: string | null; did?: string } = {},
): Promise<{ name: string; where: string; experienceId: string | null }> {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { match: true, extracted: true } });
  if (!application) throw new ActionError("That application no longer exists.");
  const missing = missingSkills(application.match, application.extracted).find((entry) => entry.index === index);
  if (!missing) throw new ActionError("That requirement can't be added to your profile. Reload the page to see what's there now.");

  const profileId = await applicationProfileId(applicationId);
  const role = experienceId ? await prisma.experience.findFirst({ where: { id: experienceId, profileId }, select: { id: true, company: true, role: true, bullets: true } }) : null;
  if (experienceId && !role) throw new ActionError("That role is no longer in your profile. Reload the page to see what's there now.");
  const { skill } = await findOrCreateSkill(profileId, missing.skill);
  if (role) {
    await prisma.experienceSkill.upsert({ where: { experienceId_skillId: { experienceId: role.id, skillId: skill.id } }, create: { experienceId: role.id, skillId: skill.id }, update: {} });
    const line = did?.trim();
    if (line) await prisma.experience.update({ where: { id: role.id }, data: { bullets: role.bullets.trim() ? `${role.bullets.trimEnd()}\n${line}` : line } });
  }
  const where = role ? role.company.trim() || role.role.trim() : "";
  const items = matchSchema.parse(application.match).items.map((entry, position) =>
    position !== index ? entry : role ? { ...entry, result: "covered" as const, skill: skill.name, experienceIds: [role.id], note: where ? `At ${where}` : "In a role" } : withSkillAdded(entry, skill.name),
  );
  await prisma.application.update({ where: { id: applicationId }, data: { match: { items } } });
  return { name: skill.name, where, experienceId: role?.id ?? null };
}
