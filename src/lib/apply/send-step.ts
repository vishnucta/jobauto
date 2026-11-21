import type { ApplyPlanView } from "./view";

// One send path (jobauto fork, audit round 2): the send guide decides how a
// draft goes out, from the route the posting gives (plan.ts), and that one
// step is the application header's button, with one line under the header
// saying how. The Apply tab offers its assistant only for the form channel.
// Shared with the browser: nothing here reads the database.

/** How this employer takes applications: an email, its own form, a job board, or nothing Dossier can tell. */
export type SendChannel = "email" | "form" | "board" | "none";

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

/** The channel of a route: the employer's own form, or a job board, for a link. */
export function sendChannel(plan: ApplyPlanView): SendChannel {
  if (plan.kind === "web") return plan.board ? "board" : "form";
  return plan.kind;
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
      if (!plan.board) {
        return {
          channel: "form",
          how: waitingInBrowser
            ? "Its form is filled in and waiting in the browser window: check it there and press Send."
            : `This employer takes applications on its own page (${plan.atsLabel && plan.atsLabel !== plan.host && plan.atsLabel !== "the employer's website" ? `${plan.atsLabel}, ` : ""}${plan.host})${plan.account ? ", which asks for an account first" : ""}.`,
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
