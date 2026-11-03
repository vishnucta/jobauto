import { z } from "zod";

// What a recruiter's details may hold. The Recruiters screen's actions and the
// connector's tools check the same rules.

const short = z.string().trim().max(200);

export const recruiterFields = z.object({
  name: z.string().trim().min(1, "Give the agency or recruiter a name.").max(200),
  contactName: short,
  email: z.union([z.literal(""), z.email("That doesn't look like an email address.")]).transform((value) => value.trim()),
  website: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "A website starts with https://" })]),
  speciality: short,
  notes: z.string().trim().max(5_000),
});
