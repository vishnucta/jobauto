import { z } from "zod";

import type { Unit } from "@/lib/application-data";
import { sameName, type ProfileData } from "@/lib/profile";
import { skillNamesIn } from "@/lib/skill-groups";

// How well an application's tailored resume fits its posting (#370), scored on
// request by the scorer in Settings → Scoring: Jev, or the AI model. It reads
// the resume as a profile: the profile's own entries, with the tailored text.

/** Application.resumeFit */
export const resumeFitSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()),
  redFlags: z.array(z.string()),
  /** The scorer and its version, e.g. "score-posting@2" or "score-posting-jev@1". */
  scoredWith: z.string(),
  scoredAt: z.iso.datetime(),
});
export type ResumeFit = z.infer<typeof resumeFitSchema>;

/**
 * The tailored resume as a profile, for a scorer: what the resume says, and
 * nothing it left out. Its summary, the roles, projects, degrees,
 * certifications and publications it has, with its text, and the skills it
 * lists. Facts about the candidate aren't on a resume, so they're left out.
 */
export function tailoredProfile(profile: ProfileData, units: Unit[]): ProfileData {
  const text = (id: string) => units.find((unit) => unit.id === id)?.text;
  const listed = (prefix: string) => (entry: { id: string }) => text(`${prefix}${entry.id}`) !== undefined;
  const skills = text("skills");
  const skillNames = skills === undefined ? null : skillNamesIn(skills);
  return {
    ...profile,
    basics: { ...profile.basics, summary: text("summary") ?? "" },
    experience: profile.experience.filter(listed("experience:")).map((entry) => ({ ...entry, bullets: text(`experience:${entry.id}`)! })),
    projects: profile.projects.filter(listed("project:")).map((entry) => ({ ...entry, bullets: text(`project:${entry.id}`)! })),
    education: profile.education.filter(listed("education:")).map((entry) => ({ ...entry, notes: text(`education:${entry.id}`)! })),
    certifications: profile.certifications.filter(listed("certification:")),
    publications: profile.publications.filter(listed("publication:")),
    skills: skillNames === null ? profile.skills : profile.skills.filter((skill) => skillNames.some((name) => sameName(name, skill.name))),
    facts: [],
  };
}
