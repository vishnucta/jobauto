import type { Metadata } from "next";
import { cache } from "react";

import { activityTimeline } from "@/lib/activity";
import { isAiConfigured } from "@/lib/ai/config";
import { editsSchema, matchSchema, matchScore } from "@/lib/application-data";
import { loadApplication, loadDocuments, readJson } from "@/lib/application-documents";
import { loadApplyTab } from "@/lib/apply/view-data";
import { formatShortDate } from "@/lib/dates";
import { resolveFileName } from "@/lib/file-name";
import { DOCUMENT_LANGUAGES } from "@/lib/document-language";
import { refineJobKey } from "@/lib/jobs/refine";
import { regenerateUnitJob, unitJobKey } from "@/lib/jobs/regenerate-unit";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { languageJobKey, translateDocumentsJob } from "@/lib/jobs/translate-documents";
import { writeDocumentJobKey } from "@/lib/jobs/write-document";
import { scoreResumeJobKey } from "@/lib/jobs/score-resume";
import { resumeFitSchema } from "@/lib/resume-fit";
import { emailJobKey } from "@/lib/jobs/write-email";
import { googleConnection } from "@/lib/google/account";
import { pullInterviewEvents } from "@/lib/google/availability";
import { loadConversation } from "@/lib/google/inbox-data";
import { readFrozenCopy } from "@/lib/frozen-copy";
import { profileUpdate } from "@/lib/profile-update";
import { refineSuggestions } from "@/lib/refine-suggestions";
import { resumeContent, sectionsWithContent } from "@/lib/resume-content";
import { sectionName } from "@/lib/resume-sections";
import { loadThemes } from "@/lib/theme-data";
import { userTimeZone } from "@/lib/time-zone";
import { callPrepOf, prepJobKey } from "@/lib/call-prep";
import { workSampleJobKey, workSampleOf } from "@/lib/work-sample";
import { listAttachments } from "@/lib/attachments";
import { letterAvailability } from "@/lib/letter-availability";
import { recruiterDoubts } from "@/lib/recruiter-eye";
import { armLabel } from "@/lib/experiments";
import { peopleAt } from "@/lib/network-data";

import { ApplicationView } from "./application-view";
import { metaLine } from "./meta";
import { tabFrom } from "./tabs";

/**
 * Takes an interview moved or deleted in Google Calendar into the
 * application, once per request and before anything reads it:
 * loadApplication is cached for the request, and the title reads it first.
 */
const pullCalendar = cache((id: string) => pullInterviewEvents({ applicationId: id, signal: AbortSignal.timeout(3_000) }).catch(() => 0));

export async function generateMetadata({ params }: PageProps<"/applications/[id]">): Promise<Metadata> {
  const { id } = await params;
  await pullCalendar(id);
  const application = await loadApplication(id);
  return { title: application.title.trim() || "Untitled application" };
}

/** One application (PRD §6.5): its status, tailored documents, email, posting and notes. */
export default async function ApplicationPage({ params, searchParams }: PageProps<"/applications/[id]">) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  await pullCalendar(id);
  const [{ application, profile, liveProfile, sent, settings, extracted, resume, letter, email, includeReferences, sections, ownSections, letterDate }, aiReady, unitJobs, refineJobs, emailJobs, languageJobs, timeZone, google, emails, themes, resumeJobs, letterJobs, scoreJobs] =
    await Promise.all([
      loadDocuments(id),
      isAiConfigured(),
      findUnfinishedJobs(unitJobKey(id)),
      findUnfinishedJobs(refineJobKey(id)),
      findUnfinishedJobs(emailJobKey(id)),
      findUnfinishedJobs(languageJobKey(id)),
      userTimeZone(),
      googleConnection(),
      loadConversation(id),
      loadThemes(),
      findUnfinishedJobs(writeDocumentJobKey(id, "RESUME")),
      findUnfinishedJobs(writeDocumentJobKey(id, "COVER_LETTER")),
      findUnfinishedJobs(scoreResumeJobKey(id)),
    ]);

  const apply = await loadApplyTab(application, profile, settings, timeZone);
  const prepJobs = await findUnfinishedJobs(prepJobKey(id));
  const sampleJobs = await findUnfinishedJobs(workSampleJobKey(id));
  const anlagen = (await listAttachments()).filter((attachment) => attachment.enabled).map((attachment) => attachment.name);
  const match = readJson(matchSchema, application.match);
  const messages = application.messages
    .map((message, index) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      targetUnit: message.targetUnit,
      // Written in code when the application was created (E7-6).
      opening: index === 0 && message.role === "AI" && !message.writtenWith,
      canUndo: message.role === "AI" && (readJson(editsSchema, message.edits)?.length ?? 0) > 0,
      undone: message.undone,
    }))
    // Settings → "Show what changed" off hides the list of what was tailored (SET-5).
    .filter((message) => settings.showDiff || !message.opening);
  const { title, company, location, status, tone, language, followThemeLayout, showPhoto, nextInterviewAt } = application;
  // Units still being rewritten, so a reload keeps showing it.
  const rewriting = unitJobs.flatMap((job) => {
    const input = regenerateUnitJob.input.safeParse(job.input);
    return input.success ? [{ jobId: job.id, document: input.data.document, unitId: input.data.unitId }] : [];
  });
  // A rewrite in another language still going, so a reload keeps showing it.
  const languageJob = languageJobs.at(-1);
  const languageInput = languageJob && translateDocumentsJob.input.safeParse(languageJob.input);
  const rewritingLanguage = languageJob && languageInput?.success ? { jobId: languageJob.id, language: languageInput.data.language } : null;
  // The PDFs to attach to the email, named as they'll download (SET-8).
  const fileName = (doc: "RESUME" | "COVER_LETTER") =>
    resolveFileName(settings.fileNamePattern, { name: profile.basics.name, company: application.company, role: application.role, doc, date: new Date() });

  return (
    <ApplicationView
      application={{
        id,
        title,
        // The job title as saved, or as the posting was read; "" when neither knows it.
        role: application.role.trim() || extracted?.role?.trim() || "",
        company,
        location,
        status,
        tone,
        language,
        followThemeLayout,
        showPhoto,
        archived: application.archivedAt !== null,
        awaitingReview: application.awaitingReview,
        nextInterviewAt,
      }}
      timeZone={timeZone}
      posting={{
        text: application.postingText,
        // New applications only keep web links, but an imported file could carry any URL (E11-5).
        url: /^https?:\/\//i.test(application.postingUrl) ? application.postingUrl : "",
        pasted: formatShortDate(application.createdAt),
      }}
      match={match}
      requirements={extracted?.requirements ?? []}
      facts={application.facts}
      activity={activityTimeline({ notes: application.notes, events: application.events, createdAt: application.createdAt })}
      meta={metaLine(application)}
      resume={resume}
      letter={letter}
      themes={themes}
      baseThemeId={settings.baseThemeId}
      languages={[...DOCUMENT_LANGUAGES.map((entry) => entry.name), ...settings.customLanguages]}
      rewritingLanguage={rewritingLanguage}
      email={email}
      writingEmail={emailJobs.at(-1)?.id ?? null}
      writingDocuments={{ resume: resumeJobs.at(-1)?.id ?? null, letter: letterJobs.at(-1)?.id ?? null }}
      resumeFit={readJson(resumeFitSchema, application.resumeFit)}
      scoringResume={scoreJobs.at(-1)?.id ?? null}
      attachments={{ resume: resume ? fileName("RESUME") : null, letter: letter ? fileName("COVER_LETTER") : null }}
      gmail={
        google.status === "not-configured" && emails.length === 0
          ? undefined
          : {
              sender:
                google.status === "connected"
                  ? google.canSend
                    ? { from: google.email }
                    : { from: null, reason: "no-permission" }
                  : { from: null, reason: google.status === "not-configured" ? "not-configured" : "not-connected" },
              sentBefore: application.emailThreadId !== null,
              emails,
              reading: google.status === "connected" && google.canRead && settings.gmailRead,
            }
      }
      profile={profile}
      paper={settings.paper}
      dateFormat={settings.dateFormat}
      includeReferences={includeReferences}
      sections={sections}
      ownSections={ownSections}
      sent={sent}
      canUpdate={
        resume !== null &&
        profileUpdate({
          copy: readFrozenCopy(application.frozen)?.profile ?? null,
          live: liveProfile,
          units: resume.units,
          trimmed: resume.trimmed ?? null,
          language: application.language,
          includeReferences,
        }).changed
      }
      baseSections={sectionsWithContent(resumeContent(liveProfile, { includeReferences: true })).map((key) => ({ key, name: sectionName(key, liveProfile.customSections) }))}
      letterDate={letterDate}
      score={match && match.items.length > 0 ? matchScore(match) : null}
      initialTab={tabFrom(tab)}
      apply={apply}
      prep={{ pack: callPrepOf(application.prep), jobId: prepJobs.at(-1)?.id ?? null }}
      workSample={{ sample: workSampleOf(application.workSample), jobId: sampleJobs.at(-1)?.id ?? null }}
      anlagen={anlagen}
      letterAsks={letterAvailability(application.postingText, settings.applyAnswers).missing}
      known={(await peopleAt([application.company]))[application.company] ?? []}
      version={
        application.experiment && (application.arm === "A" || application.arm === "B") && settings.experiment?.name === application.experiment
          ? { experiment: application.experiment, label: armLabel(settings.experiment, application.arm) }
          : null
      }
      doubts={recruiterDoubts({
        profile,
        answers: settings.applyAnswers,
        posting: application.postingText,
        documents: [resume, letter].flatMap((document) => document?.units ?? []).map((unit) => unit.text).join("\n"),
      })}
      aiReady={aiReady}
      rewriting={rewriting}
      messages={messages}
      refining={refineJobs.at(-1)?.id ?? null}
      suggestions={refineSuggestions({
        match,
        requirements: extracted?.requirements ?? [],
        tone,
        hasSummary: Boolean(resume?.units.some((unit) => unit.id === "summary" && unit.text.trim())),
      })}
    />
  );
}
