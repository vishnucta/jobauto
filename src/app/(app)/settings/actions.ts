"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { AiProvider, JobStatus } from "@/generated/prisma/enums";
import { action, ActionError } from "@/lib/action";
import { lockAgentSearches } from "@/lib/agent/searches";
import { AiError } from "@/lib/ai";
import { applyApiKeyChange } from "@/lib/ai/api-key";
import { deleteAllApplyData } from "@/lib/apply/files";
import { forgetRemovedProfileEntries } from "@/lib/connector/removed-entries";
import { deleteAllBackups } from "@/lib/backups";
import { cancelJob } from "@/lib/jobs/runner";
import { checkForUpdate } from "@/lib/update-check";
import { redirectProblem } from "@/lib/connector/oauth";
import { deleteAllDownloads } from "@/lib/jobs/zip-pdfs";
import { disconnectGoogle } from "@/lib/google/account";
import { prisma } from "@/lib/prisma";
import { jevKey, loadScoringConfig, scoringView } from "@/lib/scoring/config";
import { SCORERS } from "@/lib/scoring/scorers";
import { askJev } from "@/lib/scoring/typesafe";
import { applySecretChange, JOB_SOURCE_KEY, TYPESAFE_KEY } from "@/lib/secrets";
import {
  aiChoiceSchema,
  aiKeyState,
  availableAiModels,
  chooseJobSource,
  jobSearchDetailsSchema,
  jobSourceChoiceSchema,
  loadJobSearchView,
  pickDocumentLanguage,
  saveAiChoice,
  saveJobSourceDetails,
  settingChoicesSchema,
  startPdfZip,
  TEST_TIMEOUT_MS,
  testAiProvider,
  testJobSourceConnection,
} from "@/lib/settings-changes";

import { seedBuiltIns } from "../../../../prisma/seed/built-ins";
import { loadSettings, saveSettings } from "@/lib/settings-data";

// Settings → AI provider (E6-3). Every field saves on its own, so a test
// or a model list always reflects what's saved. What the actions save and
// test is in src/lib/settings-changes.ts, which the Claude connector uses too.

/** Saves the provider, server address and model (SET-1); switching provider removes the key. */
export const saveAiProvider = action(aiChoiceSchema, async (choice) => ({ keyState: await saveAiChoice(choice) }));

/** Saves a new API key, encrypted (E6-2), or removes it. The key never comes back to the browser. */
export const saveApiKey = action(
  z.object({
    provider: z.enum(AiProvider),
    change: z.discriminatedUnion("action", [
      z.object({ action: z.literal("set"), value: z.string().trim().min(1).max(1000) }),
      z.object({ action: z.literal("clear") }),
    ]),
  }),
  async ({ provider, change }) => {
    const current = await loadSettings();
    await saveSettings({
      apiKeyEnc: applyApiKeyChange(current.apiKeyEnc, change),
      // Until now the provider came from DOSSIER_AI_*; the key makes it a saved choice.
      ...(current.provider ? {} : { provider }),
    });
    return { keyState: await aiKeyState() };
  },
);

/** The models the saved server offers, for the model select. */
export const listAiModels = action(z.object({}), () => availableAiModels());

/** "Test connection" (SET-2): a short prompt to the saved provider, timed. */
export const testAiConnection = action(z.object({}), () => testAiProvider());

// Settings → Job search (E14-4). Every field saves on its own; each returns
// what the section shows, never a key.

/**
 * Picks the source to search, or Off. The Bundesagentur für Arbeit only with
 * its note accepted, now (`accepted`) or before, and only while the server
 * offers it (#223).
 */
export const saveJobSource = action(
  z.object({ source: jobSourceChoiceSchema, accepted: z.literal(true).optional() }),
  async ({ source, accepted }) => {
    const view = await chooseJobSource(source, accepted === true);
    if (view === "not-offered") throw new ActionError("The Bundesagentur für Arbeit isn't offered on this server.");
    if (view === "not-accepted") throw new ActionError("Tick “I understand” under the note about the Bundesagentur für Arbeit first.");
    return view;
  },
);

/** Saves where the JSearch key is from, or the Adzuna app ID, which isn't a secret. */
export const saveJobSearchDetails = action(jobSearchDetailsSchema, (details) => saveJobSourceDetails(details));

/** Where each keyed job source's key is saved. */
const JOB_KEY_FIELDS = { JSEARCH: "jsearchKeyEnc", SERPAPI: "serpapiKeyEnc", ADZUNA: "adzunaKeyEnc", JOOBLE: "joobleKeyEnc" } as const;

/** Saves a source's key, encrypted for job sources only, or removes it. The key never comes back to the browser. */
export const saveJobSourceKey = action(
  z.object({
    source: z.enum(["JSEARCH", "SERPAPI", "ADZUNA", "JOOBLE"]),
    change: z.discriminatedUnion("action", [
      z.object({ action: z.literal("set"), value: z.string().trim().min(1).max(1000) }),
      z.object({ action: z.literal("clear") }),
    ]),
  }),
  async ({ source, change }) => {
    const field = JOB_KEY_FIELDS[source];
    const current = await loadSettings();
    await saveSettings({ [field]: applySecretChange(JOB_SOURCE_KEY, current[field], change) });
    return loadJobSearchView();
  },
);

/** "Test connection": the smallest request the chosen source takes, timed. */
export const testJobSource = action(z.object({}), () => testJobSourceConnection());

// Settings → Scoring (#274). Each returns what the section shows, never the key.

const loadScoringView = async () => scoringView(await loadScoringConfig());

/** What scores postings: the AI model, or Jev. */
export const saveScorer = action(z.object({ scorer: z.enum(SCORERS) }), async ({ scorer }) => {
  await saveSettings({ scorer });
  return loadScoringView();
});

/** Saves the TypeSafe key, encrypted for it only, or removes it. */
export const saveTypesafeKey = action(
  z.object({
    change: z.discriminatedUnion("action", [
      z.object({ action: z.literal("set"), value: z.string().trim().min(1).max(1000) }),
      z.object({ action: z.literal("clear") }),
    ]),
  }),
  async ({ change }) => {
    const current = await loadSettings();
    await saveSettings({ typesafeKeyEnc: applySecretChange(TYPESAFE_KEY, current.typesafeKeyEnc, change) });
    return loadScoringView();
  },
);

/** "Test connection": one yes-or-no question to Jev about a sentence, timed. It costs a few dozen tokens. */
export const testJev = action(z.object({}), async () => {
  const jev = jevKey(await loadScoringConfig());
  if (jev.problem !== null) return { connected: false as const, message: jev.problem };
  const started = performance.now();
  try {
    const { model } = await askJev(
      { state: "Dossier is checking that it can reach Jev.", questions: { check: { type: "noul", instructions: "Is this text about checking a connection?" } } },
      { key: jev.key, timeoutMs: TEST_TIMEOUT_MS, retryDelaysMs: [] },
    );
    return { connected: true as const, model, seconds: Math.round((performance.now() - started) / 100) / 10 };
  } catch (error) {
    if (error instanceof AiError) return { connected: false as const, message: error.message };
    throw error;
  }
});

/**
 * Saves the settings that are a plain choice or switch, each as it changes
 * (E10-2, E10-3). Only the fields given are touched.
 */
export const updateSettings = action(settingChoicesSchema, async (changes) => {
  await saveSettings(changes);
  return null;
});

/** "Other language…" (SET-7): adds a language to the list and writes documents in it, or picks one already there. */
export const addDocumentLanguage = action(z.object({ name: z.string().trim().min(1, "Type a language first.").max(60) }), ({ name }) => pickDocumentLanguage(name));

/** "Download all PDFs" (E10-5): zips every tailored document in the background. */
export const startZippingPdfs = action(z.object({}), async () => {
  const zip = await startPdfZip();
  if (!zip) throw new ActionError("There are no tailored documents to download yet.");
  return zip;
});

/**
 * "Delete for good" (E10-8, SET-11): removes the profile, every application
 * with its documents, custom themes, settings, background jobs, the
 * backup and download files and the apply assistant's runs and browser
 * profile, then puts back what a new install has. The
 * session stays; the user lands on the empty dashboard.
 */
export const deleteEverything = action(z.object({ confirm: z.literal("DELETE") }), async () => {
  const unfinished = await prisma.job.findMany({ where: { status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } }, select: { id: true } });
  for (const job of unfinished) await cancelJob(job.id);
  // Revokes Dossier's access at Google too (E15-1).
  await disconnectGoogle().catch(() => {});

  await prisma.$transaction(async (tx) => {
    await lockAgentSearches(tx);
    await tx.job.deleteMany();
    // The tokens each AI request used (#290).
    await tx.aiUsage.deleteMany();
    // Find jobs' postings and past searches (E14-9, E14-10).
    await tx.posting.deleteMany();
    await tx.postingSearch.deleteMany();
    // Postings pasted for Claude chat (#221); the connector goes off with the settings.
    await tx.claudePaste.deleteMany();
    // What the job agent found (E16).
    await tx.agentCandidate.deleteMany();
    await tx.agentSearch.deleteMany();
    await tx.postingScore.deleteMany();
    // Startups, and the fingerprints of ones removed for good (#222).
    await tx.startup.deleteMany();
    await tx.startupBlock.deleteMany();
    // Recruiters, and their history with them, and the agencies removed from the list.
    await tx.recruiter.deleteMany();
    await tx.recruiterBlock.deleteMany();
    // Mail fetched from Gmail (E15-3).
    await tx.emailMessage.deleteMany();
    // Applications take their history, documents, chat and notes along.
    await tx.application.deleteMany();
    await tx.experience.deleteMany();
    await tx.project.deleteMany();
    await tx.skill.deleteMany();
    await tx.language.deleteMany();
    await tx.education.deleteMany();
    await tx.certification.deleteMany();
    await tx.publication.deleteMany();
    await tx.reference.deleteMany();
    await tx.customSection.deleteMany();
    await tx.fact.deleteMany();
    await tx.profileField.deleteMany();
    await tx.theme.deleteMany({ where: { builtIn: false } });
    await tx.setting.deleteMany();
  });
  // An empty profile and default settings need no rows; the built-in themes do.
  await seedBuiltIns(prisma);
  await Promise.all([deleteAllBackups(), deleteAllDownloads(), deleteAllApplyData()]);
  // Profile entries Claude removed can't be put back into the new, empty profile.
  forgetRemovedProfileEntries();

  revalidatePath("/", "layout");
  redirect("/");
});

/** "Check for updates" (E10-9): the latest release, asked for now, and kept for the sidebar's notice. */
export const checkUpdates = action(z.object({}), async () => {
  const result = await checkForUpdate();
  revalidatePath("/", "layout");
  return result.status === "newer" ? result : { status: result.status };
});

// Settings → MCP connector (#221, #281). Every connector token carries
// connectorEnabledAt, so a new value signs every app out.

/** Turns the MCP connector on, or off, which closes its addresses and signs every app out. */
export const setConnector = action(z.object({ on: z.boolean() }), async ({ on }) => {
  await saveSettings({ connectorEnabledAt: on ? new Date().toISOString() : null });
  return { on };
});

/** "Disconnect all apps": the connector stays on, but Claude and every other app have to connect again. */
export const disconnectApps = action(z.object({}), async (_input, { toast }) => {
  if (!(await loadSettings()).connectorEnabledAt) throw new ActionError("The MCP connector is off already.");
  await saveSettings({ connectorEnabledAt: new Date().toISOString() });
  toast("Every app is disconnected. Connect again from an app to use Dossier there.");
  return null;
});

const MAX_REDIRECTS = 10;

/** Lets another MCP app sign in, by the address it comes back to (#281). */
export const addConnectorRedirect = action(
  z.object({ uri: z.string().trim().min(1, "Paste the app's callback address first.").max(2000) }),
  async ({ uri }) => {
    const problem = redirectProblem(uri);
    if (problem) throw new ActionError(problem);
    const { connectorRedirects } = await loadSettings();
    if (connectorRedirects.includes(uri)) return { redirects: connectorRedirects };
    if (connectorRedirects.length >= MAX_REDIRECTS) throw new ActionError(`That's ${MAX_REDIRECTS} apps already. Remove one first.`);
    const redirects = [...connectorRedirects, uri];
    await saveSettings({ connectorRedirects: redirects });
    return { redirects };
  },
);

/** Stops an app signing in again by that address. One signed in already keeps its tokens until Disconnect all apps. */
export const removeConnectorRedirect = action(z.object({ uri: z.string().max(2000) }), async ({ uri }) => {
  const redirects = (await loadSettings()).connectorRedirects.filter((entry) => entry !== uri);
  await saveSettings({ connectorRedirects: redirects });
  return { redirects };
});
