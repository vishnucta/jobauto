import "server-only";

import { z } from "zod";

import { defineJob } from "@/lib/jobs/runner";
import { writeApplication } from "@/lib/jobs/write-application";

// A draft application asked for from Claude chat (#221, draft_application),
// written by Dossier's own AI model from a posting Positions doesn't keep: a
// link or pasted text. A posting Positions keeps goes through Prepare it for
// me instead (prepare-application.ts), so it gets one application. Both write
// with the one writer, write-application.ts: read the posting, write the
// documents and create a Draft application. Nothing is sent.

export const connectorDraftJob = defineJob({
  type: "connector-draft",
  input: z.object({
    posting: z.string().trim().min(1).max(100_000),
    /** A checked http(s) link, or "". */
    postingUrl: z.string().max(2000),
    note: z.string().max(2000),
    /** Kept by Positions: drafts from before round 2 of the audit had one; new ones go through Prepare it for me. */
    postingId: z.string().nullable(),
    /** The profile it's written from (E24-6); the first when it's missing. */
    profileId: z.string().min(1).nullable().default(null),
  }),
  result: z.object({ applicationId: z.string().min(1) }),
  async run({ posting, postingUrl, note, postingId, profileId }, context) {
    const applicationId = await writeApplication(
      {
        posting,
        postingUrl,
        name: "the posting",
        // This job claims it, as New application's write job does, so a retry can't make two.
        claim: { kind: "manual", writeJobId: context.id, readJobId: context.id, postingId },
        profileId,
        note,
      },
      context,
    );
    return { applicationId };
  },
});
