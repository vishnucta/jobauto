import { z } from "zod";

/** What a check of the careers pages found (check.ts), for the screen and the connector. */
export const careersCheckResultSchema = z.object({
  checked: z.number().int().min(0),
  /** Jobs new to Dossier, added to Positions. */
  added: z.number().int().min(0),
  /** The search they were added as; null when there were none. */
  searchId: z.string().nullable(),
  /** "Acme: why it failed", one for each page that couldn't be read. */
  problems: z.array(z.string()),
  message: z.string(),
});
export type CareersCheckResult = z.infer<typeof careersCheckResultSchema>;
