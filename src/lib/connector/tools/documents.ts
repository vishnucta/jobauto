import "server-only";

import { createHash } from "node:crypto";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { ChatRole, DocumentKind, JobStatus, VersionCause } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { isAiUsable } from "@/lib/ai/config";
import { guardSources, unverifiedFacts } from "@/lib/ai/fact-guard";
import { editsSchema, extractedOf, SIGN_OFF_UNIT, trimmedSchema, unitsSchema, type Trimmed, type Unit } from "@/lib/application-data";
import { calendarDay, readJson } from "@/lib/application-documents";
import { emailParts, WRITTEN_EMAIL_UNITS } from "@/lib/application-email";
import { leaveOut, putBack, saveUnitText } from "@/lib/document-edits";
import { listDocumentVersions, loadDocumentVersion, restoreDocumentVersion, type VersionLine } from "@/lib/document-history";
import { documentLabels } from "@/lib/document-labels";
import { setDocumentLook } from "@/lib/document-look";
import { restoreUnitText, sendChatMessage, startUnitRewrite, undoChatMessage } from "@/lib/document-rewrites";
import { refineJob, refineJobKey } from "@/lib/jobs/refine";
import { regenerateUnitJob, unitJobKey } from "@/lib/jobs/regenerate-unit";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { defaultFrame, isFrameUnit, PRIVATE_FRAME_UNITS, withFrame, withoutPrivateParts, WRITTEN_FRAME_UNITS } from "@/lib/letter-frame";
import { logServerError } from "@/lib/log";
import { addMissingSkill, missingSkills } from "@/lib/match-skills";
import { renderDocumentPdf, type PdfDocument } from "@/lib/pdf/documents";
import { countPdfPages } from "@/lib/pdf/pages";
import type { ProfilePhoto } from "@/lib/photo";
import { prisma } from "@/lib/prisma";
import { loadFactTexts, loadProfile } from "@/lib/profile-data";
import { loadSettings } from "@/lib/settings-data";
import { loadThemes } from "@/lib/theme-data";
import { BUILT_IN_THEMES, hasSidebar, type ThemeData } from "@/lib/themes";
import { cleanUnitText, isPublicationUnit, unitName } from "@/lib/unit-text";

import { failure, started, text, type ToolContext } from "../kit";

// A tailored resume, cover letter and email: their parts, rewrites, versions, looks and PDFs (jobauto fork).
// What the application's Resume, Cover letter and Email tabs do, and the
// Base resume screen's Download PDF, through the library functions their
// actions use. The letter's sender and signature hold contact details:
// Claude neither reads nor changes them.

const GONE = "That application no longer exists.";

/** The documents, by the names the tools use. */
const KINDS = { resume: DocumentKind.RESUME, cover_letter: DocumentKind.COVER_LETTER, email: DocumentKind.EMAIL } as const;

/** How a document is called after "the". */
const NAMES: Record<DocumentKind, string> = {
  [DocumentKind.RESUME]: "resume",
  [DocumentKind.COVER_LETTER]: "cover letter",
  [DocumentKind.EMAIL]: "email",
};

/** Each document's tab on the application's page. */
const TABS: Record<DocumentKind, string> = {
  [DocumentKind.RESUME]: "",
  [DocumentKind.COVER_LETTER]: "?tab=letter",
  [DocumentKind.EMAIL]: "?tab=email",
};

const MISSING: Record<DocumentKind, string> = {
  [DocumentKind.RESUME]: "This application has no tailored resume.",
  [DocumentKind.COVER_LETTER]: "This application has no cover letter.",
  [DocumentKind.EMAIL]: "This application has no email yet.",
};

const PRIVATE = "The letter's sender and signature hold contact details, so they're changed on the application's page in Dossier.";

/** The PDFs export_pdf makes, by the `?doc=` the Download PDF buttons ask src/app/api/pdf for. */
const PDF_DOCS = { resume: "resume", cover_letter: "letter", base_resume: "base" } as const satisfies Record<string, PdfDocument>;

const applicationId = z.string().min(1).max(100);
const documentName = z.enum(["resume", "cover_letter", "email"]);
const partId = z.string().min(1).max(200);

/** Answers a refusal the page would show (an ActionError) as a failure; anything else is unexpected. */
async function refusalsAsFailures(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ActionError) return failure(error.message);
    throw error;
  }
}

/**
 * A document as its tab shows it, or the failure to answer with: a letter
 * has every part of its frame, those an older letter only shows too
 * (E8-11), but never its sender and signature.
 */
async function loadDocument(id: string, kind: DocumentKind) {
  const [application, profile, settings] = await Promise.all([
    prisma.application.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        company: true,
        role: true,
        location: true,
        mode: true,
        salary: true,
        language: true,
        extracted: true,
        postingText: true,
        sentAt: true,
        showPhoto: true,
        followThemeLayout: true,
        documents: { where: { kind }, select: { units: true, trimmed: true, themeId: true } },
      },
    }),
    loadProfile(),
    loadSettings(),
  ]);
  if (!application) return GONE;
  const row = application.documents[0];
  const units = row && readJson(unitsSchema, row.units);
  if (!row || !units) return MISSING[kind];
  const shown =
    kind === DocumentKind.COVER_LETTER
      ? withFrame(
          units,
          defaultFrame({
            basics: profile.basics,
            company: application.company,
            location: application.location,
            date: calendarDay(application.sentAt ?? undefined),
            dateFormat: settings.dateFormat,
            labels: documentLabels(application.language),
          }),
        )
      : units;
  return { application, row, units, parts: withoutPrivateParts(shown), profile, settings };
}

type DocumentView = Exclude<Awaited<ReturnType<typeof loadDocument>>, string>;

/** The failure for a part the document doesn't have, naming those it has. */
function noSuchPart(view: DocumentView, kind: DocumentKind, id: string): CallToolResult {
  if (kind === DocumentKind.COVER_LETTER && PRIVATE_FRAME_UNITS.has(id)) return failure(PRIVATE);
  return failure(`There's no part "${id}" in the ${NAMES[kind]}. Its parts are ${view.parts.map((part) => part.id).join(", ")}.`);
}

/** Whether the AI writes a part, so it can write it again: the page offers Regenerate and Ask AI only then (E8-11, #218). */
function writtenByAi(kind: DocumentKind, id: string): boolean {
  if (kind === DocumentKind.EMAIL) return WRITTEN_EMAIL_UNITS.has(id);
  if (kind === DocumentKind.RESUME) return !isPublicationUnit(id);
  return !isFrameUnit(id) || WRITTEN_FRAME_UNITS.has(id);
}

/** A part as Claude reads it, with what the fact guard couldn't back as "check". */
const partLine = (unit: Unit) => ({ id: unit.id, label: unit.label, text: unit.text, check: unit.unverified?.length ? unit.unverified : undefined });

/**
 * A short fingerprint of a part's text, which a change names, as the page's
 * editor sends the text it started from (APP-6): a part changed since Claude
 * read it, by hand on the page or by Dossier's AI, is never overwritten unseen.
 */
const revisionOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

/** The parts of a document Dossier's AI is writing again (E8-4): the page shows them as "Rewriting…", without Edit or Leave out. */
async function partsBeingRewritten(applicationId: string, kind: DocumentKind): Promise<Set<string>> {
  const jobs = await findUnfinishedJobs(unitJobKey(applicationId));
  return new Set(
    jobs.flatMap((job) => {
      const input = regenerateUnitJob.input.safeParse(job.input);
      return input.success && input.data.document === kind ? [input.data.unitId] : [];
    }),
  );
}

const rewritingNow = (part: Unit) => `Dossier's AI is writing the ${unitName(part)} again right now. Try again once get_document no longer shows it as rewriting.`;

/** What made a version, in the History panel's words (E8-10). */
function versionMade({ cause, detail }: Pick<VersionLine, "cause" | "detail">): string {
  switch (cause) {
    case VersionCause.WRITTEN:
      return "Written by the AI";
    case VersionCause.TRIMMED:
      return "Trimmed to fit the page limit";
    case VersionCause.REGENERATED:
      return detail ? `Rewrote “${detail}”` : "Rewrote a part";
    case VersionCause.REFINED:
      return detail ? `Changed from the chat: “${detail}”` : "Changed from the chat";
    case VersionCause.UNDONE:
      return "Undid an AI change";
    case VersionCause.BEFORE_RESTORE:
      return "As it was before a restore";
    case VersionCause.RESTORED:
      return detail ? `Brought back the version from ${detail}` : "Brought back an earlier version";
  }
}

const versionLine = (version: VersionLine) => ({ id: version.id, at: version.createdAt, made: versionMade(version) });

/** Whether the page limit left it out (E10-10), rather than "Leave out" (#217). */
const byPageLimit = (item: Trimmed[number]) => item.kind === "bullets" || !item.byHand;

/** "Studio Brik role" or "1 bullet from the Fieldnote role" */
function describeCut(item: Trimmed[number]): string {
  if (item.kind === "unit") return item.unit.label;
  const count = item.lines.length;
  return `${count} ${count === 1 ? "bullet" : "bullets"} from the ${item.label}`;
}

/**
 * How the documents look, as their tab's Theme menu and switches show it:
 * the theme the resume and cover letter share, and on the resume, the photo
 * and the sidebar layout of a theme that has one.
 */
function lookOf(
  kind: DocumentKind,
  { themeId, showPhoto, followThemeLayout }: { themeId: string | null; showPhoto: boolean | null; followThemeLayout: boolean },
  { themes, baseThemeId, photo }: { themes: ThemeData[]; baseThemeId: string; photo: ProfilePhoto | null },
) {
  const theme = themes.find((entry) => entry.id === themeId) ?? themes.find((entry) => entry.id === baseThemeId) ?? BUILT_IN_THEMES[0];
  if (kind !== DocumentKind.RESUME) return { theme: theme.name, theme_id: theme.id };
  return {
    theme: theme.name,
    theme_id: theme.id,
    photo: photo ? (showPhoto ?? photo.onResumes) : "no photo in the profile",
    sidebar_layout: hasSidebar(theme.layout) ? followThemeLayout : undefined,
  };
}

/**
 * What the fact guard (E6-6) can't back in a part Claude wrote, with "Never
 * invent experience" on. Parts are checked as the chat's edits are: not the
 * letter's frame and sign-off, the email's recipient or a publication.
 */
async function unbacked(view: DocumentView, kind: DocumentKind, id: string, text: string): Promise<string[] | undefined> {
  const checked = kind === DocumentKind.EMAIL ? id !== "to" : id !== SIGN_OFF_UNIT && !isFrameUnit(id) && !isPublicationUnit(id);
  if (!view.settings.strict || !checked) return undefined;
  const facts = await loadFactTexts(view.application.id);
  // The email's recipient counts too: its greeting names them.
  const sources = [view.application.postingText, kind === DocumentKind.EMAIL ? emailParts(view.units).to : ""].join("\n");
  const flags = unverifiedFacts(text, guardSources(view.profile, extractedOf(view.application), sources, facts));
  return flags.length > 0 ? flags : undefined;
}

type EditInput = {
  application_id: string;
  document: keyof typeof KINDS;
  action: "change" | "leave_out" | "put_back" | "undo" | "restore_version";
  part_id?: string;
  revision?: string;
  text?: string;
  index?: number;
  task_id?: string;
  version_id?: string;
};

/** edit_document: an edit as the document's tab makes it, without AI. */
async function editDocument(input: EditInput, link: string): Promise<CallToolResult> {
  const kind = KINDS[input.document];
  if (input.action === "undo") return undo(input.application_id, input.task_id, link);
  const view = await loadDocument(input.application_id, kind);
  if (typeof view === "string") return failure(view);

  switch (input.action) {
    case "change": {
      if (!input.part_id || input.text === undefined) return failure("Give the part_id and the part's new text.");
      const part = view.parts.find((entry) => entry.id === input.part_id);
      if (!part) return noSuchPart(view, kind, input.part_id);
      const clean = cleanUnitText(part.id, input.text);
      // The email's recipient may be left empty, for the mail app to fill in.
      if (!clean && !(kind === DocumentKind.EMAIL && part.id === "to")) {
        return failure(`Give the part's new text.${kind === DocumentKind.RESUME ? " To take it off the resume, use action leave_out." : ""}`);
      }
      if ((await partsBeingRewritten(input.application_id, kind)).has(part.id)) return failure(rewritingNow(part));
      if (!input.revision) return failure(`Give the revision get_document shows for the ${unitName(part)}, so a change made since you read it isn't overwritten.`);
      // Then saveUnitText refuses it too if the part changes before it's saved.
      if (input.revision !== revisionOf(part.text)) {
        return failure(`The ${unitName(part)} changed since you read it, so nothing was saved. Read it again with get_document and change the new version.`);
      }
      const unverified = await unbacked(view, kind, part.id, clean);
      const saved = await saveUnitText({ applicationId: input.application_id, document: kind, unitId: part.id, text: input.text, expected: part.text, unverified });
      return text({
        changed: part.label,
        part_id: part.id,
        text: saved,
        revision: revisionOf(saved),
        was: part.text,
        check_these: unverified,
        next: unverified ? "Dossier marked names or numbers it couldn't find in the profile or posting; tell the user to check them." : undefined,
        link,
      });
    }
    case "leave_out": {
      if (kind !== DocumentKind.RESUME) return failure("Only a part of the resume can be left out.");
      if (!input.part_id) return failure("Give the part_id of the part to leave out.");
      const part = view.parts.find((entry) => entry.id === input.part_id);
      if (!part) return noSuchPart(view, kind, input.part_id);
      if ((await partsBeingRewritten(input.application_id, kind)).has(part.id)) return failure(rewritingNow(part));
      const index = await leaveOut(input.application_id, part.id);
      return text({ left_out: part.label, index, next: "To bring it back, call edit_document with action put_back and this index.", link });
    }
    case "put_back": {
      if (kind !== DocumentKind.RESUME) return failure("Only the resume has parts left out.");
      const leftOut = readJson(trimmedSchema, view.row.trimmed) ?? [];
      if (leftOut.length === 0) return failure("Nothing is left out of this resume.");
      if (input.index === undefined || !leftOut[input.index]) {
        return failure(`Give the index of what to put back, from 0 to ${leftOut.length - 1}, as get_document's left_out lists them.`);
      }
      const item = await putBack(input.application_id, input.index);
      return text({ put_back: describeCut(item), note: byPageLimit(item) ? "The resume may run over its page limit now." : undefined, link });
    }
    case "restore_version": {
      if (!input.version_id) return failure("Give the version_id of the version to bring back, from get_document.");
      const versions = await listDocumentVersions(input.application_id, kind);
      if (!versions.some((version) => version.id === input.version_id)) {
        return failure(`There's no such version of the ${NAMES[kind]}. Call get_document to see its versions.`);
      }
      await restoreDocumentVersion(input.application_id, input.version_id);
      return text({ restored: `the ${NAMES[kind]}`, version_id: input.version_id, note: "The version it had until now is in its history too.", link });
    }
  }
}

/**
 * Undo after a rewrite (E8-4) or under a chat reply (E8-6): what a task from
 * rewrite_document changed, or without one, the newest change from the chat.
 * A part changed again since is never overwritten.
 */
async function undo(applicationId: string, taskId: string | undefined, link: string): Promise<CallToolResult> {
  const parts = (edited: { document: DocumentKind; unitId: string }[]) => edited.map(({ document, unitId }) => ({ document: NAMES[document], part_id: unitId }));
  if (!taskId) {
    const reply = await prisma.chatMessage.findFirst({
      where: { applicationId, role: ChatRole.AI, edits: { not: Prisma.DbNull } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!reply) return failure("There's no change from Dossier's chat to undo.");
    return text({ undone: "the last change from Dossier's chat", parts: parts(await undoChatMessage(applicationId, reply.id)), link });
  }

  const job = await prisma.job.findFirst({ where: { id: taskId, applicationId }, select: { type: true, status: true, input: true, result: true } });
  if (!job || (job.type !== regenerateUnitJob.type && job.type !== refineJob.type)) {
    return failure("That task isn't a rewrite of this application's documents. Give a task_id from rewrite_document.");
  }
  if (job.status === JobStatus.FAILED) return failure("That rewrite didn't change anything, so there's nothing to undo.");
  if (job.status !== JobStatus.DONE) return failure("That rewrite isn't done yet. Call check_task until it is.");
  if (job.type === refineJob.type) {
    const result = refineJob.result.safeParse(job.result);
    if (!result.success) return failure("There's nothing to undo in that rewrite.");
    return text({ undone: "the change from Dossier's chat", parts: parts(await undoChatMessage(applicationId, result.data.messageId)), link });
  }
  const input = regenerateUnitJob.input.safeParse(job.input);
  const result = regenerateUnitJob.result.safeParse(job.result);
  if (!input.success || !result.success || result.data.outcome !== "rewritten") {
    return failure("That rewrite left the part as it was, so there's nothing to undo.");
  }
  const { previous, unit } = result.data;
  await restoreUnitText({ applicationId, document: input.data.document, unitId: unit.id, text: previous.text, unverified: previous.unverified, expected: unit.text });
  return text({ undone: `the rewrite of the ${unitName(unit)}`, part_id: unit.id, text: previous.text, link });
}

/** Registers these tools on the connector's server. */
export function registerDocumentTools({ server, linkTo }: ToolContext): void {
  const documentLink = (id: string, kind: DocumentKind) => linkTo(`/applications/${id}${TABS[kind]}`);

  server.registerTool(
    "get_document",
    {
      title: "Read a document",
      description:
        "One of an application's documents (resume, cover_letter or email) as its tab shows it: its parts with their ids and revisions, what's left out of the resume, its look and its saved versions. " +
        "With version_id, that version's parts instead. The letter's sender and signature are left out.",
      inputSchema: z.object({
        application_id: applicationId,
        document: documentName,
        version_id: z.string().min(1).max(100).optional().describe("A saved version's id from versions, to read that version"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ application_id, document, version_id }) => {
      const kind = KINDS[document];
      const view = await loadDocument(application_id, kind);
      if (typeof view === "string") return failure(view);
      const link = documentLink(application_id, kind);
      const versions = await listDocumentVersions(application_id, kind);

      if (version_id) {
        const version = versions.find((entry) => entry.id === version_id);
        if (!version) return failure(`There's no such version of the ${NAMES[kind]}. Call get_document without version_id to see its versions.`);
        const { units } = await loadDocumentVersion(application_id, version_id);
        return text({
          application_id,
          document,
          version: versionLine(version),
          parts: withoutPrivateParts(units).map(partLine),
          next: "To bring this version back, call edit_document with action restore_version.",
          link,
        });
      }

      const [themes, rewriting, chatting, reply] = await Promise.all([
        kind === DocumentKind.EMAIL ? [] : loadThemes(),
        partsBeingRewritten(application_id, kind),
        findUnfinishedJobs(refineJobKey(application_id)),
        // The newest answer of Dossier's AI in the chat, not the note written when the application was made.
        prisma.chatMessage.findFirst({
          where: { applicationId: application_id, role: ChatRole.AI, writtenWith: { not: null } },
          orderBy: { createdAt: "desc" },
          select: { text: true, edits: true, undone: true, createdAt: true },
        }),
      ]);
      const leftOut = kind === DocumentKind.RESUME ? (readJson(trimmedSchema, view.row.trimmed) ?? []) : [];
      const { application, row, profile, settings } = view;
      return text({
        application_id,
        document,
        parts: view.parts.map((unit) => ({ ...partLine(unit), revision: revisionOf(unit.text), rewriting: rewriting.has(unit.id) || undefined })),
        left_out:
          leftOut.length > 0
            ? leftOut.map((item, index) => ({
                index,
                what: describeCut(item),
                why: byPageLimit(item) ? "to fit the page limit" : "left out by hand",
                text: item.kind === "unit" ? item.unit.text : item.lines.join("\n"),
              }))
            : undefined,
        look:
          kind === DocumentKind.EMAIL
            ? undefined
            : {
                ...lookOf(kind, { themeId: row.themeId, showPhoto: application.showPhoto, followThemeLayout: application.followThemeLayout }, { themes, baseThemeId: settings.baseThemeId, photo: profile.photo }),
                themes: themes.map((theme) => theme.name),
              },
        versions: versions.map(versionLine),
        busy: chatting.length > 0 ? "Dossier's AI is still answering a chat message, so parts may change." : undefined,
        last_chat_reply: reply
          ? { text: reply.text.slice(0, 2000), at: reply.createdAt.toISOString(), parts_changed: readJson(editsSchema, reply.edits)?.length ?? 0, undone: reply.undone || undefined }
          : undefined,
        link,
      });
    },
  );

  server.registerTool(
    "edit_document",
    {
      title: "Edit a document",
      description:
        "Changes a document without AI: a part's text (action change), a resume part left out or put back (leave_out, put_back), " +
        "a rewrite from rewrite_document or the last change from Dossier's chat undone (undo), or a saved version brought back (restore_version). " +
        "A change needs the part's revision from get_document: if the part changed since you read it, nothing is saved. Answers with what changed.",
      inputSchema: z.object({
        application_id: applicationId,
        document: documentName,
        action: z.enum(["change", "leave_out", "put_back", "undo", "restore_version"]),
        part_id: partId.optional().describe("For change and leave_out: the part's id from get_document"),
        revision: z.string().trim().min(1).max(64).optional().describe("For change: the part's revision from get_document, or from the answer to your last change of it"),
        text: z.string().max(10_000).optional().describe("For change: the part's new text, from facts in the profile. A role's bullets go one per line."),
        index: z.number().int().min(0).max(500).optional().describe("For put_back: its index in get_document's left_out"),
        task_id: z.string().min(1).max(100).optional().describe("For undo: a task_id from rewrite_document. Without it, the last change from Dossier's chat is undone."),
        version_id: z.string().min(1).max(100).optional().describe("For restore_version: the version's id from get_document"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => refusalsAsFailures(() => editDocument(input, documentLink(input.application_id, KINDS[input.document]))),
  );

  server.registerTool(
    "rewrite_document",
    {
      title: "Have Dossier's AI rewrite a document",
      description:
        "Has Dossier's own AI model write one part again (part_id), change a part as asked (part_id and instruction) or change the whole document as asked (instruction). " +
        "Only when an AI provider is set up in Dossier; otherwise write the new text yourself and save it with edit_document. " +
        "Follow the task_id with check_task, then read the result with get_document.",
      inputSchema: z.object({
        application_id: applicationId,
        document: documentName,
        part_id: partId.optional().describe("The part to rewrite, by its id from get_document. Leave it out to change the whole document."),
        instruction: z.string().trim().min(1).max(2000).optional().describe("What should change, in the user's words. Without it, the part is written again."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ application_id, document, part_id, instruction }) =>
      refusalsAsFailures(async () => {
        if (!part_id && !instruction) return failure("Give part_id to write one part again, or an instruction to change the whole document.");
        if (!(await isAiUsable())) return failure("Dossier has no AI model of its own set up. Write the new text yourself and save it with edit_document.");
        const kind = KINDS[document];
        const view = await loadDocument(application_id, kind);
        if (typeof view === "string") return failure(view);
        const part = part_id ? view.parts.find((entry) => entry.id === part_id) : undefined;
        if (part_id && !part) return noSuchPart(view, kind, part_id);
        // As on the page, only the parts the AI writes: a publication is the user's own citation (#218).
        if (part && kind === DocumentKind.RESUME && isPublicationUnit(part.id)) return failure("A publication stays as the user wrote it. Change it with edit_document instead.");
        if (part && !writtenByAi(kind, part.id)) return failure("This part isn't written by the AI. Change it with edit_document instead.");
        // A letter part an older letter only shows (E8-11) is stored before it's rewritten.
        const shown = part && !view.units.some((unit) => unit.id === part.id) ? part.text : undefined;
        const then = "When it's done, read the result with get_document. To undo it, call edit_document with action undo and this task_id.";

        if (instruction) {
          // As on the page, the chat only changes parts the letter stores.
          if (part && shown !== undefined) return failure(`Dossier's chat can't change the ${unitName(part)} yet. Rewrite it without an instruction, or change it with edit_document.`);
          const { jobId } = await sendChatMessage({ applicationId: application_id, text: instruction, viewing: kind, target: part ? { document: kind, unitId: part.id } : null });
          // With a document on screen, the reply always comes from the AI.
          return started(jobId!, { changing: part ? `the ${unitName(part)}` : `the ${NAMES[kind]}`, then });
        }
        const jobId = await startUnitRewrite({ applicationId: application_id, document: kind, unitId: part!.id, shown });
        return started(jobId, { rewriting: `the ${unitName(part!)}`, then });
      }),
  );

  server.registerTool(
    "set_document_look",
    {
      title: "Change how the documents look",
      description:
        "Changes how an application's resume and cover letter look: their theme (one for both, by name or id), and on the resume, the profile photo and the theme's sidebar layout. " +
        "Answers with the look as it is now.",
      inputSchema: z.object({
        application_id: applicationId,
        theme: z.string().trim().min(1).max(100).optional().describe("A theme's name or id, e.g. 'Classic'"),
        photo: z.boolean().optional().describe("The profile photo on this resume, or not"),
        sidebar_layout: z.boolean().optional().describe("The theme's sidebar layout, or a single column. Only some themes have a sidebar."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ application_id, theme, photo, sidebar_layout }) =>
      refusalsAsFailures(async () => {
        if (theme === undefined && photo === undefined && sidebar_layout === undefined) return failure("Say what to change: theme, photo or sidebar_layout.");
        const [themes, profile, settings] = await Promise.all([loadThemes(), loadProfile(), loadSettings()]);
        const picked =
          theme === undefined ? undefined : (themes.find((entry) => entry.id === theme) ?? themes.find((entry) => entry.name.trim().toLowerCase() === theme.toLowerCase()));
        if (theme !== undefined && !picked) return failure(`There's no theme called "${theme}". The themes are ${themes.map((entry) => entry.name).join(", ")}.`);
        if (photo && !profile.photo) return failure("The profile has no photo. Add one on the Profile screen first.");

        await setDocumentLook(application_id, { themeId: picked?.id, showPhoto: photo, followThemeLayout: sidebar_layout });
        const application = await prisma.application.findUnique({
          where: { id: application_id },
          select: { showPhoto: true, followThemeLayout: true, documents: { where: { kind: { in: [DocumentKind.RESUME, DocumentKind.COVER_LETTER] } }, select: { kind: true, themeId: true } } },
        });
        if (!application) return failure(GONE);
        const themeId = (application.documents.find((entry) => entry.kind === DocumentKind.RESUME) ?? application.documents[0])?.themeId ?? null;
        const look = lookOf(
          DocumentKind.RESUME,
          { themeId, showPhoto: application.showPhoto, followThemeLayout: application.followThemeLayout },
          { themes, baseThemeId: settings.baseThemeId, photo: profile.photo },
        );
        return text({
          ...look,
          note:
            sidebar_layout !== undefined && look.sidebar_layout === undefined
              ? `The ${look.theme} theme has no sidebar, so the layout switch shows once the documents have a theme with one.`
              : undefined,
          link: linkTo(`/applications/${application_id}`),
        });
      }),
  );

  server.registerTool(
    "add_match_skill",
    {
      title: "Add a missing skill to the profile",
      description:
        "Adds a skill the posting asks for and the profile lacks to the profile, as “+ Add to profile” does on the application's Job posting tab. The requirement then counts as partly covered.",
      inputSchema: z.object({
        application_id: applicationId,
        skill: z.string().trim().min(1).max(200).describe("The missing skill as the match names it, e.g. 'Kubernetes', or its requirement's text"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ application_id, skill }) =>
      refusalsAsFailures(async () => {
        const application = await prisma.application.findUnique({ where: { id: application_id }, select: { match: true, extracted: true } });
        if (!application) return failure(GONE);
        const missing = missingSkills(application.match, application.extracted);
        const wanted = skill.toLowerCase();
        const found = missing.find((entry) => entry.skill.trim().toLowerCase() === wanted || entry.requirement.trim().toLowerCase() === wanted);
        if (!found) {
          return failure(
            missing.length > 0
              ? `That isn't a skill this application's match is missing. These are: ${missing.map((entry) => entry.skill).join(", ")}.`
              : "This application's match has no missing skill to add.",
          );
        }
        const { name } = await addMissingSkill(application_id, found.index);
        return text({
          added: name,
          requirement: found.requirement,
          now: "partly covered",
          next: `Attach ${name} to a role under Experience on the Profile screen to make it count.`,
          link: linkTo(`/applications/${application_id}?tab=posting`),
        });
      }),
  );

  server.registerTool(
    "export_pdf",
    {
      title: "Make a PDF",
      description:
        "Renders an application's tailored resume or cover letter, or the base resume, as a PDF, exactly as Download PDF does, and returns the file with its name.",
      inputSchema: z.object({
        application_id: applicationId.optional().describe("For resume and cover_letter: the application"),
        document: z.enum(["resume", "cover_letter", "base_resume"]).describe("base_resume is the one on the Base resume screen, built from the profile"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ application_id = "", document }) => {
      const doc = PDF_DOCS[document];
      if (doc !== "base" && !application_id) return failure("Give the application_id of the application whose resume or cover letter to make.");
      let rendered: Awaited<ReturnType<typeof renderDocumentPdf>>;
      try {
        rendered = await renderDocumentPdf(doc, application_id);
      } catch (error) {
        logServerError("Claude connector export_pdf", error);
        return failure(`The PDF couldn't be made just now. Try again in a moment, or use Download PDF on ${doc === "base" ? "the Base resume screen" : "the application's page"}.`);
      }
      if ("error" in rendered) return failure(rendered.error);
      // Where the signed-in user downloads it again, as the page's button does.
      const download = linkTo(doc === "base" ? "/api/pdf?doc=base" : `/api/pdf?doc=${doc}&application=${encodeURIComponent(application_id)}`);
      const link = document === "base_resume" ? linkTo("/resume") : documentLink(application_id, KINDS[document]);
      const answer = text({ file_name: rendered.fileName, document, pages: countPdfPages(rendered.pdf), download, link });
      return {
        content: [...answer.content, { type: "resource", resource: { uri: download, mimeType: "application/pdf", blob: Buffer.from(rendered.pdf).toString("base64") } }],
      };
    },
  );
}
