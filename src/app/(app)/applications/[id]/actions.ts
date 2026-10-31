"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { DocumentKind } from "@/generated/prisma/enums";
import { action } from "@/lib/action";
import { addApplicationNote, deleteApplicationNote, noteBody, restoreApplicationNote, updateApplicationNote } from "@/lib/application-notes";
import { leaveOut, putBack, saveUnitText } from "@/lib/document-edits";
import { listDocumentVersions, loadDocumentVersion, restoreDocumentVersion } from "@/lib/document-history";
import { setDocumentLook } from "@/lib/document-look";
import { restoreUnitText, sendChatMessage, startUnitRewrite, undoChatMessage } from "@/lib/document-rewrites";
import { putBackEmail, writeApplicationEmail } from "@/lib/email-writing";
import { DOCUMENT_LABELS } from "@/lib/file-name";
import { followInCalendar, saveInterviewDate } from "@/lib/interview-date";
import { addMissingSkill } from "@/lib/match-skills";

const refresh = (id: string) => revalidatePath(`/applications/${id}`);

// The tailored documents' looks, edits, AI changes and versions are made by
// src/lib/document-look.ts, document-edits.ts, document-rewrites.ts and
// document-history.ts, which the Claude connector uses too.

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
 * The next interview's date and time (E9-9), or null to remove it. It shows
 * on the dashboard's "Worth a look" while the application is in Interview,
 * and while Dossier keeps interviews in Google Calendar, the event is added,
 * moved or deleted to match.
 */
export const setInterviewDate = action(
  z.object({ id: z.string().min(1), at: z.iso.datetime().nullable() }),
  async ({ id, at }, { toast }) => {
    const moment = at ? new Date(at) : null;
    await saveInterviewDate(id, moment);
    refresh(id);
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
  }),
  async ({ id, text, viewing, target }) => {
    const sent = await sendChatMessage({ applicationId: id, text, viewing, target });
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
export const addMatchSkill = action(z.object({ id: z.string().min(1), index: z.number().int().min(0) }), async ({ id, index }) => {
  const added = await addMissingSkill(id, index);
  refresh(id);
  return added;
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
 * Brings back an earlier version. The document as it is now is saved as a
 * version first (unless it's already the newest), so nothing is lost, and
 * the restored state becomes a version of its own.
 */
export const restoreVersion = action(z.object({ id: z.string().min(1), versionId: z.string().min(1) }), async ({ id, versionId }, { toast }) => {
  const kind = await restoreDocumentVersion(id, versionId);
  toast(`Restored the ${DOCUMENT_LABELS[kind].toLowerCase()} as it was then. The version you had is in the history too.`);
  refresh(id);
  return null;
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
