import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { DocumentKind, VersionCause } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { summaryText, tailoringSummary } from "@/lib/ai/tailoring-summary";
import { loadTaskOptions } from "@/lib/ai/task-options";
import { tailorResume, writeCoverLetter } from "@/lib/ai/tasks";
import { createApplicationFromDocuments, type ApplicationClaim, type ApplicationDetails } from "@/lib/application-create";
import { calendarDay } from "@/lib/application-documents";
import { extractedOf, matchSchema, unitsSchema, type Extracted, type Unit } from "@/lib/application-data";
import { documentLabels } from "@/lib/document-labels";
import { documentLanguage } from "@/lib/document-language";
import { saveVersion } from "@/lib/document-versions";
import { letterAvailability } from "@/lib/letter-availability";
import { newFrame, withFrame } from "@/lib/letter-frame";
import { emit } from "@/lib/notifications/notify";
import { prisma } from "@/lib/prisma";
import { loadFactTexts, loadProfile } from "@/lib/profile-data";
import { loadProfileSettings, profileIdOr } from "@/lib/profiles";
import { readinessLines } from "@/lib/recruiter-eye";
import { withoutSectionsOff } from "@/lib/resume-sections";
import { DOCUMENTS_TO_WRITE, type DocumentsToWrite } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";

import { WRITE_APPLICATION_STEPS } from "./application-steps";
import { readPostingJob } from "./read-posting";
import { defineJob, type JobContext } from "./runner";
import { writeDocumentsJob } from "./write-documents";

/** The key of writing a new application's documents, to find it again from its page. */
export const writeApplicationJobKey = (applicationId: string) => `writing:${applicationId}`;

/** The posting as read, with the details as the user corrected them, for the prompts. */
function corrected(application: Parameters<typeof extractedOf>[0] & { deadline: Date | null }): Extracted {
  const orNull = (value: string) => value.trim() || null;
  return {
    ...extractedOf(application),
    title: orNull(application.title),
    company: orNull(application.company),
    role: orNull(application.role),
    location: orNull(application.location),
    mode: orNull(application.mode),
    salary: orNull(application.salary),
    deadline: application.deadline ? application.deadline.toISOString().slice(0, 10) : null,
  };
}

/** Saves a document the first time it's written; one already there (a retry) stays. */
async function saveDocument(applicationId: string, kind: DocumentKind, units: Unit[], writtenWith: string, themeId: string | null): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({ data: { applicationId, kind, units, themeId, writtenWith } });
      await saveVersion(tx, document.id, units, { cause: VersionCause.WRITTEN });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return;
    throw error;
  }
}

/**
 * Writes a new application's resume and cover letter on the server (E31-4,
 * decided 17 November 2026), into the Draft New application made first, so
 * the user can leave while it writes. Each document is saved as soon as it's
 * written: Stop keeps what's there. Once both are in, the fact guard's
 * findings go into the opening message, and "Documents written" goes out.
 */
export const writeApplicationJob = defineJob({
  type: "write-application",
  input: z.object({
    applicationId: z.string().min(1),
    /** Which documents to write (#367). */
    write: z.enum(DOCUMENTS_TO_WRITE).default("both"),
  }),
  result: z.object({ applicationId: z.string() }),
  async run({ applicationId, write }, { step, signal }) {
    await step(WRITE_APPLICATION_STEPS[0]);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId }, include: { documents: { select: { kind: true, units: true } } } });
    const [provider, options, settings, fullProfile, own, facts] = await Promise.all([
      getAiProvider(),
      loadTaskOptions(),
      loadSettings(),
      loadProfile(application.profileId),
      loadProfileSettings(application.profileId),
      loadFactTexts(applicationId),
    ]);

    await step(WRITE_APPLICATION_STEPS[1]);
    // A section that's off on the base resume isn't written about (#297).
    const profile = withoutSectionsOff(fullProfile, own.resumeSections);
    const extracted = corrected(application);
    const parsed = matchSchema.safeParse(application.match);
    const match = parsed.success ? parsed.data : { items: [] };
    const posting = application.postingText;
    const taskOptions = { ...options, language: application.language || options.language, signal };
    // On a retry, what was written before stays.
    const before = (kind: DocumentKind) => {
      const document = application.documents.find((entry) => entry.kind === kind);
      const units = document ? unitsSchema.safeParse(document.units) : null;
      return units?.success ? units.data : null;
    };
    const has = (kind: DocumentKind) => application.documents.some((document) => document.kind === kind);
    let resume: Unit[] = before(DocumentKind.RESUME) ?? [];
    let letter: Unit[] = before(DocumentKind.COVER_LETTER) ?? [];

    if (write !== "letter") {
      await step(WRITE_APPLICATION_STEPS[2]);
      if (!has(DocumentKind.RESUME)) {
        // Skills in the user's own order once they set one (public issue 62).
        const written = await tailorResume(provider, { profile, extracted, match, facts, posting, keepSkillOrder: own.skillOrder === "manual" }, taskOptions);
        resume = written.data;
        await saveDocument(applicationId, DocumentKind.RESUME, resume, written.promptVersion, own.baseThemeId);
      }
    }

    if (write !== "resume") {
      await step(WRITE_APPLICATION_STEPS[3]);
      if (!has(DocumentKind.COVER_LETTER)) {
        // Salary and start date, when the posting asks for them, from the standard answers (jobauto fork).
        const availability = letterAvailability(posting, settings.applyAnswers).say;
        // What settles a German recruiter's doubts, from the standard answers (recruiter-eye.ts, jobauto fork).
        const readiness = readinessLines(profile, settings.applyAnswers);
        const written = await writeCoverLetter(provider, { profile, extracted, match, tone: application.tone, facts, posting, availability, readiness }, taskOptions);
        // E8-11: the AI wrote the recipient and greeting; the sender and signature come from the profile, and the date is today's.
        letter = withFrame(
          written.data,
          newFrame({
            basics: profile.basics,
            company: application.company,
            location: application.location,
            date: calendarDay(),
            dateFormat: settings.dateFormat,
            lang: documentLanguage(application.language, written.data.map((unit) => unit.text).join(" ")).lang,
            labels: documentLabels(application.language),
          }),
        );
        await saveDocument(applicationId, DocumentKind.COVER_LETTER, letter, written.promptVersion, own.baseThemeId);
      }
    }

    // The fact guard marked what it couldn't back as it wrote; what it found goes into the opening message.
    await step(WRITE_APPLICATION_STEPS[4]);
    const summary = tailoringSummary({
      profile: fullProfile,
      company: application.company,
      role: application.role,
      match,
      resume,
      letter,
      tone: application.tone,
      note: facts[0] ?? "",
      references: !settings.includeRefs ? "setting-off" : extracted.asksForReferences ? "included" : "not-asked",
      strict: settings.strict,
      showChanges: settings.showDiff,
    });
    if (resume.length > 0 || letter.length > 0) await prisma.chatMessage.create({ data: { applicationId, role: "AI", text: summaryText(summary) } });
    await emit("documents.written", { applicationId, title: application.role.trim() || application.title, company: application.company, resume: resume.length > 0, letter: letter.length > 0 });
    return { applicationId };
  },
});

// ─── From a posting, in one go (jobauto fork) ────────────────────────────────
// The other way of writing an application from a posting in the background:
// read it, write the documents with Settings' tone, and create the
// application under its claim. The agent's drafts (Agent screen, Today's
// three) and Prepare it for me on Positions come here; New application
// writes into the Draft it made first, with writeApplicationJob above.

/** The application's details from what was read, as New application fills them in. */
export function detailsFrom(extracted: Extracted): ApplicationDetails {
  return {
    title: extracted.title ?? [extracted.role, extracted.company].filter(Boolean).join(" · "),
    company: extracted.company ?? "",
    role: extracted.role ?? "",
    location: extracted.location ?? "",
    mode: extracted.mode ?? "",
    salary: extracted.salary ?? "",
    deadline: extracted.deadline ?? "",
  };
}

/** Reads the posting, writes its documents and creates the application; returns its id. */
export async function writeApplication(
  {
    posting,
    postingUrl,
    name,
    write,
    claim,
    profileId: asked,
    scored,
    note = "",
  }: {
    /** The posting's whole text, as postingText() gives it. */
    posting: string;
    postingUrl: string;
    /** Who it's for, in the steps shown while it's written. */
    name: string;
    write?: DocumentsToWrite;
    claim: ApplicationClaim;
    /** The profile it's written from (E24-6); the first when it's missing. */
    profileId?: string | null;
    /** The posting as Positions keeps it: its score for that profile, when there is one, answers How you match with no new call (E25-7). */
    scored?: { source: string; externalId: string };
    /** What the documents should stress, in the user's words (the connector's draft_application). */
    note?: string;
  },
  context: JobContext,
): Promise<string> {
  const profileId = await profileIdOr(asked);
  await context.step(`Reading the posting from ${name}`);
  const reading = await readPostingJob.run({ posting, profileId, scored }, context);
  await context.step(`Writing the draft for ${name}`);
  const settings = await loadSettings();
  const documents = await writeDocumentsJob.run(
    { readJobId: context.id, posting, extracted: reading.extracted, match: reading.match, tone: settings.defaultTone, note, write: write ?? settings.documentsToWrite, profileId },
    context,
  );
  const applicationId = await createApplicationFromDocuments({
    reading: { posting, ...reading },
    documents,
    match: reading.match,
    details: detailsFrom(reading.extracted),
    postingUrl,
    tone: settings.defaultTone,
    note,
    claim,
    profileId,
  });
  // The job holds nothing of the application, but goes with it all the same.
  await prisma.job.updateMany({ where: { id: context.id }, data: { applicationId } });
  return applicationId;
}
