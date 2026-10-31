import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright-core";
import type { Prisma } from "@/generated/prisma/client";
import { ApplicationStatus, ApplyAttemptStatus, DocumentKind } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { isAiConfigured } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { planApplyForm } from "@/lib/ai/tasks/plan-apply-form";
import { unitsSchema } from "@/lib/application-data";
import { env } from "@/lib/env";
import { resolveFileName } from "@/lib/file-name";
import type { JobContext } from "@/lib/jobs/runner";
import { isParagraph } from "@/lib/letter-frame";
import { logServerError } from "@/lib/log";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { applyStatusChange } from "@/lib/status-changes";

import { applyAdvice, fieldsForAdvice } from "./advice";
import { buildAnswerSet, PRIVATE_KEYS } from "./answers";
import { applyContext } from "./browser";
import { looksLikeCaptcha, looksSubmitted } from "./confirmation";
import { describeKey, planFill, type FillAction, type FileKind, type FillPlan } from "./fields";
import { clickApplyEntry, clickSubmit, dismissCookieBanner, executeFill, formStillThere, frameUrls, hasForm, pageText, scanControls } from "./form";
import { planFor } from "./plan";
import type { Filled, UnfilledList } from "./run-types";
import { APPLY_STEPS } from "./steps";

// One run of the apply assistant (Phase A): the application's PDFs are
// printed, the employer's page opens in the visible browser, the form is
// read and filled as far as the answers and the model allow, the PDFs are
// attached, and then the user takes over: she checks the window and
// presses Send, and a watcher notices the confirmation and moves the
// application to Sent. With auto-submit on and a system where that's
// safe, Send is pressed for her. Every outcome is written to the
// ApplyAttempt row the Apply tab shows.

/** Where an attempt's PDFs and screenshots are kept. */
export const applyDir = (attemptId: string) => path.join(env.DOSSIER_DATA_DIR, "apply", attemptId);
/** The browser's own profile, kept between runs. */
export const applyProfileDir = () => path.join(env.DOSSIER_DATA_DIR, "apply-browser");
export const SCREENSHOTS = { filled: "filled.png", confirmation: "confirmation.png" } as const;


export type ApplyOutcome = { status: ApplyAttemptStatus; note: string };

const NOTES = {
  gone: "That run no longer exists.",
  email: (to: string) => `This posting asks for applications by email (${to}). Use the Email tab instead.`,
  noLink: "There's no link to apply at. Add the posting's link on the Job posting tab, or apply by hand.",
  cantOpen: "The page couldn't be opened. Check the link on the Job posting tab, or open it yourself in the browser window.",
  noForm: "I couldn't find an application form on this page: it may want you to sign in first, or the form may open differently. The page is open in the browser window: carry on there, and I'll notice when it's sent.",
  captcha: "Everything I could fill in is filled in. There's a CAPTCHA on the page, so you need to answer it and press Send yourself. I'll notice when it's sent.",
  required: "Filled in as far as I could. Fill in the fields marked below in the browser window, check the rest, and press Send. I'll notice when it's sent.",
  check: "Filled in. Check everything in the browser window, then press Send there. I'll notice when it's sent.",
  pressed: "I pressed Send, but didn't see a confirmation. Check the browser window: if it asks for anything more, finish it there.",
  sent: "Sent: the page confirmed your application.",
  closed: "The browser tab was closed before I saw a confirmation. If you did send it, mark it as sent below.",
  timeout: "I stopped watching after 45 minutes without a confirmation. If you did send it, mark it as sent below.",
  broke: "Something went wrong while working the page. The browser window is still open: you can carry on there, or try again.",
  cancelled: "Cancelled.",
} as const;

const WATCH_INTERVAL_MS = 2_500;
const WATCH_FOR_MS = 45 * 60_000;
const AUTO_SUBMIT_WAIT_MS = 20_000;

// Attempts waiting on the user, with the page to watch. On globalThis so
// the dev server's hot reloads keep them.
type Watch = { page: Page; timer: ReturnType<typeof setInterval> };
const globalForWatch = globalThis as unknown as { applyWatches?: Map<string, Watch> };
const watches: Map<string, Watch> = (globalForWatch.applyWatches ??= new Map());

async function update(attemptId: string, data: Prisma.ApplyAttemptUpdateInput): Promise<void> {
  await prisma.applyAttempt.updateMany({ where: { id: attemptId }, data });
}

/** Records how a run stands. A final status stops the watcher; WAITING keeps it, since the user is still at the page. */
async function end(attemptId: string, status: ApplyAttemptStatus, note: string, extra: Prisma.ApplyAttemptUpdateInput = {}): Promise<ApplyOutcome> {
  if (status !== ApplyAttemptStatus.WAITING) stopWatching(attemptId);
  await update(attemptId, { status, note, finishedAt: status === ApplyAttemptStatus.WAITING ? null : new Date(), ...extra });
  return { status, note };
}

/** Stops watching an attempt's page; the page stays open. */
export function stopWatching(attemptId: string): void {
  const watch = watches.get(attemptId);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(attemptId);
}

/** Whether the server is still watching an attempt's page. */
export function isWatching(attemptId: string): boolean {
  return watches.has(attemptId);
}

async function screenshot(page: Page, attemptId: string, name: string): Promise<boolean> {
  try {
    await mkdir(applyDir(attemptId), { recursive: true });
    await page.screenshot({ path: path.join(applyDir(attemptId), name), fullPage: true, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Marks the application sent, once: a draft moves to Sent, anything further along stays. */
async function markSent(applicationId: string): Promise<void> {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { status: true } });
  if (application?.status === ApplicationStatus.DRAFT) await applyStatusChange(prisma, applicationId, ApplicationStatus.SENT);
}

async function finishSubmitted(attemptId: string, applicationId: string, page: Page | null): Promise<ApplyOutcome> {
  const confirmation = page ? await screenshot(page, attemptId, SCREENSHOTS.confirmation) : false;
  await markSent(applicationId);
  return end(attemptId, ApplyAttemptStatus.SUBMITTED, NOTES.sent, { confirmation });
}

/** Watches the page until it confirms the application, the tab closes, or 45 minutes pass. */
function startWatching(attemptId: string, applicationId: string, page: Page): void {
  stopWatching(attemptId);
  const until = Date.now() + WATCH_FOR_MS;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        if (page.isClosed()) return void (await end(attemptId, ApplyAttemptStatus.ABANDONED, NOTES.closed));
        if (Date.now() > until) return void (await end(attemptId, ApplyAttemptStatus.ABANDONED, NOTES.timeout));
        const formGone = !(await formStillThere(page));
        const text = await pageText(page);
        if (looksSubmitted({ text, url: page.url(), formGone })) await finishSubmitted(attemptId, applicationId, page);
      } catch {
        // The page is navigating: read it again next time.
      } finally {
        busy = false;
      }
    })();
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
  watches.set(attemptId, { page, timer });
}

/** "I sent it" / "I didn't send it" on the Apply tab: ends an attempt by the user's word. */
export async function resolveAttempt(attemptId: string, sent: boolean): Promise<void> {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId }, select: { applicationId: true, status: true } });
  if (!attempt) return;
  if (sent) {
    await markSent(attempt.applicationId);
    await end(attemptId, ApplyAttemptStatus.SUBMITTED, "Sent, as you said.");
  } else {
    await end(attemptId, ApplyAttemptStatus.ABANDONED, "Not sent, as you said.");
  }
}

const describeAction = (action: FillAction, byAi: Set<string>, files: Record<FileKind, string | null>): Filled[number] => {
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

/** Prints the application's resume and letter into the attempt's folder; null for a document it doesn't have. */
async function printDocuments(attemptId: string, application: { id: string; company: string; role: string; documents: { kind: DocumentKind }[] }, profileName: string, pattern: string): Promise<Record<FileKind, string | null>> {
  const files: Record<FileKind, string | null> = { cv: null, coverLetter: null };
  await mkdir(applyDir(attemptId), { recursive: true });
  for (const [kind, doc, route] of [
    ["cv", DocumentKind.RESUME, "resume"],
    ["coverLetter", DocumentKind.COVER_LETTER, "letter"],
  ] as const) {
    if (!application.documents.some((document) => document.kind === doc)) continue;
    const pdf = await renderPdf(`/print/${route}/${application.id}`);
    const name = resolveFileName(pattern, { name: profileName, company: application.company, role: application.role, doc, date: new Date() }).replace(/[\\/:*?"<>|]/g, " ");
    const file = path.join(applyDir(attemptId), name);
    await writeFile(file, pdf);
    files[kind] = file;
  }
  return files;
}

/** One run, start to hand-over; the attempt row carries every outcome. */
export async function runApplyAttempt(attemptId: string, { step, signal }: JobContext): Promise<ApplyOutcome> {
  const attempt = await prisma.applyAttempt.findUnique({
    where: { id: attemptId },
    include: {
      application: { include: { documents: { select: { kind: true, units: true } }, posting: { select: { url: true, source: true } } } },
    },
  });
  if (!attempt) return { status: ApplyAttemptStatus.FAILED, note: NOTES.gone };
  const { application } = attempt;
  const plan = planFor({ postingUrl: application.postingUrl, postingText: application.postingText, posting: application.posting });
  if (plan.kind !== "web") return end(attemptId, ApplyAttemptStatus.FAILED, plan.kind === "email" ? NOTES.email(plan.to) : NOTES.noLink);

  let page: Page | null = null;
  try {
    await step(APPLY_STEPS[0]);
    const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
    const files = await printDocuments(attemptId, application, profile.basics.name, settings.fileNamePattern);
    const letter = unitsSchema.safeParse(application.documents.find((document) => document.kind === DocumentKind.COVER_LETTER)?.units);
    const letterParagraphs = letter.success ? letter.data.filter(isParagraph).map((unit) => unit.text) : [];
    const answers = buildAnswerSet({ basics: profile.basics, answers: settings.applyAnswers, letterParagraphs });
    signal.throwIfAborted();

    await step(APPLY_STEPS[1]);
    const context = await applyContext({ userDataDir: applyProfileDir(), channel: env.DOSSIER_BROWSER_CHANNEL });
    page = await context.newPage();
    await page.bringToFront().catch(() => {});
    try {
      await page.goto(plan.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch {
      return end(attemptId, ApplyAttemptStatus.FAILED, NOTES.cantOpen);
    }
    await page.waitForTimeout(1_500);
    await dismissCookieBanner(page);
    signal.throwIfAborted();

    await step(APPLY_STEPS[2]);
    let controls = await scanControls(page);
    for (let tries = 0; tries < 2 && !hasForm(controls); tries++) {
      const next = await clickApplyEntry(page);
      if (!next) break;
      page = next;
      await dismissCookieBanner(page);
      controls = await scanControls(page);
    }
    if (!hasForm(controls)) {
      startWatching(attemptId, application.id, page);
      return end(attemptId, ApplyAttemptStatus.WAITING, NOTES.noForm, { finishedAt: null, url: page.url().slice(0, 2000) });
    }
    signal.throwIfAborted();

    await step(APPLY_STEPS[3]);
    let fillPlan: FillPlan & { byAi: Set<string> } = { ...planFill(controls, answers, { cv: Boolean(files.cv), coverLetter: Boolean(files.coverLetter) }), byAi: new Set() };
    const toAdvise = fieldsForAdvice(fillPlan, controls);
    if (toAdvise.length > 0 && (await isAiConfigured())) {
      try {
        const [provider, options] = await Promise.all([getAiProvider(), loadTaskOptions()]);
        const { data } = await planApplyForm(
          provider,
          { fields: toAdvise, posting: application.postingText, profile, letterParagraphs, germanLevel: settings.applyAnswers.germanLevel, englishLevel: settings.applyAnswers.englishLevel },
          { ...options, signal },
        );
        fillPlan = applyAdvice(fillPlan, data, controls, answers);
      } catch (error) {
        // The model's advice is a bonus: without it, the user fills those fields themselves.
        if (!(error instanceof AiError)) throw error;
      }
    }
    const typed = await executeFill(page, fillPlan.actions.filter((action) => action.kind !== "upload"), files);
    signal.throwIfAborted();

    await step(APPLY_STEPS[4]);
    const uploaded = await executeFill(page, fillPlan.actions.filter((action) => action.kind === "upload"), files);
    const done = [...typed.done, ...uploaded.done];
    const failed = [...typed.failed, ...uploaded.failed];
    const filled: Filled = done.map((action) => describeAction(action, fillPlan.byAi, files));
    const unfilled: UnfilledList = [
      ...fillPlan.unfilled.map(({ label, required, reason }) => ({ label, required, reason })),
      ...failed.map(({ action }) => ({ label: action.label, required: false, reason: "the field didn't take it" })),
    ];
    const captcha = looksLikeCaptcha({ html: await page.content().catch(() => ""), frameUrls: frameUrls(page) });
    const shot = await screenshot(page, attemptId, SCREENSHOTS.filled);
    const cvAttached = !files.cv || uploaded.done.some((action) => action.kind === "upload" && action.files.includes("cv"));
    await update(attemptId, { filled, unfilled, captcha, screenshot: shot, url: page.url().slice(0, 2000) });

    await step(APPLY_STEPS[5]);
    const mayPress = attempt.autoSubmit && plan.ats.autoSubmit && !captcha && cvAttached && unfilled.every((entry) => !entry.required);
    if (mayPress && (await clickSubmit(page))) {
      const until = Date.now() + AUTO_SUBMIT_WAIT_MS;
      while (Date.now() < until) {
        await page.waitForTimeout(1_000);
        const formGone = !(await formStillThere(page));
        if (looksSubmitted({ text: await pageText(page).catch(() => ""), url: page.url(), formGone })) return finishSubmitted(attemptId, application.id, page);
      }
      startWatching(attemptId, application.id, page);
      return end(attemptId, ApplyAttemptStatus.WAITING, NOTES.pressed, { finishedAt: null });
    }
    startWatching(attemptId, application.id, page);
    const note = captcha ? NOTES.captcha : unfilled.some((entry) => entry.required) ? NOTES.required : NOTES.check;
    return end(attemptId, ApplyAttemptStatus.WAITING, note, { finishedAt: null });
  } catch (error) {
    if (signal.aborted) return end(attemptId, ApplyAttemptStatus.FAILED, NOTES.cancelled);
    logServerError(`apply ${attemptId}`, error);
    if (page && !page.isClosed()) startWatching(attemptId, application.id, page);
    return end(attemptId, page && !page.isClosed() ? ApplyAttemptStatus.WAITING : ApplyAttemptStatus.FAILED, NOTES.broke, { finishedAt: page && !page.isClosed() ? null : new Date() });
  }
}
