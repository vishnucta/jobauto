import "server-only";

import { ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";

import { adCopySite } from "./link-owner";
import { planFor, type ApplyPlan } from "./plan";

// The employer's own posting for an application (jobauto fork, "Apply at the
// source"): when its link is a copy of the ad on a site that collects job ads
// (link-owner.ts), she finds the posting on the employer's site or its job
// system and pastes the link here, from the Apply tab or through Claude. The
// application's link becomes that one, and the way to send it is worked out
// again from it. The posting Positions keeps is left as it was found.

/** The pasted link, checked: a whole web address, and not another copy of the ad. */
function checkedLink(link: string): string {
  const url = link.trim();
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url) || url.length > 2000) throw new ActionError("Paste the whole link, starting with https://.");
  const copy = adCopySite(url);
  if (copy) throw new ActionError(`That link is a copy of the ad too, on ${copy}. Look for the posting on the employer's own site or its job system.`);
  return url;
}

/** Saves the employer's own link for an application and returns how it is sent now. */
export async function setPostingLink(applicationId: string, link: string): Promise<ApplyPlan> {
  const url = checkedLink(link);
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { postingText: true, company: true } });
  if (!application) throw new ActionError("That application no longer exists.");
  await prisma.application.update({ where: { id: applicationId }, data: { postingUrl: url } });
  return planFor({ postingUrl: url, postingText: application.postingText, posting: null, company: application.company });
}

/** What the new link means for sending it, in a line for the toast and the connector. */
export function newRouteLine(plan: ApplyPlan): string {
  if (plan.kind === "email") return "The posting asks for applications by email: the Email tab writes it.";
  if (plan.kind === "none") return "Saved.";
  if (plan.ats.board) return `The posting is on a job board (${plan.host}): apply there with the Bewerbungsmappe.`;
  if (plan.owner?.kind === "unsure") return `It goes to ${plan.host} now. If that's the employer's own site, the Apply tab fills in its form.`;
  if (plan.owner?.kind === "agency") return `It goes to ${plan.owner.site}'s own site now: the Apply tab fills in its form.`;
  return `It goes to the employer's own page now (${plan.host}): the Apply tab fills in its form.`;
}
