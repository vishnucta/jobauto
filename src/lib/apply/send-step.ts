import type { ApplyPlanView } from "./view";

// One send path (jobauto fork, audit round 2): the send guide decides how a
// draft goes out, from the route the posting gives (plan.ts), and that one
// step is the application header's button, with one line under the header
// saying how. The Apply tab offers its assistant only for the form channel.
// Shared with the browser: nothing here reads the database.

/** How this employer takes applications: an email, its own form, a job board, nothing Dossier can tell, or not yet known because the link is a copy of the ad (link-owner.ts). */
export type SendChannel = "email" | "form" | "board" | "none" | "copy";

export type SendStep = {
  channel: SendChannel;
  /** One line: how this employer takes applications. */
  how: string;
  /** The header's one button: short, to fit beside the status on a phone. */
  label: string;
  /** Where the button goes: a tab of the application, or the posting's own page in a new tab. */
  target: { tab: "email" | "apply" | "posting" } | { href: string };
  /** What marks it sent once it's out. */
  after: string;
};

/** The channel of a route: the employer's own form, a job board, or a copy of the ad, for a link. */
export function sendChannel(plan: ApplyPlanView): SendChannel {
  if (plan.kind === "web") return plan.owner?.kind === "copy" ? "copy" : plan.board ? "board" : "form";
  return plan.kind;
}

/** Whose own page the form is on, as the guide says it: "its own page (Personio, ledgerly.de)", an agency's, or one to check. */
function formWhere(plan: Extract<ApplyPlanView, { kind: "web" }>): string {
  const system = plan.atsLabel && plan.atsLabel !== plan.host && plan.atsLabel !== "the employer's website" ? `${plan.atsLabel}, ` : "";
  const account = plan.account ? ", which asks for an account first" : "";
  if (plan.owner?.kind === "agency") return `The posting is on ${plan.owner.site}'s own site (${plan.host}): applying there reaches the consultant who holds the role${account}.`;
  if (plan.owner?.kind === "unsure") {
    return `The link is on ${plan.host}, which doesn't look like the employer's own site. If it is, fill in its form; if it's a copy of the ad, find the employer's posting on the Apply tab.`;
  }
  return `This employer takes applications on its own page (${system}${plan.host})${account}.`;
}

/**
 * The draft's next step, from its route. `gmailSends` says whether the
 * Email tab can send it (Google connected with send permission): without
 * it, nothing mentions Gmail.
 */
export function sendStep(
  plan: ApplyPlanView,
  { hasEmail, waitingInBrowser, gmailSends }: { hasEmail: boolean; waitingInBrowser: boolean; gmailSends: boolean },
): SendStep {
  const markIt = "press Mark as sent on the Email tab";
  switch (plan.kind) {
    case "email":
      return {
        channel: "email",
        how: `This employer takes applications by email, to ${plan.to}.`,
        label: hasEmail ? "Send the email" : "Write the email",
        target: { tab: "email" },
        after: gmailSends ? "Sending it with Gmail marks it sent." : `Send it from your own mail with the PDFs attached, then ${markIt}.`,
      };
    case "web":
      if (plan.owner?.kind === "copy") {
        return {
          channel: "copy",
          how: `This link is a copy of the ad on ${plan.owner.site} (${plan.host}), a site that collects other sites' job ads, not the employer's own posting. What's sent there may reach the employer late, or not at all.`,
          label: "Find the employer's posting",
          target: { tab: "apply" },
          after: "Find the posting on the employer's own site, paste its link on the Apply tab, and the way to send it is worked out again.",
        };
      }
      if (!plan.board) {
        return {
          channel: "form",
          how: waitingInBrowser ? "Its form is filled in and waiting in the browser window: check it there and press Send." : formWhere(plan),
          label: waitingInBrowser ? "See what was filled in" : "Fill in its form",
          target: { tab: "apply" },
          after: `Sending it through the form marks it sent. Sent it another way? ${markIt[0].toUpperCase()}${markIt.slice(1)}.`,
        };
      }
      return {
        channel: "board",
        how: `The posting is on a job board (${plan.host}). Apply there, and upload the Bewerbungsmappe: your letter, resume and Anlagen in one PDF.`,
        label: "Apply on the job board",
        target: { href: plan.url },
        after: `Once it's sent, ${markIt}.`,
      };
    case "none":
      return {
        channel: "none",
        how: "The posting gives no link or address Dossier can use. Send the Bewerbungsmappe the way the posting says.",
        label: "Read the posting",
        target: { tab: "posting" },
        after: `Once it's sent, ${markIt}.`,
      };
  }
}

/**
 * The tab Send on a card or a list row opens (start=send): the one the
 * step's button opens. A job board's link is the guide's own button, above
 * the documents, so that opens on the documents.
 */
export function sendTab(plan: ApplyPlanView): "email" | "apply" | "posting" | "resume" {
  const { target } = sendStep(plan, { hasEmail: false, waitingInBrowser: false, gmailSends: false });
  return "tab" in target ? target.tab : "resume";
}
