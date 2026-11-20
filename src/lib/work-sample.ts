import { z } from "zod";

// The work sample (jobauto fork): "My first 90 days" for one job, a page
// that shows how she'd do the work instead of saying she can. For a
// candidate whose German is still growing, it moves the reader from her
// language to her competence. Written in the letter's language from the
// posting and her profile only; kept on the application (Application.workSample).

export const workSampleSchema = z.object({
  /** e.g. "My first 90 days as Regulatory Reporting Analyst at Acme". */
  title: z.string(),
  /** What the job is there to fix or run, as the posting suggests, in two or three sentences. */
  situation: z.string(),
  /** Three phases, each with a few concrete steps. */
  phases: z.array(z.object({ heading: z.string(), steps: z.array(z.string()) })),
  /** Where she has done it before: from her own roles only. */
  proof: z.array(z.string()),
  /** One closing line. */
  closing: z.string(),
  /** Claims the profile, the posting and her facts don't back (fact guard). */
  unverified: z.array(z.string()).default([]),
  /** Put it after the resume in the Bewerbungsmappe. */
  inMappe: z.boolean().default(false),
});
export type WorkSample = z.output<typeof workSampleSchema>;

/** The stored work sample, or null when there is none or it doesn't read. */
export function workSampleOf(value: unknown): WorkSample | null {
  const parsed = workSampleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The background job's key, to find a work sample being written after a reload. */
export const workSampleJobKey = (applicationId: string) => `work-sample:${applicationId}`;
