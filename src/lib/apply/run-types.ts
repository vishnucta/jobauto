import { z } from "zod";

// The JSON columns of an ApplyAttempt (Phase A), shared with the browser.

/** One filled field, for the Apply tab; contact details and the letter show without their value. */
export const filledSchema = z.array(z.object({ label: z.string(), what: z.string(), value: z.string(), byAi: z.boolean().optional() }));
export type Filled = z.infer<typeof filledSchema>;

/** One field left to the user. */
export const unfilledSchema = z.array(z.object({ label: z.string(), required: z.boolean(), reason: z.string() }));
export type UnfilledList = z.infer<typeof unfilledSchema>;
