"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { addStarterRecruiters, createRecruiter, removeRecruiter, setRecruiterStatus, snoozeRecruiter, updateRecruiter } from "@/lib/recruiters/store";
import { RECRUITER_STATUSES } from "@/lib/recruiters/types";

// The Recruiters screen's actions. Nothing here sends anything: a message is
// drafted on the screen and the user sends it from their own mail.

const GONE = "That recruiter is no longer in the list. Reload the page.";

const id = z.string().min(1).max(64);
const short = z.string().trim().max(200);

const fields = z.object({
  name: z.string().trim().min(1, "Give the agency or recruiter a name.").max(200),
  contactName: short,
  email: z.union([z.literal(""), z.email("That doesn't look like an email address.")]).transform((value) => value.trim()),
  website: z.union([z.literal(""), z.url({ protocol: /^https?$/, error: "A website starts with https://" })]),
  speciality: short,
  notes: z.string().trim().max(5_000),
});

/** "Add a recruiter". */
export const addRecruiter = action(fields, (input) => createRecruiter(input));

/** Saves the details of one. */
export const saveRecruiter = action(fields.extend({ id }), async ({ id: recruiterId, ...input }) => {
  const saved = await updateRecruiter(recruiterId, input);
  if (!saved) throw new ActionError(GONE);
  return saved;
});

/** "I wrote to them", "They replied", "Not interested" and the rest. */
export const moveRecruiter = action(z.object({ id, status: z.enum(RECRUITER_STATUSES) }), async ({ id: recruiterId, status }) => {
  const moved = await setRecruiterStatus(recruiterId, status);
  if (!moved) throw new ActionError(GONE);
  return moved;
});

/** "Snooze": a few more days before the follow-up is due. */
export const snoozeFollowUp = action(z.object({ id }), async ({ id: recruiterId }) => {
  const snoozed = await snoozeRecruiter(recruiterId);
  if (!snoozed) throw new ActionError("Only a recruiter you're waiting to hear from can be snoozed.");
  return snoozed;
});

export const deleteRecruiter = action(z.object({ id }), async ({ id: recruiterId }, { toast }) => {
  if (!(await removeRecruiter(recruiterId))) throw new ActionError(GONE);
  toast("Recruiter removed.");
  return null;
});

/** "Add suggested agencies": the starter list's agencies the list doesn't have yet. */
export const addSuggestedRecruiters = action(z.object({}), async (_input, { toast }) => {
  const added = await addStarterRecruiters();
  toast(added === 0 ? "They're all on your list already." : `Added ${added} ${added === 1 ? "agency" : "agencies"}.`);
  return { added };
});
