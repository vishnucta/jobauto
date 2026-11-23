import { detectAts, hostOf, type AtsInfo } from "./ats";
import { applyEmailIn } from "./email-detect";
import { linkOwner, type LinkOwner } from "./link-owner";

// Where an application goes (Phase A): the employer's own form in the
// browser, an email address the posting names, or nowhere Dossier can
// take it. Decided from what the application saved: its link and the
// posting's text.

export type ApplyPlan =
  | { kind: "web"; url: string; host: string; ats: AtsInfo; owner: LinkOwner | null }
  | { kind: "email"; to: string }
  | { kind: "none" };

/**
 * The route for an application. A link to the employer's own page or a
 * known ATS wins; an address in the posting's text comes next, since a
 * board's link (StepStone, Indeed, the Bundesagentur) usually means
 * logging in there, which an email avoids, and a copy of the ad on a site
 * that collects job ads (link-owner.ts) may never reach the employer; a
 * board's link or a copy is the last resort, and nothing at all means the
 * user applies by hand. `company` tells an employer's own site from a
 * site that only carries its ad.
 */
export function planFor({
  postingUrl,
  postingText,
  posting,
  company = "",
}: {
  postingUrl: string;
  postingText: string;
  posting: { url: string; source: string } | null;
  company?: string;
}): ApplyPlan {
  const url = [postingUrl, posting?.url ?? ""].find((link) => /^https?:\/\//i.test(link)) ?? "";
  const ats = detectAts(url);
  const owner = url ? linkOwner(url, company) : null;
  const email = applyEmailIn(postingText);
  if (url && !ats.board && owner?.kind !== "copy") return { kind: "web", url, host: hostOf(url), ats, owner };
  if (email) return { kind: "email", to: email };
  if (url) return { kind: "web", url, host: hostOf(url), ats, owner };
  return { kind: "none" };
}
