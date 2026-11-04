import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright-core";
import type { Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus, ApplicationStatus, ApplyAttemptStatus, DocumentKind } from "@/generated/prisma/enums";
import { approveCandidate } from "@/lib/agent/draft";
import { getAiProvider } from "@/lib/ai";
import { isAiConfigured } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { planApplyForm, type FieldAdvice, type FieldForAdvice } from "@/lib/ai/tasks/plan-apply-form";
import { unitsSchema } from "@/lib/application-data";
import { env } from "@/lib/env";
import { resolveFileName } from "@/lib/file-name";
import type { JobContext } from "@/lib/jobs/runner";
import { isParagraph } from "@/lib/letter-frame";
import { logServerError } from "@/lib/log";
import { renderPdf } from "@/lib/pdf/render";
import { prisma } from "@/lib/prisma";
import type { ProfileData } from "@/lib/profile";
import { loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { applyStatusChange } from "@/lib/status-changes";

import { buildAnswerSet } from "./answers";
import { applyContext } from "./browser";
import { applyDir, applyProfileDir, SCREENSHOTS } from "./files";
import { looksBlocked, looksSubmitted } from "./confirmation";
import type { FileKind } from "./fields";
import { fillPage, onPage, screenshot } from "./fill";
import { clickApplyEntry, clickSubmit, dismissCookieBanner, formStillThere, hasForm, pageText, scanControls } from "./form";
import { planFor } from "./plan";
import { filledSchema } from "./run-types";
import { isSecure, openPreferringHttps, secured } from "./secure";
import { frontPage } from "./tabs";
import { APPLY_STEPS, FILL_STEPS } from "./steps";
import { OPEN_ATTEMPT_STATUSES } from "./view";
import { addWatch, stopWatching, watchedPage } from "./watches";

// One run of the apply assistant (Phase A): the application's PDFs are
// printed, the employer's page opens in the visible browser, the form is
// read and filled as far as the answers and the model allow, the PDFs are
// attached, and then the user takes over: she checks the window and
// presses Send, and a watcher notices the confirmation and moves the
// application to Sent. With auto-submit on and a system where that's
// safe, Send is pressed for her. Every outcome is written to the
// ApplyAttempt row the Apply tab shows.

export { isWatching, stopWatching } from "./watches";


export type ApplyOutcome = { status: ApplyAttemptStatus; note: string };

const NOTES = {
  gone: "That run no longer exists.",
  email: (to: string) => `This posting asks for applications by email (${to}). Use the Email tab instead.`,
  noLink: "There's no link to apply at. Add the posting's link on the Job posting tab, or apply by hand.",
  blocked: "The site's security check took the assistant's browser for a bot, so the page didn't load and I didn't touch it. I won't try to get around it. If the check lets you through in this window, carry on there and I'll notice when it's sent; otherwise open the page in your own browser, apply there, and mark it as sent below.",
  noFormHere: "There's no application form on the page in front of you. Get to the form in the browser window, then click Fill this page again.",
  pageRequired: "Filled in this page as far as I could. Fill in the fields marked below in the browser window and check the rest. Then go on to the next step and click Fill this page again, or press Send if this was the last. I'll notice when it's sent.",
  pageDone: "Filled in this page. Check it in the browser window. Then go on to the next step and click Fill this page again, or press Send if this was the last. I'll notice when it's sent.",
  notWatched: "I'm not watching the browser window any more (the server was restarted), so I can't fill it. Start again with Open and fill it in again, or say below how it ended.",
  insecure: "This page's address starts with http://, so it isn't encrypted, and I didn't type anything into it. Open the https:// version of the page in the browser window, or fill it in yourself: I'll notice when it's sent.",
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

async function update(attemptId: string, data: Prisma.ApplyAttemptUpdateInput): Promise<void> {
  await prisma.applyAttempt.updateMany({ where: { id: attemptId }, data });
}

/** Records how a run stands. A final status stops the watcher; WAITING keeps it, since the user is still at the page. */
async function end(attemptId: string, status: ApplyAttemptStatus, note: string, extra: Prisma.ApplyAttemptUpdateInput = {}): Promise<ApplyOutcome> {
  if (status !== ApplyAttemptStatus.WAITING) stopWatching(attemptId);
  await update(attemptId, { status, note, finishedAt: status === ApplyAttemptStatus.WAITING ? null : new Date(), ...extra });
  return { status, note };
}

/** Whether the page is a site's bot check right now. */
const blockedNow = async (page: Page) => looksBlocked({ title: await page.title().catch(() => ""), text: await pageText(page).catch(() => "") });

/** Whether the page stays a bot check: a real browser's check clears by itself within seconds, so it is given a few. */
async function stillBlocked(page: Page): Promise<boolean> {
  for (let tries = 0; tries < 4; tries++) {
    if (!(await blockedNow(page))) return false;
    await page.waitForTimeout(3_000);
  }
  return true;
}

/** Marks the application sent, once: a draft moves to Sent, anything further along stays. */
async function markSent(applicationId: string): Promise<void> {
  const application = await prisma.application.findUnique({ where: { id: applicationId }, select: { status: true } });
  if (application?.status !== ApplicationStatus.DRAFT) return;
  // A job agent draft still waiting for review is approved by moving it on, as everywhere else (#195).
  const pending = await prisma.agentCandidate.findFirst({
    where: { applicationId, status: AgentCandidateStatus.DRAFTED, application: { awaitingReview: true } },
    select: { id: true },
  });
  if (pending) await approveCandidate(pending.id);
  await applyStatusChange(prisma, applicationId, ApplicationStatus.SENT);
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
  addWatch(attemptId, { page, timer });
}

/**
 * "I sent it" / "I didn't send it" on the Apply tab: ends an attempt that's
 * still open by the user's word. False when it's gone or had already ended:
 * a run that ended keeps how it ended.
 */
export async function resolveAttempt(attemptId: string, sent: boolean): Promise<boolean> {
  const attempt = await prisma.applyAttempt.findUnique({ where: { id: attemptId }, select: { applicationId: true, status: true } });
  if (!attempt || !OPEN_ATTEMPT_STATUSES.includes(attempt.status)) return false;
  if (sent) {
    await markSent(attempt.applicationId);
    await end(attemptId, ApplyAttemptStatus.SUBMITTED, "Sent, as you said.");
  } else {
    await end(attemptId, ApplyAttemptStatus.ABANDONED, "Not sent, as you said.");
  }
  return true;
}

/**
 * The model's advice on the fields the matcher left. Null without a provider, or when it can't
 * answer: it is a bonus, and the user fills those fields herself.
 */
function adviserFor(
  input: { posting: string; profile: ProfileData; letterParagraphs: string[]; germanLevel: string; englishLevel: string },
  signal: AbortSignal,
): (fields: FieldForAdvice[]) => Promise<FieldAdvice[] | null> {
  return async (fields) => {
    if (!(await isAiConfigured())) return null;
    try {
      const [provider, options] = await Promise.all([getAiProvider(), loadTaskOptions()]);
      const { data } = await planApplyForm(provider, { fields, ...input }, { ...options, signal });
      return data;
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      return null;
    }
  };
}

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
    // https:// first: an address saved as http:// is tried as https://, and only if that doesn't answer, as it was given.
    if (!(await openPreferringHttps(page, plan.url))) return end(attemptId, ApplyAttemptStatus.FAILED, NOTES.cantOpen);
    await page.waitForTimeout(1_500);
    await dismissCookieBanner(page);
    signal.throwIfAborted();

    // A bot check isn't the page: say so, and leave the window to her.
    if (await stillBlocked(page)) {
      startWatching(attemptId, application.id, page);
      return end(attemptId, ApplyAttemptStatus.WAITING, NOTES.blocked, { finishedAt: null, url: page.url().slice(0, 2000) });
    }

    await step(APPLY_STEPS[2]);
    let controls = await scanControls(page);
    for (let tries = 0; tries < 2 && !hasForm(controls); tries++) {
      // Only the posting's own page gets a button named like Send clicked: past it, that may be Send itself.
      const next = await clickApplyEntry(page, { pastPosting: tries > 0 });
      if (!next) break;
      page = next;
      await dismissCookieBanner(page);
      controls = await scanControls(page);
    }
    if (!hasForm(controls)) {
      startWatching(attemptId, application.id, page);
      return end(attemptId, ApplyAttemptStatus.WAITING, (await blockedNow(page)) ? NOTES.blocked : NOTES.noForm, { finishedAt: null, url: page.url().slice(0, 2000) });
    }
    // Her name, address, phone and PDFs go only into an encrypted page. An http:// one is opened again as https://; if it stays http://, nothing is typed.
    const addressBefore = page.url();
    if (!(await secured(page))) {
      startWatching(attemptId, application.id, page);
      return end(attemptId, ApplyAttemptStatus.WAITING, NOTES.insecure, { finishedAt: null, url: page.url().slice(0, 2000) });
    }
    if (page.url() !== addressBefore) {
      controls = await scanControls(page);
      if (!hasForm(controls)) {
        startWatching(attemptId, application.id, page);
        return end(attemptId, ApplyAttemptStatus.WAITING, NOTES.noForm, { finishedAt: null, url: page.url().slice(0, 2000) });
      }
    }
    signal.throwIfAborted();

    const advise = adviserFor(
      { posting: application.postingText, profile, letterParagraphs, germanLevel: settings.applyAnswers.germanLevel, englishLevel: settings.applyAnswers.englishLevel },
      signal,
    );
    const fill = await fillPage(page, controls, { attemptId, answers, files, advise, steps: { filling: APPLY_STEPS[3], attaching: APPLY_STEPS[4] }, step, signal });
    await update(attemptId, { filled: onPage(fill.filled, 1), unfilled: fill.unfilled, captcha: fill.captcha, screenshot: fill.screenshot, url: page.url().slice(0, 2000) });

    await step(APPLY_STEPS[5]);
    const mayPress = attempt.autoSubmit && plan.ats.autoSubmit && !fill.captcha && fill.cvAttached && fill.unfilled.every((entry) => !entry.required);
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
    const note = fill.captcha ? NOTES.captcha : fill.unfilled.some((entry) => entry.required) ? NOTES.required : NOTES.check;
    return end(attemptId, ApplyAttemptStatus.WAITING, note, { finishedAt: null });
  } catch (error) {
    if (signal.aborted) return end(attemptId, ApplyAttemptStatus.FAILED, NOTES.cancelled);
    logServerError(`apply ${attemptId}`, error);
    if (page && !page.isClosed()) startWatching(attemptId, application.id, page);
    return end(attemptId, page && !page.isClosed() ? ApplyAttemptStatus.WAITING : ApplyAttemptStatus.FAILED, NOTES.broke, { finishedAt: page && !page.isClosed() ? null : new Date() });
  }
}

/**
 * "Fill this page": fills the page the user is looking at, in the window of a run
 * that is waiting for her, and adds what it did to that run. She has got past a
 * login or a bot check, or on to the next step of a form, herself: the
 * assistant does neither. The page is read where it stands, never reloaded, and
 * Send stays hers, whatever the standard answers say.
 */
export async function runFillThisPage(attemptId: string, { step, signal }: JobContext): Promise<ApplyOutcome> {
  const attempt = await prisma.applyAttempt.findUnique({
    where: { id: attemptId },
    include: { application: { include: { documents: { select: { kind: true, units: true } } } } },
  });
  if (!attempt) return { status: ApplyAttemptStatus.FAILED, note: NOTES.gone };
  const watched = watchedPage(attemptId);
  if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status) || !watched || watched.isClosed()) return { status: attempt.status, note: NOTES.notWatched };
  const { application } = attempt;

  let page: Page = watched;
  /** Says how it went, or why nothing was filled; the run stays as it was: waiting for her, on the page she is at. */
  const say = (note: string) => {
    startWatching(attemptId, application.id, page);
    return end(attemptId, ApplyAttemptStatus.WAITING, note, { finishedAt: null, url: page.url().slice(0, 2000) });
  };
  try {
    await step(FILL_STEPS[0]);
    page = await frontPage(watched);
    // Nothing is typed into a page that isn't encrypted, and a page isn't reloaded to make it one: she may be part-way through a form.
    if (!isSecure(page.url())) return say(NOTES.insecure);
    if (await blockedNow(page)) return say(NOTES.blocked);
    const controls = await scanControls(page);
    if (!hasForm(controls)) return say(NOTES.noFormHere);
    signal.throwIfAborted();

    const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
    const files = await printDocuments(attemptId, application, profile.basics.name, settings.fileNamePattern);
    const letter = unitsSchema.safeParse(application.documents.find((document) => document.kind === DocumentKind.COVER_LETTER)?.units);
    const letterParagraphs = letter.success ? letter.data.filter(isParagraph).map((unit) => unit.text) : [];
    const answers = buildAnswerSet({ basics: profile.basics, answers: settings.applyAnswers, letterParagraphs });
    const advise = adviserFor(
      { posting: application.postingText, profile, letterParagraphs, germanLevel: settings.applyAnswers.germanLevel, englishLevel: settings.applyAnswers.englishLevel },
      signal,
    );
    const fill = await fillPage(page, controls, { attemptId, answers, files, advise, steps: { filling: FILL_STEPS[1], attaching: FILL_STEPS[2] }, step, signal });

    await step(FILL_STEPS[3]);
    // What this page added to what earlier pages did; what is left to her is this page's, since she dealt with the earlier ones to get here.
    const earlier = (filledSchema.safeParse(attempt.filled).data ?? []).map((entry) => ({ ...entry, page: entry.page ?? 1 }));
    const number = earlier.reduce((most, entry) => Math.max(most, entry.page), 0) + 1;
    await update(attemptId, { filled: [...earlier, ...onPage(fill.filled, number)], unfilled: fill.unfilled, captcha: fill.captcha, screenshot: fill.screenshot });
    return say(fill.captcha ? NOTES.captcha : fill.unfilled.some((entry) => entry.required) ? NOTES.pageRequired : NOTES.pageDone);
  } catch (error) {
    // Cancelled: nothing changed, and she is still waiting.
    if (signal.aborted) return { status: attempt.status, note: NOTES.cancelled };
    logServerError(`apply page ${attemptId}`, error);
    if (page.isClosed()) return end(attemptId, ApplyAttemptStatus.ABANDONED, NOTES.closed);
    return say(NOTES.broke);
  }
}
