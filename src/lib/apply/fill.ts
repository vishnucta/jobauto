import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright-core";

import type { FieldAdvice, FieldForAdvice } from "@/lib/ai/tasks/plan-apply-form";

import { applyAdvice, fieldsForAdvice } from "./advice";
import { PRIVATE_KEYS, type AnswerSet } from "./answers";
import { looksLikeCaptcha } from "./confirmation";
import { applyDir, SCREENSHOTS } from "./files";
import { describeKey, planFill, type FileKind, type FillAction, type FillPlan, type FormControl } from "./fields";
import { executeFill, frameUrls } from "./form";
import type { Filled, UnfilledList } from "./run-types";

// Filling the page in front of the assistant (jobauto fork): the matcher's plan,
// the model's advice on what it left, and typing, ticking and attaching, with
// no database and no job runner. The first run on a posting's form and "Fill
// this page" on any later page both go through here, so a page is filled the
// same way whichever started it.

export type PageFillContext = {
  attemptId: string;
  answers: AnswerSet;
  /** The printed PDFs; null for a document the application doesn't have. */
  files: Record<FileKind, string | null>;
  /** The model's advice on the fields the matcher left, or null without one: it is a bonus, and the user fills those fields herself. */
  advise: (fields: FieldForAdvice[]) => Promise<FieldAdvice[] | null>;
  /** The names of the two steps this reports, since each caller has its own list. */
  steps: { filling: string; attaching: string };
  step: (name: string) => Promise<void>;
  signal: AbortSignal;
};

export type PageFill = {
  filled: Filled;
  unfilled: UnfilledList;
  /** A CAPTCHA stands on the page. */
  captcha: boolean;
  /** The resume went into the form, or there was none to attach. */
  cvAttached: boolean;
  /** A screenshot of the filled page was saved. */
  screenshot: boolean;
};

/** Saves a screenshot of the page into the attempt's folder; false when it can't be taken. */
export async function screenshot(page: Page, attemptId: string, name: string): Promise<boolean> {
  try {
    await mkdir(applyDir(attemptId), { recursive: true });
    await page.screenshot({ path: path.join(applyDir(attemptId), name), fullPage: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** One action as the report shows it; contact details and the letter show without their value. */
export const describeAction = (action: FillAction, byAi: Set<string>, files: Record<FileKind, string | null>): Filled[number] => {
  const ai = byAi.has(action.ref);
  switch (action.kind) {
    case "type":
      return {
        label: action.label,
        what: ai ? "Written by the AI" : describeKey(action.key),
        value: PRIVATE_KEYS.has(action.key) ? "" : action.key === "message" && !ai ? "the cover letter's text" : action.value,
        ...(ai ? { byAi: true } : {}),
      };
    case "select":
      return { label: action.label, what: ai ? "Chosen by the AI" : describeKey(action.key), value: action.text, ...(ai ? { byAi: true } : {}) };
    case "check":
      return { label: action.label, what: ai ? "Chosen by the AI" : describeKey(action.key), value: "ticked", ...(ai ? { byAi: true } : {}) };
    case "upload":
      return { label: action.label, what: "PDF", value: action.files.map((kind) => path.basename(files[kind] ?? kind)).join(", ") };
  }
};

/** The report's entries as those of page number `page` of the form. */
export const onPage = (filled: Filled, page: number): Filled => filled.map((entry) => ({ ...entry, page }));

/**
 * Fills the form on `page`, whose controls `controls` are (a scan of it):
 * what the matcher knows, then what the model advises for the rest, typed
 * first and the PDFs attached after. A field that won't take its value is
 * reported, not fatal. The caller has checked the page is encrypted and not a
 * bot check; this only reads and types.
 */
export async function fillPage(page: Page, controls: readonly FormControl[], { attemptId, answers, files, advise, steps, step, signal }: PageFillContext): Promise<PageFill> {
  await step(steps.filling);
  let plan: FillPlan & { byAi: Set<string> } = { ...planFill(controls, answers, { cv: Boolean(files.cv), coverLetter: Boolean(files.coverLetter) }), byAi: new Set() };
  const toAdvise = fieldsForAdvice(plan, controls);
  const advice = toAdvise.length > 0 ? await advise(toAdvise) : null;
  if (advice) plan = applyAdvice(plan, advice, controls, answers);
  const typed = await executeFill(page, plan.actions.filter((action) => action.kind !== "upload"), files);
  signal.throwIfAborted();

  await step(steps.attaching);
  const uploaded = await executeFill(page, plan.actions.filter((action) => action.kind === "upload"), files);
  const filled: Filled = [...typed.done, ...uploaded.done].map((action) => describeAction(action, plan.byAi, files));
  const unfilled: UnfilledList = [
    ...plan.unfilled.map(({ label, required, reason }) => ({ label, required, reason })),
    ...[...typed.failed, ...uploaded.failed].map(({ action }) => ({ label: action.label, required: false, reason: "the field didn't take it" })),
  ];
  const captcha = looksLikeCaptcha({ html: await page.content().catch(() => ""), frameUrls: frameUrls(page) });
  return {
    filled,
    unfilled,
    captcha,
    cvAttached: !files.cv || uploaded.done.some((action) => action.kind === "upload" && action.files.includes("cv")),
    screenshot: await screenshot(page, attemptId, SCREENSHOTS.filled),
  };
}
