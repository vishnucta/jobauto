"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { DocumentKind, Tone } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { isAiConfigured } from "@/lib/ai/config";
import { profileUnits } from "@/lib/ai/tasks/tailor-resume";
import { trimmedSchema, unitsSchema } from "@/lib/application-data";
import { loadDocuments, readJson } from "@/lib/application-documents";
import { addApplicationNote, deleteApplicationNote, noteBody, restoreApplicationNote, updateApplicationNote } from "@/lib/application-notes";
import { leaveOut, PART_GONE, putBack, saveUnitText } from "@/lib/document-edits";
import { goBackToVersions, listDocumentVersions, loadDocumentVersion, restoreDocumentVersion } from "@/lib/document-history";
import { documentLabels } from "@/lib/document-labels";
import { setDocumentLook } from "@/lib/document-look";
import { restoreUnitText, sendChatMessage, startLanguageRewrite, startUnitRewrite, undoChatMessage } from "@/lib/document-rewrites";
import { updateDocuments } from "@/lib/document-units";
import { putBackEmail, writeApplicationEmail } from "@/lib/email-writing";
import { DOCUMENT_LABELS } from "@/lib/file-name";
import { frozenCopySchema, frozenProfile, readFrozenCopy, withSectionFromProfile } from "@/lib/frozen-copy";
import { followInCalendar, saveInterviewDate } from "@/lib/interview-date";
import { addNextRound, saveRoundDetails, tickPrepItem, upcomingRound } from "@/lib/interviews";
import { checkRequirementsJob, checkRequirementsJobKey } from "@/lib/jobs/check-requirements";
import { prepareInterviewJob, prepareJobKey } from "@/lib/jobs/prepare-interview";
import { cancelJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { writeApplicationJobKey } from "@/lib/jobs/write-application";
import { writeDocumentJob, writeDocumentJobKey } from "@/lib/jobs/write-document";
import { letMessageDraftGo, startMessageDraft } from "@/lib/jobs/write-message";
import { addMissingSkill } from "@/lib/match-skills";
import { MESSAGE_KINDS, messageDraftSchema } from "@/lib/message-draft";
import { saveOfferDetails } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { profileUpdate } from "@/lib/profile-update";
import { applicationProfileId, loadProfileSettings } from "@/lib/profiles";
import { checkResume, cleanDocumentText } from "@/lib/resume-check";
import { sectionLayoutSchema, sectionOfUnit } from "@/lib/resume-sections";
import { scoringProblem } from "@/lib/scoring";

const GONE = "That application no longer exists.";

const refresh = (id: string) => revalidatePath(`/applications/${id}`);

// The tailored documents' looks, edits, AI changes and versions are made by
// src/lib/document-look.ts, document-edits.ts, document-rewrites.ts and
// document-history.ts, which the Claude connector uses too. The Sections
// menu, "Update from profile", "Write the cover letter" (Dossier 1.12 and
// 1.13) and what Dossier 1.15 added to the page (interviews, the offer,
// drafted messages, known gaps, the letter's tone and language, Check again)
// are made here.

/** The Resume tab's layout switch (APP-4): the theme's own layout, or a single column. */
export const setFollowThemeLayout = action(
  z.object({ id: z.string().min(1), follow: z.boolean() }),
  async ({ id, follow }) => {
    await setDocumentLook(id, { followThemeLayout: follow });
    refresh(id);
    return null;
  },
);

/** The Resume tab's Photo switch (#224): show the profile photo on this resume or not, whatever the profile says. */
export const setShowPhoto = action(z.object({ id: z.string().min(1), show: z.boolean() }), async ({ id, show }) => {
  await setDocumentLook(id, { showPhoto: show });
  refresh(id);
  return null;
});

/** The Sections menu (#297): this resume's own order and which sections are on it. */
export const setApplicationSections = action(z.object({ id: z.string().min(1), order: sectionLayoutSchema.shape.order, off: sectionLayoutSchema.shape.off, titles: sectionLayoutSchema.shape.titles }), async ({ id, order, off, titles }) => {
  const application = await prisma.application.findUnique({ where: { id }, select: { sections: true } });
  if (!application) throw new ActionError(GONE);
  const withReferences = readJson(sectionLayoutSchema, application.sections)?.withReferences;
  await prisma.application.update({ where: { id }, data: { sections: { order, off, ...(titles ? { titles } : {}), ...(withReferences ? { withReferences } : {}) } } });
  refresh(id);
  return null;
});

/** "Use the base resume's order": a draft follows the base resume again; one that was sent takes its order as it is now, once. */
export const followBaseSections = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const application = await prisma.application.findUnique({ where: { id }, select: { frozen: true, profileId: true } });
  if (!application) throw new ActionError(GONE);
  const sections = application.frozen === null ? Prisma.DbNull : (await loadProfileSettings(application.profileId)).resumeSections;
  await prisma.application.update({ where: { id }, data: { sections } });
  refresh(id);
  return null;
});

/**
 * "Add" on the Sections menu (#297): puts a section from the profile on this
 * resume, in the profile's own words. Nothing else ever does: a resume only
 * holds what it was written with and what's added here.
 */
export const addApplicationSection = action(z.object({ id: z.string().min(1), key: z.string().min(1) }), async ({ id, key }) => {
  // From the profile it was made from (E24-6).
  const profileId = await applicationProfileId(id);
  const [application, profile, settings] = await Promise.all([
    prisma.application.findUnique({ where: { id }, select: { sections: true, language: true, frozen: true } }),
    loadProfile(profileId),
    loadProfileSettings(profileId),
  ]);
  if (!application) throw new ActionError(GONE);

  const fresh = profileUnits(profile, documentLabels(application.language)).filter((unit) => sectionOfUnit(unit.id, profile) === key);
  const added = new Set(fresh.map((unit) => unit.id));
  const copy = readFrozenCopy(application.frozen);
  await updateDocuments(id, async (documents, tx) => {
    const units = documents[DocumentKind.RESUME];
    if (!units) throw new ActionError(PART_GONE);
    // A sent resume is drawn from its copy, so the section has to reach that too (#299). Taking one back on that it still holds changes nothing.
    const holdsIt = copy !== null && units.some((unit) => unit.text.trim() && sectionOfUnit(unit.id, frozenProfile(copy, profile)) === key);
    if (copy && !holdsIt) {
      await tx.application.update({ where: { id }, data: { frozen: withSectionFromProfile(copy, profile, key) as unknown as Prisma.InputJsonValue } });
    }
    for (const unit of fresh) {
      const index = units.findIndex((entry) => entry.id === unit.id);
      if (index < 0) units.push(unit);
      else if (!units[index].text.trim()) units[index] = unit;
    }
  });
  // Back through here, so they're no longer listed as left out. Written after the document itself: updateDocuments checks it wasn't changed meanwhile.
  const row = await prisma.document.findUniqueOrThrow({ where: { applicationId_kind: { applicationId: id, kind: DocumentKind.RESUME } }, select: { id: true, trimmed: true } });
  const trimmed = readJson(trimmedSchema, row.trimmed);
  const rest = trimmed?.filter((cut) => !(cut.kind === "unit" ? added.has(cut.unit.id) : added.has(cut.unitId)));
  if (trimmed && rest && rest.length !== trimmed.length) {
    await prisma.document.update({ where: { id: row.id }, data: { trimmed: rest.length > 0 ? rest : Prisma.DbNull } });
  }

  const own = readJson(sectionLayoutSchema, application.sections);
  const layout = own ?? settings.resumeSections;
  if (layout.off.includes(key) || key === "references") {
    await prisma.application.update({
      where: { id },
      data: {
        sections: {
          ...layout,
          off: layout.off.filter((entry) => entry !== key),
          ...(key === "references" ? { withReferences: true } : {}),
        },
      },
    });
  }
  refresh(id);
  return null;
});

/**
 * "Update from profile" (#301): titles, dates, contact details and links as
 * the profile has them now, with what's new in the sections this resume holds.
 * Returns what to put back for Undo, or null when there was nothing to update.
 */
export const updateFromProfile = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError(GONE);
  const { application, liveProfile, resume, includeReferences } = await loadDocuments(id);
  if (!resume) throw new ActionError(PART_GONE);
  const copy = readFrozenCopy(application.frozen);
  const update = profileUpdate({ copy: copy?.profile ?? null, live: liveProfile, units: resume.units, trimmed: resume.trimmed ?? null, language: application.language, includeReferences });
  if (!update.changed) return null;

  await updateDocuments(id, async (documents, tx) => {
    documents[DocumentKind.RESUME] = update.units;
    if (copy && update.copy) await tx.application.update({ where: { id }, data: { frozen: { ...copy, profile: update.copy } as unknown as Prisma.InputJsonValue } });
  });
  refresh(id);
  return { profile: copy?.profile ?? null, units: resume.units };
});

/** Undo after "Update from profile". */
export const undoUpdateFromProfile = action(
  z.object({ id: z.string().min(1), profile: frozenCopySchema.shape.profile.nullable(), units: unitsSchema }),
  async ({ id, profile, units }) => {
    const application = await prisma.application.findUnique({ where: { id }, select: { frozen: true } });
    if (!application) throw new ActionError(GONE);
    const copy = readFrozenCopy(application.frozen);
    await updateDocuments(id, async (documents, tx) => {
      documents[DocumentKind.RESUME] = units;
      if (copy && profile) await tx.application.update({ where: { id }, data: { frozen: { ...copy, profile } as unknown as Prisma.InputJsonValue } });
    });
    refresh(id);
    return null;
  },
);

/**
 * The Theme menu on the Resume and Cover letter tabs (#226, public issue 10):
 * gives the application's resume and cover letter another theme, together.
 * Only their look changes, so nothing is written again.
 */
export const setApplicationTheme = action(z.object({ id: z.string().min(1), themeId: z.string().min(1) }), async ({ id, themeId }) => {
  await setDocumentLook(id, { themeId });
  refresh(id);
  return null;
});

/**
 * The language the documents are written in, from the ATS check's "Set the
 * language" fix: their headings and dates follow it. One from the "Write
 * documents in" list or added there, in any spelling of its case.
 */
export const setDocumentLanguage = action(z.object({ id: z.string().min(1), language: z.string().max(100) }), async ({ id, language }) => {
  await setDocumentLook(id, { language });
  refresh(id);
  return null;
});

/**
 * "Rewrite in…": the resume, cover letter and email written again in another
 * language in the background; returns the job's id. Setting only the language
 * (setDocumentLanguage) changes the headings and dates and leaves the text.
 */
export const rewriteInLanguage = action(z.object({ id: z.string().min(1), language: z.string().max(100) }), ({ id, language }) => startLanguageRewrite({ applicationId: id, language }));

// ─── The ATS check (Resume tab) ──────────────────────────────────────────────
// The check itself is src/lib/resume-check.ts, which the Claude connector's
// check_resume uses too. Its report holds labels and counts, never the text.

/** "Check for ATS": prints the tailored resume as Download PDF does and reads it back the way a parser would. */
export const checkResumeAts = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const report = await checkResume("resume", id);
  if ("error" in report) throw new ActionError(report.error);
  return report;
});

/** The check's "Clean up the text" fix: the resume's and letter's parts written again without the characters a parser misreads. */
export const cleanUpDocument = action(z.object({ id: z.string().min(1) }), async ({ id }, { toast }) => {
  await cleanDocumentText(id);
  refresh(id);
  toast("Rewrote the resume and the cover letter with plain characters.");
  return null;
});

/**
 * The next interview's date and time (E9-9), or null to remove it. It shows
 * on the dashboard's Needs you while the application is in Interview, fills
 * in the upcoming round (E30-6), and while Dossier keeps interviews in Google
 * Calendar, the event is added, moved or deleted to match.
 */
export const setInterviewDate = action(
  // `calendar: false` leaves Google Calendar out of this one interview (E29-5, LB3).
  z.object({ id: z.string().min(1), at: z.iso.datetime().nullable(), calendar: z.boolean().default(true) }),
  async ({ id, at, calendar }, { toast }) => {
    const moment = at ? new Date(at) : null;
    await saveInterviewDate(id, moment);
    refresh(id);
    // The board's card and the dashboard show it too (E29-5).
    revalidatePath("/applications");
    revalidatePath("/");
    if (!calendar) {
      toast(at ? "Interview date saved. It'll show on your dashboard." : "Interview date removed.");
      return null;
    }
    toast(await followInCalendar(id, moment));
    return null;
  },
);

/**
 * Saves a unit edited by hand (APP-6). `expected` is the text the editor
 * started from: if the unit changed since (an AI rewrite that finished
 * meanwhile), nothing is saved, so neither version is lost unseen. The
 * text is the user's own, so the fact guard's hints go.
 */
export const saveUnit = action(
  z.object({
    id: z.string().min(1),
    document: z.enum(DocumentKind),
    unitId: z.string().min(1),
    text: z.string().max(10_000),
    expected: z.string(),
  }),
  async ({ id, document, unitId, text, expected }) => {
    const clean = await saveUnitText({ applicationId: id, document, unitId, text, expected });
    refresh(id);
    return { text: clean };
  },
);

const unitInput = { id: z.string().min(1), document: z.enum(DocumentKind), unitId: z.string().min(1) };

/**
 * "Regenerate" (E8-4): rewrites one unit in the background and returns the
 * job's id. Asking again while it's being rewritten follows the same job.
 */
export const startRegenerating = action(
  z.object({
    ...unitInput,
    /** For a letter part an older letter only shows (E8-11): the text on screen, stored before it's rewritten. */
    shown: z.string().trim().min(1).max(2000).optional(),
  }),
  ({ id, document, unitId, shown }) => startUnitRewrite({ applicationId: id, document, unitId, shown }),
);

/**
 * Undo on the "Rewrote the summary." toast (E8-4): puts the previous
 * version back, unless the unit has changed again since.
 */
export const restoreUnit = action(
  z.object({
    ...unitInput,
    text: z.string().max(10_000),
    unverified: z.array(z.string()).optional(),
    /** The text it has now, which Undo replaces. */
    expected: z.string(),
  }),
  async ({ id, document, unitId, text, unverified, expected }) => {
    await restoreUnitText({ applicationId: id, document, unitId, text, unverified, expected });
    refresh(id);
    return null;
  },
);

/**
 * Sends a message from the Refine with AI panel (E8-5): saves it and starts
 * the reply in the background, returning the job's id. On the Job posting
 * tab without a picked unit, the reply comes at once and needs no AI.
 */
export const sendMessage = action(
  z.object({
    id: z.string().min(1),
    text: z.string().trim().min(1, "Write what should change first.").max(2000),
    /** The document on screen; null on the Job posting and Notes tabs, and on the Email tab before there's an email. */
    viewing: z.enum(DocumentKind).nullable(),
    /** The unit picked with "Ask AI". */
    target: z.object({ document: z.enum(DocumentKind), unitId: z.string().min(1) }).nullable(),
    /** Change, or Ask, which only answers (E30-10, AP5). */
    mode: z.enum(["change", "ask"]).default("change"),
  }),
  async ({ id, text, viewing, target, mode }) => {
    const sent = await sendChatMessage({ applicationId: id, text, viewing, target, mode });
    refresh(id);
    return sent;
  },
);

/**
 * "Undo" under a reply in the chat (E8-6, APP-8): puts back what the reply
 * changed, units and tone, all or nothing. A unit edited again since is
 * never overwritten; the answer says which.
 */
export const undoMessage = action(z.object({ id: z.string().min(1), messageId: z.string().min(1) }), async ({ id, messageId }) => {
  const edited = await undoChatMessage(id, messageId);
  refresh(id);
  return { edited };
});

/**
 * "+ Add to profile" on the Job posting tab (E8-7, NEW-5): adds a missing
 * skill to the profile, and the requirement becomes partly covered.
 */
export const addMatchSkill = action(
  z.object({
    id: z.string().min(1),
    index: z.number().int().min(0),
    /** The role it was used in (E30-5): linked to the skill, and given the line below. */
    experienceId: z.string().min(1).nullish(),
    /** What was done with it, a line for that role's points; optional. */
    did: z.string().trim().max(500).optional(),
  }),
  async ({ id, index, experienceId, did }) => {
    const added = await addMissingSkill(id, index, { experienceId, did });
    refresh(id);
    return added;
  },
);

// ─── Interviews (E30-6) ──────────────────────────────────────────────────────

const ROUND_GONE = "That round no longer exists. Reload the page to see what's there now.";

/**
 * "Prepare": writes "Getting ready" for the upcoming round, or the latest
 * one, in the background (only ever on this click), and returns the job's
 * id. An application in Interview without a round gets round 1.
 */
export const startPreparing = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError(GONE);
  if (!(await isAiConfigured())) throw new ActionError("That needs an AI provider. Choose one in Settings → AI provider.");
  const key = prepareJobKey(id);
  const [running] = await findUnfinishedJobs(key);
  if (running) return running.id;
  const rounds = await prisma.interview.findMany({ where: { applicationId: id }, select: { id: true, round: true, at: true }, orderBy: { round: "asc" } });
  const round = upcomingRound(rounds) ?? rounds.at(-1) ?? (await addNextRound(id));
  if (!round) throw new ActionError(ROUND_GONE);
  return startJob(prepareInterviewJob, { applicationId: id, interviewId: round.id }, { key, applicationId: id });
});

/** A tick on "Getting ready", with when. */
export const tickPrep = action(
  z.object({ id: z.string().min(1), interviewId: z.string().min(1), index: z.number().int().min(0), done: z.boolean() }),
  async ({ id, interviewId, index, done }) => {
    if (!(await tickPrepItem(id, interviewId, index, done))) throw new ActionError(ROUND_GONE);
    refresh(id);
    return null;
  },
);

/** A round's length, place, people and notes, by hand. */
export const updateInterview = action(
  z.object({
    id: z.string().min(1),
    interviewId: z.string().min(1),
    minutes: z.number().int().min(1).max(24 * 60).nullable(),
    place: z.string().trim().max(300),
    people: z.string().trim().max(2000),
    notes: z.string().trim().max(10_000),
  }),
  async ({ id, interviewId, minutes, place, people, notes }) => {
    if (!(await saveRoundDetails(id, interviewId, { minutes, place, people, notes }))) throw new ActionError(ROUND_GONE);
    refresh(id);
    return null;
  },
);

/** "Add the next round", once every round is past. */
export const addInterviewRound = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError(GONE);
  const round = await addNextRound(id);
  if (!round) throw new ActionError("There's a round still to come. Change its date instead.");
  refresh(id);
  return round;
});

// ─── The offer, and messages drafted on a click (E30-7, E30-8) ──────────────

const calendarDate = z.iso.date().nullable();

/** The offer's details, by hand. */
export const saveOffer = action(
  z.object({
    id: z.string().min(1),
    salary: z.string().trim().max(200),
    decideBy: calendarDate,
    startDate: calendarDate,
    holidays: z.string().trim().max(200),
    office: z.string().trim().max(300),
  }),
  async ({ id, ...offer }) => {
    await saveOfferDetails(id, offer);
    refresh(id);
    // Decide by shows on the board and the dashboard too.
    revalidatePath("/applications");
    revalidatePath("/");
    return null;
  },
);

/**
 * Draft an acceptance, Ask for more, Decline politely (E30-7), and Draft a
 * follow-up (E30-8): drafted in the background on this click, over any
 * draft before it. Returns the job's id.
 */
export const startWritingMessage = action(z.object({ id: z.string().min(1), kind: z.enum(MESSAGE_KINDS) }), async ({ id, kind }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError(GONE);
  if (!(await isAiConfigured())) throw new ActionError("That needs an AI provider. Choose one in Settings → AI provider.");
  return startMessageDraft(id, kind);
});

/** A drafted message, as edited by hand. */
export const saveMessageDraft = action(
  z.object({ id: z.string().min(1), subject: z.string().max(500), body: z.string().max(20_000) }),
  async ({ id, subject, body }) => {
    const application = await prisma.application.findUnique({ where: { id }, select: { messageDraft: true } });
    const draft = messageDraftSchema.safeParse(application?.messageDraft);
    if (!draft.success) throw new ActionError("That draft is gone. Draft it again.");
    await prisma.application.update({ where: { id }, data: { messageDraft: { ...draft.data, subject, body } } });
    return null;
  },
);

/** "I sent it": sent some other way, so it's let go and "Quiet for" starts again (decided 17 November). */
export const markMessageSent = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  if (!(await letMessageDraftGo(id, { sent: true }))) throw new ActionError(GONE);
  refresh(id);
  revalidatePath("/applications");
  revalidatePath("/");
  return null;
});

/** Lets a drafted message go, unsent. */
export const discardMessageDraft = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  await letMessageDraftGo(id, { sent: false });
  refresh(id);
  return null;
});

// ─── Known gaps (E30-5) ──────────────────────────────────────────────────────

/** "I don't have this" on a gap: it's never asked about again for this application. */
export const markKnownGap = action(z.object({ id: z.string().min(1), requirement: z.string().trim().min(1).max(2000) }), async ({ id, requirement }) => {
  if (!(await prisma.application.count({ where: { id } }))) throw new ActionError(GONE);
  await prisma.knownGap.upsert({ where: { applicationId_requirement: { applicationId: id, requirement } }, create: { applicationId: id, requirement }, update: {} });
  refresh(id);
  return null;
});

/** Undo on "I don't have this". */
export const forgetKnownGap = action(z.object({ id: z.string().min(1), requirement: z.string().trim().min(1).max(2000) }), async ({ id, requirement }) => {
  await prisma.knownGap.deleteMany({ where: { applicationId: id, requirement } });
  refresh(id);
  return null;
});

// Private notes (E8-9, APP-14), kept by src/lib/application-notes.ts. They
// never go into a prompt: no AI task reads the Note table.

export const addNote = action(z.object({ id: z.string().min(1), body: noteBody }), async ({ id, body }) => {
  await addApplicationNote(id, body);
  refresh(id);
  return null;
});

export const updateNote = action(
  z.object({ id: z.string().min(1), noteId: z.string().min(1), body: noteBody }),
  async ({ id, noteId, body }) => {
    await updateApplicationNote(id, noteId, body);
    refresh(id);
    return null;
  },
);

/** Deletes a note at once; it comes back with its date through `restoreNote` (Undo on the toast). */
export const deleteNote = action(z.object({ id: z.string().min(1), noteId: z.string().min(1) }), async ({ id, noteId }) => {
  const note = await deleteApplicationNote(id, noteId);
  refresh(id);
  return { body: note.body, createdAt: note.createdAt.toISOString(), updatedAt: note.updatedAt.toISOString() };
});

export const restoreNote = action(
  z.object({ id: z.string().min(1), body: noteBody, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  async ({ id, body, createdAt, updatedAt }) => {
    await restoreApplicationNote(id, { body, createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) });
    refresh(id);
    return null;
  },
);

/**
 * "Leave out" (#217): takes a part off the tailored resume. It's listed with
 * what the page limit left out, so "Put back" brings it back to its place.
 * Returns where it is in that list, for Undo.
 */
export const leaveOutUnit = action(z.object({ id: z.string().min(1), unitId: z.string().min(1) }), async ({ id, unitId }) => {
  const index = await leaveOut(id, unitId);
  refresh(id);
  return { index };
});

/**
 * "Put back" (E10-10, #217): restores a part or bullets left out, by hand or
 * to fit the page limit. Putting back twice changes nothing more.
 */
export const putBackTrimmed = action(z.object({ id: z.string().min(1), index: z.number().int().min(0) }), async ({ id, index }) => {
  await putBack(id, index);
  refresh(id);
  return null;
});

// ─── Versions (E8-10, APP-13) ────────────────────────────────────────────────

/** A document's versions, newest first, without their units. */
export const listVersions = action(z.object({ id: z.string().min(1), document: z.enum(DocumentKind) }), ({ id, document }) => listDocumentVersions(id, document));

/** One version's units, to look at before restoring it. */
export const loadVersion = action(z.object({ id: z.string().min(1), versionId: z.string().min(1) }), ({ id, versionId }) => loadDocumentVersion(id, versionId));

/**
 * "Restore this version" over an earlier version shown in place (E8-10).
 * The document as it is now is saved as a version first (unless it's
 * already the newest), so nothing is lost, and the restored state becomes a
 * version of its own.
 */
export const restoreVersion = action(z.object({ id: z.string().min(1), versionId: z.string().min(1) }), async ({ id, versionId }, { toast }) => {
  const kind = (await restoreDocumentVersion(id, versionId))!;
  toast(`Restored the ${DOCUMENT_LABELS[kind].toLowerCase()} as it was then. The version you had is in the history too.`);
  refresh(id);
  return null;
});

/**
 * Undo on the latest change, and "Go back to this" on an older one
 * (E30-11, AP2): brings back each version given, one per document, as a
 * new version. Returns the documents that changed.
 */
export const goBackTo = action(z.object({ id: z.string().min(1), versionIds: z.array(z.string().min(1)).min(1).max(3) }), async ({ id, versionIds }) => {
  const changed = await goBackToVersions(id, versionIds);
  refresh(id);
  return changed;
});

// ─── A document it was created without (#367) ──────────────────────────────

/**
 * "Write the cover letter" (or resume) on an application created without
 * it: writes it in the background and returns the job's id. Asking again
 * while it's being written follows the same job.
 */
export const startWritingDocument = action(
  z.object({ id: z.string().min(1), kind: z.enum([DocumentKind.RESUME, DocumentKind.COVER_LETTER]) }),
  async ({ id, kind }) => {
    const application = await prisma.application.findUnique({ where: { id }, select: { documents: { select: { kind: true } } } });
    if (!application) throw new ActionError(GONE);
    if (application.documents.some((document) => document.kind === kind)) throw new ActionError("It's been written already. Reload the page to see it.");
    if (!(await isAiConfigured())) throw new ActionError("That needs an AI provider. Choose one in Settings → AI provider.");
    const key = writeDocumentJobKey(id, kind);
    const [running] = await findUnfinishedJobs(key);
    return running?.id ?? startJob(writeDocumentJob, { applicationId: id, kind }, { key, applicationId: id });
  },
);

// ─── The letter's tone and language (E30-9) ─────────────────────────────────

/**
 * Another tone or language on the cover letter's toolbar: kept on the
 * application, then the letter is written again in it, in the background,
 * through the writing job (AP3); it doesn't translate. Returns the job's id.
 */
export const rewriteLetter = action(
  z.object({ id: z.string().min(1), tone: z.enum(Tone).optional(), language: z.string().trim().min(1).max(60).optional() }),
  async ({ id, tone, language }) => {
    const application = await prisma.application.findUnique({ where: { id }, select: { documents: { where: { kind: DocumentKind.COVER_LETTER }, select: { id: true } } } });
    if (!application) throw new ActionError(GONE);
    if (application.documents.length === 0) throw new ActionError("Write the cover letter first.");
    if (!(await isAiConfigured())) throw new ActionError("That needs an AI provider. Choose one in Settings → AI provider.");
    const key = writeDocumentJobKey(id, DocumentKind.COVER_LETTER);
    const [running] = await findUnfinishedJobs(key);
    if (running) throw new ActionError("The letter is being written already. Try again once it's done.");
    await prisma.application.update({ where: { id }, data: { ...(tone ? { tone } : {}), ...(language ? { language } : {}) } });
    refresh(id);
    return startJob(writeDocumentJob, { applicationId: id, kind: DocumentKind.COVER_LETTER, rewrite: true }, { key, applicationId: id });
  },
);

// ─── Check again (E30-1) ─────────────────────────────────────────────────────

/** "Check again" next to the coverage ring: checks the requirements against the profile as it is now, in the background, and returns the job's id. */
export const startCheckingRequirements = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  const application = await prisma.application.findUnique({ where: { id }, select: { postingText: true } });
  if (!application) throw new ActionError(GONE);
  if (!application.postingText.trim()) throw new ActionError("This application has no posting to check against.");
  const problem = await scoringProblem();
  if (problem) throw new ActionError(problem);
  const key = checkRequirementsJobKey(id);
  const [running] = await findUnfinishedJobs(key);
  return running?.id ?? startJob(checkRequirementsJob, { applicationId: id }, { key, applicationId: id });
});

// ─── The email (Email tab) ───────────────────────────────────────────────────

/**
 * "Write the email" and "Rewrite": writes the application's email in the
 * background and returns the job's id. Asking again while it's being
 * written follows the same job.
 */
export const startWritingEmail = action(z.object({ id: z.string().min(1) }), ({ id }) => writeApplicationEmail(id));

/**
 * Undo on the "Rewrote the email." toast: puts back the email the rewrite
 * replaced, unless it has changed again since.
 */
export const undoEmailRewrite = action(z.object({ id: z.string().min(1), jobId: z.string().min(1) }), async ({ id, jobId }) => {
  await putBackEmail(id, jobId);
  refresh(id);
  return null;
});

// ─── Writing a new application (E31-5) ───────────────────────────────────────

/** *Stop* while New application writes the documents: what's written stays (NA1). */
export const stopWritingApplication = action(z.object({ id: z.string().min(1) }), async ({ id }) => {
  for (const job of await findUnfinishedJobs(writeApplicationJobKey(id))) await cancelJob(job.id);
  refresh(id);
  return null;
});
