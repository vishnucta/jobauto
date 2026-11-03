"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { recruiterFields } from "@/lib/recruiters/fields";
import { addStarterRecruiters, createRecruiter, removeRecruiter, setRecruiterStatus, snoozeRecruiter, updateRecruiter } from "@/lib/recruiters/store";
import { RECRUITER_STATUSES } from "@/lib/recruiters/types";

// The Recruiters screen's actions. Nothing here sends anything: a message is
// drafted on the screen and the user sends it from their own mail.

const GONE = "That recruiter is no longer in the list. Reload the page.";

const id = z.string().min(1).max(64);
const fields = recruiterFields;

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
