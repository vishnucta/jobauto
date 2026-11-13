import { z } from "zod";

import { boardFor } from "./boards";

// An employer whose careers page is followed, as the screen, its actions and
// the connector take and show it (store.ts keeps them).

/** What the user gives for an employer: the form's fields, and add_employer's. */
export const employerFields = z.object({
  name: z.string().trim().max(120).default(""),
  careersUrl: z
    .string()
    .trim()
    .min(1, "Paste the careers page's address first.")
    .max(2000)
    .refine((url) => boardFor(url) !== null, "That isn't a web address. It starts with https://."),
  keywords: z.string().trim().max(500).default(""),
  places: z.string().trim().max(300).default(""),
  notes: z.string().trim().max(2000).default(""),
});
export type EmployerFields = z.input<typeof employerFields>;

/** An employer as the screen and the connector show it. */
export type EmployerView = {
  id: string;
  name: string;
  careersUrl: string;
  /** The job system its page runs on, e.g. "personio". */
  ats: string;
  keywords: string;
  places: string;
  enabled: boolean;
  notes: string;
  lastCheckedAt: string | null;
  lastMatched: number;
  lastNew: number;
  problem: string | null;
};
