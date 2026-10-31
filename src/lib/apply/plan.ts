import type { PostingSource } from "@/generated/prisma/enums";

import { detectAts, hostOf, type AtsInfo } from "./ats";
import { applyEmailIn } from "./email-detect";

// Where an application goes (Phase A): the employer's own form in the
// browser, an email address the posting names, or nowhere Dossier can
// take it. Decided from what the application saved: its link and the
// posting's text.

export type ApplyPlan =
  | { kind: "web"; url: string; host: string; ats: AtsInfo }
  | { kind: "email"; to: string }
  | { kind: "none" };

/**
 * The route for an application. A link to the employer's own page or a
 * known ATS wins; an address in the posting's text comes next, since a
 * board's link (StepStone, Indeed, the Bundesagentur) usually means
 * logging in there, which an email avoids; a board's link is the last
 * resort, and nothing at all means the user applies by hand.
 */
export function planFor({
  postingUrl,
  postingText,
  posting,
}: {
  postingUrl: string;
  postingText: string;
  posting: { url: string; source: PostingSource } | null;
}): ApplyPlan {
  const url = [postingUrl, posting?.url ?? ""].find((link) => /^https?:\/\//i.test(link)) ?? "";
  const ats = detectAts(url);
  const email = applyEmailIn(postingText);
  if (url && !ats.board) return { kind: "web", url, host: hostOf(url), ats };
  if (email) return { kind: "email", to: email };
  if (url) return { kind: "web", url, host: hostOf(url), ats };
  return { kind: "none" };
}
