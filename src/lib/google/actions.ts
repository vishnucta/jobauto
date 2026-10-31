"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ApplicationStatus } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { applySecretChange, GOOGLE_CLIENT_SECRET } from "@/lib/secrets";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { statusInfo } from "@/lib/status";

import { disconnectGoogle } from "./account";
import { GoogleError } from "./errors";
import { loadGoogleClientConfig } from "./oauth";
import {
  confirmInterviewTime,
  dismissReply,
  linkThread,
  readReplyAgain,
  saveReplyText,
  setReplyHandled,
  slotsToOffer,
  startReplyDraft,
  takeSuggestedStatus,
} from "./replies";
import { sendApplicationEmail, sendReply } from "./send";
import { googleSettingsSchema, saveGoogleSettingChanges } from "./settings";
import { checkInboxNow } from "./sync";

// Gmail and Calendar from the app (E15). Google's failures reach the user as
// their own message; every send is a separate, confirmed request.

const refreshEverything = () => revalidatePath("/", "layout");

/** Runs `work`, turning a GoogleError into a message for the user. */
async function google<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GoogleError) throw new ActionError(error.message);
    throw error;
  }
}

/** Settings → Google: what each switch and field saves. */
export const saveGoogleSettings = action(googleSettingsSchema, async (changes) => {
  await saveGoogleSettingChanges(changes);
  return null;
});

/** What Settings → Google shows of the OAuth client: the ID, and only whether a secret is there. */
const clientView = async () => {
  const { id, idState, secretState } = await loadGoogleClientConfig();
  return { id, idState, secretState };
};

/**
 * Saves the OAuth client in Settings → Google: the ID as typed (empty
 * removes it), the secret encrypted, or removed. The secret never comes
 * back to the browser. A different client ID can't use the old grant, so
 * changing it disconnects the account.
 */
export const saveGoogleClient = action(
  z.strictObject({
    id: z.string().trim().max(300).optional(),
    secret: z
      .discriminatedUnion("action", [z.object({ action: z.literal("set"), value: z.string().trim().min(1).max(500) }), z.object({ action: z.literal("clear") })])
      .optional(),
  }),
  async ({ id, secret }) => {
    const current = await loadSettings();
    const before = await loadGoogleClientConfig();
    await saveSettings({
      ...(id === undefined ? {} : { googleClientId: id || null }),
      ...(secret === undefined ? {} : { googleClientSecretEnc: applySecretChange(GOOGLE_CLIENT_SECRET, current.googleClientSecretEnc, secret) }),
    });
    // Google's grant belongs to the client ID; a new secret for the same client keeps it.
    if (before.id && before.id !== (await loadGoogleClientConfig()).id) await disconnectGoogle().catch(() => {});
    revalidatePath("/settings");
    return clientView();
  },
);

/** "Disconnect": revokes Dossier's access at Google. Mail already in Dossier stays. */
export const disconnectGoogleAccount = action(z.object({}), async (_, { toast }) => {
  await google(disconnectGoogle);
  revalidatePath("/settings");
  toast("Disconnected from Google.");
  return null;
});

/** "Check now" in the inbox and Settings. */
export const checkInbox = action(z.object({}), async (_, { toast }) => {
  const result = await google(checkInboxNow);
  refreshEverything();
  if (!result) toast("Already checking. It'll be done in a moment.");
  else toast(result.kept === 0 ? "Nothing new about your applications." : `${result.kept} new ${result.kept === 1 ? "email" : "emails"} about your applications.`);
  return result;
});

/** "Send with Gmail" on the Email tab, after the confirmation. */
export const sendWithGmail = action(z.object({ id: z.string().min(1) }), async ({ id }, { toast }) => {
  const sent = await google(() => sendApplicationEmail(id));
  refreshEverything();
  toast(sent.eventId ? `Sent. ${statusInfo(ApplicationStatus.SENT).toast}` : "Sent. I'll watch for replies.");
  return { eventId: sent.eventId };
});

/** Drafts (or redrafts) the answer to an email in the background. */
export const startDraftingReply = action(
  z.object({ emailId: z.string().min(1), note: z.string().max(2000).default(""), slots: z.array(z.iso.datetime({ offset: true })).max(8).nullable().default(null) }),
  async (input) => startReplyDraft(input),
);

/** Saves the answer as edited by hand. */
export const saveReplyDraft = action(z.object({ emailId: z.string().min(1), body: z.string().max(20_000) }), async ({ emailId, body }) => {
  await saveReplyText(emailId, body);
  return null;
});

/** "Send" on a drafted answer, after the confirmation. */
export const sendReplyEmail = action(z.object({ emailId: z.string().min(1), body: z.string().min(1).max(20_000) }), async ({ emailId, body }, { toast }) => {
  await google(() => sendReply(emailId, body));
  refreshEverything();
  toast("Answer sent.");
  return null;
});

/** "No answer needed": takes it off the list. */
export const markHandled = action(z.object({ emailId: z.string().min(1), handled: z.boolean() }), async ({ emailId, handled }) => {
  await setReplyHandled(emailId, handled);
  refreshEverything();
  return null;
});

/** Links a mail to an application ("Needs a look"), with the rest of its thread. Null unlinks. */
export const linkEmail = action(z.object({ emailId: z.string().min(1), applicationId: z.string().min(1).nullable() }), async ({ emailId, applicationId }, { toast }) => {
  await linkThread(emailId, applicationId);
  refreshEverything();
  toast(applicationId ? "Linked. Replies in this thread will go there too." : "Unlinked.");
  return null;
});

/** "Not job-related": hidden from the inbox, and not fetched again; only its ids stay. */
export const dismissEmail = action(z.object({ emailId: z.string().min(1) }), async ({ emailId }, { toast }) => {
  await dismissReply(emailId);
  refreshEverything();
  toast("Hidden from your inbox.");
  return null;
});

/** "Read again": the AI reads a mail it couldn't before. */
export const rereadEmail = action(z.object({ emailId: z.string().min(1) }), async ({ emailId }) => {
  await readReplyAgain(emailId);
  refreshEverything();
  return null;
});

/** Takes up a reply's suggested status (or turns it down), through the status module. */
export const applySuggestedStatus = action(z.object({ emailId: z.string().min(1), accept: z.boolean() }), async ({ emailId, accept }, { toast }) => {
  const taken = await takeSuggestedStatus(emailId, accept);
  if (!taken) return { eventId: null };
  refreshEverything();
  if (!taken.eventId) return { eventId: null };
  toast(statusInfo(taken.status).toast);
  return { eventId: taken.eventId };
});

/** Free times to offer, for the reply's slot picker. */
export const loadFreeSlots = action(z.object({}), async () => google(slotsToOffer));

/** "Add to calendar" for an agreed time: the dashboard's next interview, the calendar, and Interview. */
export const confirmInterview = action(
  z.object({ emailId: z.string().min(1), start: z.iso.datetime({ offset: true }), moveToInterview: z.boolean() }),
  async ({ emailId, start, moveToInterview }, { toast }) => {
    const { eventLink, eventId } = await google(() => confirmInterviewTime({ emailId, start: new Date(start), moveToInterview }));
    refreshEverything();
    toast(eventLink ? "Interview added to your calendar and dashboard." : "Interview added to your dashboard.");
    return { eventLink, eventId };
  },
);
