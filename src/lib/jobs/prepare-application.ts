import "server-only";

import { z } from "zod";

import { ActionError } from "@/lib/action";
import { planFor } from "@/lib/apply/plan";
import { postingText } from "@/lib/job-search/search";
import { logServerError } from "@/lib/log";
import { prisma } from "@/lib/prisma";

import { defineJob, findUnfinishedJobs, startJob } from "./runner";
import { writeApplication } from "./write-application";
import { writeEmailJob } from "./write-email";

// "Prepare it for me" on Find jobs (jobauto fork): one click instead of
// New application's three steps. In the background the posting is read,
// the documents are written the way the agent writes its drafts
// (write-application.ts), the application is created as a Draft, and, when
// the employer takes applications by email, the email is written too. She
// reads it when it's ready; nothing is sent.

/** The key of a posting's preparation, so a second click follows the one under way. */
export const prepareJobKey = (postingId: string) => `prepare:${postingId}`;

export const prepareApplicationJob = defineJob({
  type: "prepare-application",
  input: z.object({ postingId: z.string().min(1) }),
  result: z.object({
    applicationId: z.string().min(1),
    /** How it's sent: the employer's form, an email, or by hand. */
    route: z.enum(["web", "email", "none"]),
  }),
  async run({ postingId }, context) {
    const posting = await prisma.posting.findUnique({ where: { id: postingId } });
    if (!posting) throw new ActionError("That posting is no longer kept. Find it again and prepare it from there.");
    const text = postingText(posting);
    const plan = planFor({ postingUrl: posting.url, postingText: text, posting: { url: posting.url, source: posting.source } });
    // Prepared already, e.g. by a first run that was retried: the same application.
    if (posting.applicationId) return { applicationId: posting.applicationId, route: plan.kind };
    if (!posting.description.trim()) throw new ActionError("That posting has no text to write from. Open it and start the application step by step, with its text pasted in.");

    const applicationId = await writeApplication(
      { posting: text, postingUrl: posting.url, name: posting.company || posting.title || "the posting", claim: { kind: "prepare", postingId } },
      context,
    );

    // An employer that takes applications by email gets the email written too: one wait less.
    if (plan.kind === "email" && !context.signal.aborted) {
      try {
        await writeEmailJob.run({ applicationId, to: plan.to }, context);
      } catch (error) {
        // The application is ready all the same; the Email tab writes it on request.
        if (!context.signal.aborted) logServerError("prepare application: email", error);
      }
    }
    return { applicationId, route: plan.kind };
  },
});

/** Starts preparing a posting's application; one under way is followed, and one made already is answered with. */
export async function startPreparing(postingId: string): Promise<{ jobId: string | null; applicationId: string | null }> {
  const posting = await prisma.posting.findUnique({ where: { id: postingId }, select: { applicationId: true } });
  if (!posting) throw new ActionError("That posting is no longer kept. Find it again and prepare it from there.");
  if (posting.applicationId) return { jobId: null, applicationId: posting.applicationId };
  const [unfinished] = await findUnfinishedJobs(prepareJobKey(postingId));
  if (unfinished) return { jobId: unfinished.id, applicationId: null };
  return { jobId: await startJob(prepareApplicationJob, { postingId }, { key: prepareJobKey(postingId) }), applicationId: null };
}
