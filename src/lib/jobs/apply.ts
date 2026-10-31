import "server-only";

import { z } from "zod";

import { ApplyAttemptStatus } from "@/generated/prisma/enums";
import { runApplyAttempt } from "@/lib/apply/run";

import { defineJob } from "./runner";

/** The key of an application's apply run, to find it again after a page reload. */
export const applyJobKey = (applicationId: string) => `apply:${applicationId}`;

/**
 * The apply assistant (Phase A): opens the employer's page in the visible
 * browser, fills the form and attaches the PDFs, then hands over to the
 * user. How it went is on the ApplyAttempt row; the job itself only fails
 * when it's cancelled.
 */
export const applyJob = defineJob({
  type: "apply",
  input: z.object({ applicationId: z.string().min(1), attemptId: z.string().min(1) }),
  result: z.object({ attemptId: z.string(), status: z.enum(ApplyAttemptStatus), note: z.string() }),
  async run({ attemptId }, context) {
    const outcome = await runApplyAttempt(attemptId, context);
    return { attemptId, ...outcome };
  },
});

export type ApplyJobResult = z.infer<typeof applyJob.result>;
