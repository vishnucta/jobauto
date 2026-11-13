import "server-only";

import { z } from "zod";

import { DocumentKind } from "@/generated/prisma/enums";
import { AiError } from "@/lib/ai/errors";
import { unitsSchema } from "@/lib/application-data";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { sectionLayoutSchema, withoutSectionsOff } from "@/lib/resume-sections";
import { resumeFitSchema, tailoredProfile, type ResumeFit } from "@/lib/resume-fit";
import { loadPostingScorer } from "@/lib/scoring";
import { loadSettings } from "@/lib/settings-data";

import { defineJob } from "./runner";

/** The key of scoring an application's resume, to find it again after a reload. */
export const scoreResumeJobKey = (applicationId: string) => `resume-score:${applicationId}`;

/**
 * Score / Score again (#370): how well the application's tailored resume, as
 * it is now, fits its posting, by the scorer in Settings → Scoring (Jev, or
 * the AI model). Kept on the application until it's scored again.
 */
export const scoreResumeJob = defineJob({
  type: "score-resume",
  input: z.object({ applicationId: z.string().min(1) }),
  result: resumeFitSchema,
  async run({ applicationId }, { step, signal }) {
    await step("Scoring the resume");
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: applicationId },
      include: { documents: { where: { kind: DocumentKind.RESUME }, select: { units: true } } },
    });
    const units = unitsSchema.safeParse(application.documents[0]?.units);
    // Said as it is, like an AI provider that isn't set up.
    if (!units.success) throw AiError.config("This application has no tailored resume to score. Write it first.");

    const [fullProfile, settings, score] = await Promise.all([loadProfile(), loadSettings(), loadPostingScorer()]);
    const sections = sectionLayoutSchema.safeParse(application.sections);
    const profile = tailoredProfile(withoutSectionsOff(fullProfile, sections.success ? sections.data : settings.resumeSections), units.data);
    const { data, scoredWith } = await score(
      {
        title: application.role || application.title,
        company: application.company,
        place: application.location,
        remote: /\bremote\b/i.test(`${application.mode} ${application.location}`) ? true : null,
        salary: application.salary,
        description: application.postingText,
      },
      profile,
      signal,
    );
    const fit: ResumeFit = { ...data, scoredWith, scoredAt: new Date().toISOString() };
    await prisma.application.update({ where: { id: applicationId }, data: { resumeFit: fit } });
    return fit;
  },
});
