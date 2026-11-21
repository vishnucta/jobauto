"use client";

import Link from "next/link";

import type { SendStep } from "@/lib/apply/send-step";
import { missingWords } from "@/lib/letter-availability";

import { ANSWERS_HREF } from "./apply-tab";
import type { Tab } from "./tabs";

/**
 * How a draft goes out, in one line under its header (jobauto fork): the
 * way this employer takes applications and what marks it sent. Its one
 * button is the header's next step (send-step.ts), so the guide, the
 * header and the Apply tab say the same thing. What the posting asks the
 * letter to state that has no standard answer yet comes first.
 */
export function SendGuide({ step, letterAsks, onTab }: { step: SendStep; letterAsks: readonly ("salary" | "start")[]; onTab: (tab: Tab) => void }) {
  return (
    <section aria-label="How to send this application" className="flex-none border-b border-line bg-card px-10 py-2.5 text-meta text-pretty max-sm:px-4">
      {letterAsks.length > 0 && (
        <p className="text-warning">
          The posting asks for {missingWords(letterAsks)}:{" "}
          <Link href={ANSWERS_HREF} className="underline underline-offset-2">
            add {letterAsks.length > 1 ? "them" : "it"} to your standard answers
          </Link>{" "}
          before you send it.
        </p>
      )}
      <p className="text-muted">
        <span className="font-medium text-ink">How to send it: </span>
        {step.how} {step.after.includes("Email tab") ? <AfterWithTab after={step.after} onTab={onTab} /> : step.after}
      </p>
    </section>
  );
}

/** "… press Mark as sent on the Email tab.", with the Email tab a button. */
function AfterWithTab({ after, onTab }: { after: string; onTab: (tab: Tab) => void }) {
  const [before, rest] = after.split("Email tab");
  return (
    <>
      {before}
      <button type="button" className="underline underline-offset-2 hover:text-ink" onClick={() => onTab("email")}>
        Email tab
      </button>
      {rest}
    </>
  );
}
