"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/action";
import { startCareersCheck } from "@/lib/careers/check";
import { createEmployer, employerFields, removeEmployer, setEmployerEnabled, updateEmployer } from "@/lib/careers/store";

// The Careers pages screen's actions (jobauto fork).

const GONE = "That employer is no longer in the list. Reload the page.";
const id = z.string().min(1).max(64);

/** "Follow": a careers page to check once a day. */
export const addEmployer = action(employerFields, (input) => createEmployer(input));

export const saveEmployer = action(employerFields.extend({ id }), async ({ id: employerId, ...input }) => {
  const saved = await updateEmployer(employerId, input);
  if (!saved) throw new ActionError(GONE);
  return saved;
});

/** On or off: one that's off isn't checked each day. */
export const switchEmployer = action(z.object({ id, enabled: z.boolean() }), async ({ id: employerId, enabled }) => {
  const switched = await setEmployerEnabled(employerId, enabled);
  if (!switched) throw new ActionError(GONE);
  return switched;
});

export const deleteEmployer = action(z.object({ id }), async ({ id: employerId }, { toast }) => {
  if (!(await removeEmployer(employerId))) throw new ActionError(GONE);
  toast("No longer followed. The jobs found on its page stay in Find jobs.");
  return null;
});

/** "Check now": one employer's page, or every one that's on; the screen follows the job. */
export const checkCareers = action(z.object({ ids: z.array(id).max(200).optional() }), ({ ids }) => startCareersCheck(ids));
