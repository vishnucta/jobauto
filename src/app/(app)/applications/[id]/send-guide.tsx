"use client";

import { Button, buttonClassName } from "@/components/ui/button";
import type { ApplyPlanView } from "@/lib/apply/view";
import { missingWords } from "@/lib/letter-availability";

import type { Tab } from "./tabs";

/**
 * The three steps of a draft, above its tabs (jobauto fork): read it, send
 * it the way this employer takes applications, and mark it sent (the
 * header's Mark as sent, which keeps the status pill right). The route
 * comes from the posting (src/lib/apply/plan.ts): the employer's own form,
 * an email address, a job board, or nothing Dossier can tell, so she never
 * has to work out which tab is the one to use.
 */
export function SendGuide({
  plan,
  hasResume,
  hasLetter,
  hasEmail,
  waitingInBrowser,
  letterAsks,
  onTab,
}: {
  plan: ApplyPlanView;
  hasResume: boolean;
  hasLetter: boolean;
  /** The application email is written. */
  hasEmail: boolean;
  /** The apply assistant filled the employer's form and waits for her to press Send there. */
  waitingInBrowser: boolean;
  /** What the posting asks the letter to state that has no standard answer yet. */
  letterAsks: readonly ("salary" | "start")[];
  onTab: (tab: Tab) => void;
}) {
  const route =
    plan.kind === "email"
      ? {
          how: `This employer takes applications by email, to ${plan.to}.`,
          action: (
            <Button size="sm" onClick={() => onTab("email")}>
              {hasEmail ? "Check the email and send it" : "Write the email"}
            </Button>
          ),
        }
      : plan.kind === "web" && !plan.board
        ? {
            how: waitingInBrowser
              ? "Its form is filled in and waiting in the browser window: check it there and press Send."
              : `This employer takes applications on its own page (${plan.atsLabel && plan.atsLabel !== plan.host ? `${plan.atsLabel}, ` : ""}${plan.host})${plan.account ? ", which asks for an account first" : ""}.`,
            action: (
              <Button size="sm" onClick={() => onTab("apply")}>
                {waitingInBrowser ? "See what was filled in" : "Fill in its form for me"}
              </Button>
            ),
          }
        : plan.kind === "web"
          ? {
              how: `The posting is on a job board (${plan.host}). Apply there, and upload the Bewerbungsmappe: your letter, resume and Anlagen in one PDF.`,
              action: (
                <a href={plan.url} target="_blank" rel="noopener noreferrer" className={buttonClassName("primary", "sm", "hover:text-on-primary")}>
                  Open the posting<span aria-hidden>↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ),
            }
          : {
              how: "The posting gives no link or address Dossier can use. Send the Bewerbungsmappe the way the posting says.",
              action: (
                <Button variant="secondary" size="sm" onClick={() => onTab("posting")}>
                  Read the posting
                </Button>
              ),
            };

  const step = "flex min-w-0 flex-[1_1_220px] flex-col gap-1.5";
  const number = "grid size-5 flex-none place-items-center rounded-full bg-primary text-[11px] font-medium text-on-primary";
  return (
    <section aria-label="How to send this application" className="flex-none border-b border-line bg-card px-10 py-3">
      <ol className="flex flex-wrap gap-x-8 gap-y-3 text-meta">
        <li className={step}>
          <p className="flex items-center gap-2 font-medium text-ink">
            <span aria-hidden className={number}>
              1
            </span>
            Read it through
          </p>
          <p className="flex flex-wrap items-center gap-2">
            {hasResume && (
              <Button variant="secondary" size="sm" onClick={() => onTab("resume")}>
                Resume
              </Button>
            )}
            {hasLetter && (
              <Button variant="secondary" size="sm" onClick={() => onTab("letter")}>
                Cover letter
              </Button>
            )}
          </p>
          {letterAsks.length > 0 && (
            <p className="text-warning">
              The posting asks for {missingWords(letterAsks)}:{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => onTab("apply")}>
                add {letterAsks.length > 1 ? "them" : "it"} to your standard answers
              </button>
              .
            </p>
          )}
        </li>
        <li className={`${step} flex-[2_1_320px]`}>
          <p className="flex items-center gap-2 font-medium text-ink">
            <span aria-hidden className={number}>
              2
            </span>
            Send it
          </p>
          <p className="text-pretty text-muted">{route.how}</p>
          <p>{route.action}</p>
        </li>
        <li className={step}>
          <p className="flex items-center gap-2 font-medium text-ink">
            <span aria-hidden className={number}>
              3
            </span>
            Once it&apos;s out
          </p>
          <p className="text-pretty text-muted">
            Sending by Gmail or through the form marks it sent for you. Sent it another way? Press <span className="font-medium text-ink">Mark as sent</span> at the top.
          </p>
        </li>
      </ol>
    </section>
  );
}
