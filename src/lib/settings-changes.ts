import "server-only";

import { z } from "zod";

import { AiProvider, Creativity, DateFormat, PaperSize, Tone } from "@/generated/prisma/enums";
import { AiError, createProvider } from "@/lib/ai";
import { keyStateOf, loadAiConfig, resolveAiConfig } from "@/lib/ai/config";
import type { KeyState } from "@/lib/ai/provider-options";
import { DOCUMENT_LANGUAGES } from "@/lib/document-language";
import { env } from "@/lib/env";
import { JobSearchError, testSource } from "@/lib/job-search";
import { credentialsFor, jobSearchView, loadJobSearchConfig, requestContext } from "@/lib/job-search/config";
import { JOB_SOURCES, JSEARCH_HOSTS } from "@/lib/job-search/search";
import type { JobSearchSettingsView } from "@/lib/job-search/sources";
import { startJob } from "@/lib/jobs/runner";
import { countTailoredDocuments, zipPdfsJob } from "@/lib/jobs/zip-pdfs";
import { isJobRetention } from "@/lib/settings";
import { loadSettings, saveSettings } from "@/lib/settings-data";

// What Settings saves and tests (SET-1, SET-2, E10-2, E10-3, E10-5, E14-4),
// for its actions and the Claude connector (#221). Keys are saved in
// Settings only: nothing here takes one, or gives one back.

// ─── AI provider (E6-3) ──────────────────────────────────────────────────────

/** Whether a key is in play for the provider in effect, and where it comes from; never the key. */
export async function aiKeyState(): Promise<KeyState> {
  const saved = await loadSettings();
  return keyStateOf(saved, resolveAiConfig(saved, env));
}

/** The provider, server address and model, as Settings → AI provider saves them together. */
export const aiChoiceSchema = z.object({
  provider: z.enum(AiProvider),
  // Saved as typed: a half-typed address is harmless, and the connection test explains a wrong one.
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
});
export type AiChoice = z.output<typeof aiChoiceSchema>;

/**
 * Saves the provider, server address and model (SET-1). A key belongs to
 * its provider: switching provider removes it, so it's never sent to
 * another company's server. Answers with the key's state after.
 */
export async function saveAiChoice({ provider, baseUrl, model }: AiChoice): Promise<KeyState> {
  const current = await loadSettings();
  await saveSettings({
    provider,
    baseUrl: baseUrl || null,
    model: model || null,
    ...(current.provider !== provider ? { apiKeyEnc: null } : {}),
  });
  return aiKeyState();
}

/** The models the saved server offers, for the model select, or why they can't be listed. */
export async function availableAiModels(): Promise<{ models: string[]; problem: string | null }> {
  try {
    const provider = createProvider(await loadAiConfig());
    return { models: await provider.listModels(AbortSignal.timeout(15_000)), problem: null };
  } catch (error) {
    if (error instanceof AiError) return { models: [], problem: error.message };
    throw error;
  }
}

/** A test connection on a stop-watch has no business waiting minutes. */
const TEST_TIMEOUT_MS = 60_000;

/** "Test connection" (SET-2): a short prompt to the saved provider, timed. */
export async function testAiProvider(): Promise<{ connected: true; model: string; seconds: number } | { connected: false; message: string }> {
  try {
    const config = await loadAiConfig();
    const provider = createProvider({ ...config, timeoutMs: Math.min(config.timeoutMs, TEST_TIMEOUT_MS) });
    const { model, latencyMs } = await provider.test();
    return { connected: true, model, seconds: Math.round(latencyMs / 100) / 10 };
  } catch (error) {
    if (error instanceof AiError) return { connected: false, message: error.message };
    throw error;
  }
}

// ─── Job search (E14-4) ──────────────────────────────────────────────────────
// Each answers with what Settings → Job search shows, never a key.

/** What Settings → Job search shows now. */
export const loadJobSearchView = async (): Promise<JobSearchSettingsView> => jobSearchView(await loadJobSearchConfig());

/** A source to search, or Off. */
export const jobSourceChoiceSchema = z.enum([...JOB_SOURCES, "OFF"]);
export type JobSourceChoice = z.output<typeof jobSourceChoiceSchema>;

/**
 * Picks the source to search, or Off. The Bundesagentur für Arbeit only with
 * its note accepted, now (`accepted`) or before, and only while the server
 * offers it (#223); otherwise it says which of the two is missing.
 */
export async function chooseJobSource(source: JobSourceChoice, accepted = false): Promise<JobSearchSettingsView | "not-offered" | "not-accepted"> {
  const accepting = source === "ARBEITSAGENTUR" && accepted;
  if (source === "ARBEITSAGENTUR") {
    const { arbeitsagentur } = await loadJobSearchConfig();
    if (!arbeitsagentur.offered) return "not-offered";
    if (!accepting && !arbeitsagentur.acceptedAt) return "not-accepted";
  }
  await saveSettings({ jobSource: source, ...(accepting ? { arbeitsagenturAcceptedAt: new Date().toISOString() } : {}) });
  return loadJobSearchView();
}

/** Where the JSearch key is from, and the Adzuna app ID, which isn't a secret. */
export const jobSearchDetailsSchema = z.strictObject({ jsearchHost: z.enum(JSEARCH_HOSTS).optional(), adzunaAppId: z.string().trim().max(200).optional() });

/** Saves the details given; an empty app ID removes it. */
export async function saveJobSourceDetails({ jsearchHost, adzunaAppId }: z.output<typeof jobSearchDetailsSchema>): Promise<JobSearchSettingsView> {
  await saveSettings({ jsearchHost, ...(adzunaAppId === undefined ? {} : { adzunaAppId: adzunaAppId || null }) });
  return loadJobSearchView();
}

/** "Test connection": the smallest request the chosen source takes, timed. */
export async function testJobSourceConnection(): Promise<{ connected: true; seconds: number } | { connected: false; message: string }> {
  const config = await loadJobSearchConfig();
  if (!config.source) return { connected: false, message: "Choose a source first." };
  const started = performance.now();
  try {
    await testSource(config.source, credentialsFor(config, config.source), requestContext(config.source));
    return { connected: true, seconds: Math.round((performance.now() - started) / 100) / 10 };
  } catch (error) {
    if (error instanceof JobSearchError) return { connected: false, message: error.message };
    throw error;
  }
}

// ─── Choices and switches (E10-2, E10-3) ─────────────────────────────────────

/** The settings that are a plain choice or switch, each saved as it changes; only the fields given are touched. */
export const settingChoicesSchema = z.strictObject({
  creativity: z.enum(Creativity).optional(),
  strict: z.boolean().optional(),
  showDiff: z.boolean().optional(),
  paper: z.enum(PaperSize).optional(),
  dateFormat: z.enum(DateFormat).optional(),
  defaultTone: z.enum(Tone).optional(),
  /** A language name, or null for the posting's language. */
  docLanguage: z.string().trim().min(1).max(60).nullable().optional(),
  /** One of the built-in languages, or null for English. */
  resumeLanguage: z
    .string()
    .refine((name) => DOCUMENT_LANGUAGES.some((language) => language.name === name), "Pick a language from the list.")
    .nullable()
    .optional(),
  fileNamePattern: z.string().max(200).optional(),
  includeRefs: z.boolean().optional(),
  pageLimit: z.enum(["1", "2", "none"]).optional(),
  nightlyBackup: z.boolean().optional(),
  jobRetentionHours: z.number().refine(isJobRetention).optional(),
  updateCheck: z.boolean().optional(),
});
export type SettingChoices = z.output<typeof settingChoicesSchema>;

/**
 * "Other language…" (SET-7): adds a language to the list and writes
 * documents in it. A name already in the list, in any case, is just picked.
 */
export async function pickDocumentLanguage(name: string): Promise<{ language: string; added: boolean }> {
  const { customLanguages } = await loadSettings();
  const known = [...DOCUMENT_LANGUAGES.map((language) => language.name), ...customLanguages];
  const existing = known.find((language) => language.toLocaleLowerCase() === name.toLocaleLowerCase());
  await saveSettings({ docLanguage: existing ?? name, ...(existing ? {} : { customLanguages: [...customLanguages, name] }) });
  return { language: existing ?? name, added: !existing };
}

// ─── Your data (E10-5) ───────────────────────────────────────────────────────

/** "Download all PDFs": zips every tailored document in the background; null when there are none yet. */
export async function startPdfZip(): Promise<{ jobId: string; documents: number } | null> {
  const documents = await countTailoredDocuments();
  if (documents === 0) return null;
  return { jobId: await startJob(zipPdfsJob, {}), documents };
}
