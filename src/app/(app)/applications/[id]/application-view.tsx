"use client";

import { Download, FileCheck, FileText, NotebookPen, Reply, Send, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";

import { plainUnit, type UnitRenderer } from "@/components/documents/document-page";
import { DocumentPreview } from "@/components/documents/document-preview";
import { DownloadPdfButton } from "@/components/documents/download-pdf-button";
import { ResumeCheckCard } from "@/components/documents/resume-check-card";
import { TailoredLetter, TailoredResume } from "@/components/documents/tailored-documents";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KnownPeople } from "@/components/known-people";
import { ScrollEdges } from "@/components/scroll-edges";
import {
  DocumentKind,
  type ApplicationStatus,
  type DateFormat,
  type PaperSize,
  type Tone,
} from "@/generated/prisma/enums";
import { matchScore, type Match, type Requirement, type Unit } from "@/lib/application-data";
import type { ApplicationFlag } from "@/lib/application-flag";
import type { HistoryEntry } from "@/lib/application-history";
import type { MessageDraft, MessageKind } from "@/lib/message-draft";
import { changedLines, lineText } from "@/lib/changed-lines";
import { rowAction } from "@/lib/applications-list";
import { sendStep } from "@/lib/apply/send-step";
import { cn } from "@/lib/cn";
import { EMAIL_UNITS, WRITTEN_EMAIL_UNITS } from "@/lib/application-email";
import { documentLabels } from "@/lib/document-labels";
import { copyText } from "@/lib/copy-text";
import { defaultFrame, isFrameUnit, isParagraph, letterText, PROFILE_FRAME_UNITS, withFrame, WRITTEN_FRAME_UNITS } from "@/lib/letter-frame";
import { missingWords } from "@/lib/letter-availability";
import type { Doubt } from "@/lib/recruiter-eye";
import type { Person } from "@/lib/network";
import type { ActivityEntry } from "@/lib/activity";
import type { DocumentData } from "@/lib/application-documents";
import type { ApplyTabData } from "@/lib/apply/view";
import { retry } from "@/lib/jobs/actions";
import type { RefineResult } from "@/lib/jobs/refine";
import type { RegenerateUnitResult } from "@/lib/jobs/regenerate-unit";
import { WRITE_APPLICATION_STEPS } from "@/lib/jobs/application-steps";
import type { JobView } from "@/lib/jobs/runner";
import type { DocumentsToWrite } from "@/lib/settings";
import type { TranslateDocumentsResult } from "@/lib/jobs/translate-documents";
import type { WriteEmailResult } from "@/lib/jobs/write-email";
import type { FactItem, ProfileData } from "@/lib/profile";
import type { RefineSuggestions } from "@/lib/refine-suggestions";
import type { CheckFix, ResumeCheck } from "@/lib/resume-check";
import { resumeContent, sectionsWithContent } from "@/lib/resume-content";
import { inSidebar, sectionName, type SectionLayout } from "@/lib/resume-sections";
import { skillLine, skillNamesIn } from "@/lib/skill-groups";
import { hasSidebar, type ThemeData } from "@/lib/themes";
import { TONES } from "@/lib/tones";
import { cleanUnitText, isVerbatimUnit, unitName } from "@/lib/unit-text";

import {
  addMatchSkill,
  checkResumeAts,
  cleanUpDocument,
  forgetKnownGap,
  leaveOutUnit,
  markKnownGap,
  putBackTrimmed,
  restoreUnit,
  goBackTo,
  startPreparing,
  startWritingMessage,
  undoMessage,
  rewriteLetter,
  rewriteInLanguage,
  saveUnit,
  sendMessage,
  addApplicationSection,
  followBaseSections,
  setApplicationSections,
  setApplicationTheme,
  setDocumentLanguage,
  setFollowThemeLayout,
  setShowPhoto,
  undoUpdateFromProfile,
  updateFromProfile,
  startRegenerating,
  startWritingEmail,
  undoEmailRewrite,
  stopWritingApplication,
} from "./actions";
import { FitColumn, FitPanel, type GapAnswer } from "./fit-column";
import { InterviewPanel, type InterviewView } from "./interview-panel";
import { MessageDraftCard } from "./message-draft-card";
import { OfferPanel, type OfferView } from "./offer-panel";
import { FitSummary } from "./fit-summary";
import { WriteMissingDocument } from "./write-missing-document";
import { ApplicationHeader } from "./application-header";
import { ApplyTab } from "./apply-tab";
import { PrepTab, type PrepTabData } from "./prep-tab";
import { RecruiterEyeCard } from "./recruiter-eye-card";
import { WorkSampleTab, type WorkSampleTabData } from "./work-sample-tab";
import { SendGuide } from "./send-guide";
import { EnglishCopy } from "./english-copy";
import { ApplicationMenu } from "./application-menu";
import { ConversationTab } from "./conversation-tab";
import { EmailTab, type Attachments } from "./email-tab";
import type { GmailSender } from "./send-with-gmail";

import { JobWatcher } from "./job-watcher";
// "Rewrite in…" (jobauto fork): the resume, letter and email in another language, beside the letter's own language menu.
import { LanguageMenu as RewriteInMenu } from "./language-menu";
import { WritingNote, WritingPage, WritingStrip, writingSteps } from "./writing-view";
import { NotesTab } from "./notes-tab";
import { PostingTab, type PostingData } from "./posting-tab";
import { Composer, type ComposerMode } from "./composer";
import { LatestReply, type ChatEntry } from "./latest-reply";
import { LanguageMenu, ToneMenu } from "./letter-menus";
import { MarkAsSent, StatusControl } from "./status-control";
import { SectionsMenu } from "./sections-menu";
import { ThemeMenu } from "./theme-menu";
import { TrimmedNotice } from "./trimmed-notice";

import { aboutWords, type Tab } from "./tabs";
import { UnitFrame } from "./unit-frame";
import { HistoryPanel, undoIds } from "./history-panel";
import type { EmailView } from "@/lib/google/inbox-data";


/** A unit on the page: its document and id, e.g. "RESUME summary". */
const keyOf = (kind: DocumentKind, unitId: string) => `${kind} ${unitId}`;
const splitKey = (key: string) => {
  const space = key.indexOf(" ");
  return [key.slice(0, space) as DocumentKind, key.slice(space + 1)] as const;
};

/** How long a changed unit glows (APP-6). */
const FLASH_MS = 1600;

/** A background job being followed; `revision` goes up with each Retry. */
type Rewrite = { jobId: string; revision: number };

/** The tab each document is on. */
const TAB_OF: Record<DocumentKind, Tab> = { RESUME: "resume", COVER_LETTER: "letter", EMAIL: "email" };

/** The unit the next chat message is about ("Ask AI"). */
type Target = { document: DocumentKind; unitId: string; label: string; name: string };


const NO_AI = "That needs an AI provider. Choose one in Settings → AI provider.";

const NOTHING_SAVING: Readonly<Record<string, string>> = {};

/** The header's next step's icon (E30-2), by its label. */
const NEXT_ICONS: Readonly<Record<string, LucideIcon>> = {
  "Review and send": Send,
  "Answer reply": Reply,
  "Draft a follow-up": Send,
  Prepare: NotebookPen,
  "Review offer": FileCheck,
};

/**
 * Where the letter covers each requirement (E30-4, design 4a): "Paragraph 2",
 * "Not in the letter, resume only", or for a gap, "Addressed in paragraph 4".
 */
export function letterPlaces(match: Match, units: readonly Unit[]): Record<string, string> {
  const paragraphs = units.filter(isParagraph);
  const numbers = (requirement: string) =>
    paragraphs.flatMap((unit, index) => ((unit.serves ?? []).some((entry) => entry.requirements.includes(requirement)) ? [index + 1] : []));
  const list = (values: number[]) => (values.length === 1 ? String(values[0]) : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`);
  return Object.fromEntries(
    match.items.flatMap((item) => {
      const at = numbers(item.requirement);
      if (item.result === "gap") return at.length > 0 ? [[item.requirement, `Addressed in paragraph ${list(at)}`]] : [];
      return [[item.requirement, at.length === 0 ? "Not in the letter, resume only" : `Paragraph${at.length > 1 ? "s" : ""} ${list(at)}`]];
    }),
  );
}

/** A tab's 6 px green dot (E30-2): something on it is new or ready, said to screen readers too. */
function dot(news: string | null) {
  return (
    <>
      {news && <span className="sr-only">, {news}</span>}
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", news ? "bg-success" : "bg-transparent")} />
    </>
  );
}

export type ApplicationViewProps = {
  application: {
    id: string;
    title: string;
    /** The posting's job title ("Senior Product Designer"), which the ATS check looks for in the resume; "" when unknown. */
    role: string;
    company: string;
    /** The posted salary, for the offer's range bar (E30-7). */
    salary?: string;
    location: string;
    status: ApplicationStatus;
    tone: Tone;
    /** The documents' language, e.g. "English". */
    language: string;
    followThemeLayout: boolean;
    /** The Photo switch (#224); null follows the profile's "Show on resumes". */
    showPhoto: boolean | null;
    archived: boolean;
    /** A job agent draft not approved yet (#195): it isn't in Applications. */
    awaitingReview?: boolean;
    /** The next interview, while in Interview (E9-9). */
    nextInterviewAt: Date | null;
  };
  /** The browser's time zone as it last told the server, for the interview's time. */
  timeZone?: string;
  /** What it needs next (E27-2), in the breadcrumb (E30-2). */
  flag?: ApplicationFlag | null;
  posting: PostingData;
  /** How the profile matches the posting (NEW-4), when it was read. */
  match: Match | null;
  /** The posting's requirements, in the same order as the match's items. */
  requirements: Requirement[];
  /** What the user tells the AI for this application (APP-15). */
  facts: FactItem[];
  /** Requirements the user said they don't have (E30-5). */
  knownGaps?: string[];
  /** Its interview rounds (E30-6). */
  interviews?: InterviewView[];
  /** The next interview is in Google Calendar. */
  inCalendar?: boolean;
  /** "Getting ready" being written, e.g. since before a reload. */
  preparing?: string | null;
  /** The offer (E30-7), once there is one. */
  offer?: OfferView | null;
  /** A follow-up or answer to the offer drafted on a click, waiting to be sent (E30-7, E30-8), and its drafting. */
  messageDraft?: MessageDraft | null;
  writingMessage?: string | null;
  /** It went out with Gmail, which can send in its thread. */
  threadReady?: boolean;
  /** Work a button elsewhere asked for on its click (U3): "prepare", or "follow-up". */
  start?: "prepare" | "follow-up" | null;
  /** The roles in its profile, for a gap's "Where you used it" (E30-5). */
  roles?: { id: string; label: string }[];
  /** Notes and status changes, newest first (E8-9). */
  activity: ActivityEntry[];
  meta: string[];
  resume: DocumentData | null;
  letter: DocumentData | null;
  /** Every theme, for the Theme menu (#226), and which is the base theme. */
  themes: ThemeData[];
  baseThemeId: string;
  /** The resume's sections: their order and which are off (#297). */
  sections: SectionLayout;
  /** It has its own order, rather than following the base resume's. */
  ownSections: boolean;
  /** It was sent, so changes to the profile no longer reach it (#299). */
  sent: boolean;
  /** The letter's sender and signature are drawn from the profile, so they're changed there (jobauto fork). */
  senderFromProfile?: boolean;
  /** "Update from profile" would change what the resume shows (#301). */
  canUpdate: boolean;
  /** The sections the profile has content for, and their names, for the Sections menu. */
  baseSections: { key: string; name: string }[];
  /** The email to send the application with (Email tab), once it's written. */
  email: Unit[] | null;
  /** The email being written, e.g. since before a reload. */
  writingEmail: string | null;
  /** A resume or letter it was created without, being written (#367), or the letter written again (E30-9), e.g. since before a reload. */
  writingDocuments?: { resume: string | null; letter: string | null };
  /** New application writing its documents on the server (E31-5), e.g. since before a reload. */
  writingApplication?: { jobId: string; write: DocumentsToWrite; notifies: boolean } | null;
  /** How many versions each document has, for "History · v3" (E30-9). */
  versions?: Partial<Record<DocumentKind, number>>;
  /** The PDFs to attach to the email. */
  attachments: Attachments;
  /** Sending through Gmail (E15-2), and the application's mail (E15-3). */
  gmail?: { sender: GmailSender; sentBefore: boolean; emails: EmailView[]; moveTo: { id: string; label: string }[]; reading: boolean };
  profile: ProfileData;
  paper: PaperSize;
  dateFormat: DateFormat;
  /** Settings → "Include references", when the posting asks for them (SET-9). */
  includeReferences: boolean;
  /** The date on the letter, at UTC midnight. */
  letterDate: Date;
  /** "Check again" running (E30-1), e.g. since before a reload. */
  checkingRequirements?: string | null;
  initialTab: Tab;
  /** Whether an AI provider is set up; without one, the AI buttons point to Settings. */
  aiReady: boolean;
  /** Units being rewritten in the background (E8-4), e.g. since before a reload. */
  rewriting: { jobId: string; document: DocumentKind; unitId: string }[];
  /** The languages documents can be written in, for "Rewrite in…" (jobauto fork). */
  languages?: string[];
  /** A rewrite in another language still going, e.g. since before a reload. */
  rewritingLanguage?: { jobId: string; language: string } | null;
  /** Every change across the documents, and the questions answered, newest first (E30-11). */
  history?: HistoryEntry[];
  /** The Refine with AI conversation (E8-5), oldest first. */
  messages: ChatEntry[];
  /** A reply still being written, e.g. since before a reload. */
  refining: string | null;
  suggestions: RefineSuggestions;
  /** The Apply tab (Phase A of the bewerbung fork). */
  apply: ApplyTabData;
  /** The Call prep tab (jobauto fork). */
  prep: PrepTabData;
  /** The Work sample tab (jobauto fork); missing in older callers. */
  workSample?: WorkSampleTabData;
  /** The Anlagen that go with it, by name, for a German letter's list. */
  anlagen?: readonly string[];
  /** What the posting asks the letter to state that has no standard answer yet: salary, start date (letter-availability.ts). */
  letterAsks?: readonly ("salary" | "start")[];
  /** What a German recruiter may wonder, answered or not (recruiter-eye.ts), for the Job posting tab. */
  doubts?: readonly Doubt[];
  /** The people she knows at its employer (network.ts). */
  known?: readonly Person[];
};

/**
 * An application's page below the sidebar: the header with its tabs, the
 * active tab's document on the canvas, and the right column, which moves
 * below the document on narrow windows. The tab is kept in the URL.
 */
export function ApplicationView({
  application,
  timeZone,
  flag = null,
  meta,
  posting,
  match,
  requirements,
  facts: factsAtLoad,
  knownGaps = [],
  interviews = [],
  inCalendar = false,
  preparing = null,
  offer = null,
  messageDraft = null,
  writingMessage = null,
  threadReady = false,
  start = null,
  roles = [],
  activity,
  resume,
  letter,
  themes,
  baseThemeId,
  sections,
  ownSections,
  sent,
  senderFromProfile = false,
  canUpdate,
  baseSections,
  email,
  writingEmail,
  writingDocuments = { resume: null, letter: null },
  writingApplication = null,
  versions = {},
  attachments,
  gmail,
  profile,
  paper,
  dateFormat,
  includeReferences,
  letterDate,
  checkingRequirements = null,
  initialTab,
  aiReady,
  rewriting: rewritingAtLoad,
  languages = [],
  rewritingLanguage = null,
  messages,
  history = [],
  refining,
  suggestions,
  apply,
  prep,
  workSample = { sample: null, jobId: null },
  anlagen = [],
  letterAsks = [],
  doubts = [],
  known = [],
}: ApplicationViewProps) {
  const router = useRouter();
  const [tab, setTab] = useState(initialTab);
  // Kept here: the Job posting tab is drawn again on every visit, and switching tabs doesn't reload the page.
  const [facts, setFacts] = useState(factsAtLoad);
  const [followLayout, showFollowLayout] = useOptimistic(application.followThemeLayout);
  const [photoChoice, showPhotoChoice] = useOptimistic(application.showPhoto);
  const showPhoto = photoChoice ?? profile.photo?.onResumes ?? false;
  // A theme just picked from the Theme menu, until the page has it (#226).
  const [themeChoice, showThemeChoice] = useOptimistic<ThemeData | null>(null);
  const resumeTheme = themeChoice ?? resume?.theme;
  const letterTheme = themeChoice ?? letter?.theme;
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  // Texts being saved, shown in place until the page has the saved version.
  const [saving, showSaving] = useOptimistic(NOTHING_SAVING, (texts, { key, text }: { key: string; text: string }) => ({
    ...texts,
    [key]: text,
  }));
  const flashing = useFlashing();
  const [target, setTarget] = useState<Target | null>(null);
  // E8-10: the document whose history is open, and an earlier version shown in its place.
  // E30-6: "Getting ready" being written, the Fit column's overlay, and the fit shown in place of the interview.
  const [prepareJob, setPrepareJob] = useState<Rewrite | null>(preparing ? { jobId: preparing, revision: 0 } : null);
  const [fitOpen, setFitOpen] = useState(false);
  // E30-7, E30-8: a message being drafted on a click.
  const [messageJob, setMessageJob] = useState<Rewrite | null>(writingMessage ? { jobId: writingMessage, revision: 0 } : null);
  const [showFit, setShowFit] = useState(false);
  // E30-4: the requirement picked in the Fit column, whose covering lines are highlighted.
  const [focused, setFocused] = useState<string | null>(null);
  // E30-12: where the latest change landed, and the text it replaced, until it's kept.
  const [landing, setLanding] = useState<{ key: string; before: string } | null>(null);
  const landingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const land = (kind: DocumentKind, unitId: string, before: string) => {
    setLanding({ key: keyOf(kind, unitId), before });
    clearTimeout(landingTimer.current);
    // The mark fades after about 4 s; Keep and Undo stay a little longer.
    landingTimer.current = setTimeout(() => setLanding(null), 10_000);
  };
  useEffect(() => () => clearTimeout(landingTimer.current), []);
  // To the first covering line, once the parts have marked theirs (E30-4).
  useEffect(() => {
    if (!focused) return;
    const first = document.querySelector("[data-highlight], [data-highlight-all]");
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    first?.scrollIntoView?.({ block: "center", behavior: smooth ? "smooth" : "auto" });
  }, [focused, tab]);
  // E30-11: the history above the composer, and a going back on its way.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [goingBack, setGoingBack] = useState(false);
  const [reply, setReply] = useState<Rewrite | null>(refining ? { jobId: refining, revision: 0 } : null);
  // Replies being undone, shown as undone until the page has it.
  const [chatFocus, focusChat] = useState(0);
  // Change or Ask in the composer (E30-10), and a reply hidden from above it.
  const [mode, setMode] = useState<ComposerMode>("change");
  const [hiddenReply, setHiddenReply] = useState<string | null>(null);
  const [rewrites, setRewrites] = useState<Readonly<Record<string, Rewrite>>>(() =>
    Object.fromEntries(rewritingAtLoad.map(({ jobId, document, unitId }) => [keyOf(document, unitId), { jobId, revision: 0 }])),
  );
  const [emailJob, setEmailJob] = useState<Rewrite | null>(writingEmail ? { jobId: writingEmail, revision: 0 } : null);
  // The letter written again in another tone or language (E30-9).
  const [letterJob, setLetterJob] = useState<Rewrite | null>(letter && writingDocuments.letter ? { jobId: writingDocuments.letter, revision: 0 } : null);
  // What it's being written in, until the page has it.
  const [rewritingIn, setRewritingIn] = useState<{ tone: Tone; language: string } | null>(null);
  const tone = rewritingIn?.tone ?? application.tone;
  const language = rewritingIn?.language ?? application.language;
  // "Rewrite in…" (jobauto fork): the language being written, and its job once it has started. The one asked for waits here until it's confirmed.
  const [languageJob, setLanguageJob] = useState<(Rewrite & { language: string }) | null>(rewritingLanguage ? { ...rewritingLanguage, revision: 0 } : null);
  const [languageAsked, askLanguage] = useState<string | null>(null);
  // The ATS check's report on the Resume tab, with the state of the resume it was made from.
  const [check, setCheck] = useState<{ report: ResumeCheck; of: string } | null>(null);
  const [checking, startChecking] = useTransition();
  const [fixing, startFixing] = useTransition();

  // New application writing the documents on the server (E31-5): the step
  // it's on, and the page brought up to date as each document lands.
  const [writingApp, setWritingApp] = useState(writingApplication);
  const [writeStep, setWriteStep] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const writingChanged = (job: JobView) => {
    if (job.status === "DONE" || job.status === "FAILED") {
      setWritingApp(null);
      setStopping(false);
      if (job.status === "DONE") toast("Your application is ready. Nothing gets sent until you say so.");
      else toast(job.error === "Cancelled." ? "Stopped. What's written stays." : `${job.error ?? "Writing it didn't work."} What's written stays: write the rest from here.`);
      router.refresh();
      return;
    }
    if (job.step === writeStep) return;
    // A document is saved as its step ends: bring it in.
    if (writeStep === WRITE_APPLICATION_STEPS[2] || writeStep === WRITE_APPLICATION_STEPS[3]) router.refresh();
    setWriteStep(job.step);
  };
  const stopWriting = async () => {
    setStopping(true);
    const result = await stopWritingApplication({ id: application.id });
    if (!result.ok) {
      setStopping(false);
      toast(result.error);
    }
  };

  /** The document on screen, which a chat message without a target is most likely about. */
  const onScreen = (): DocumentKind | null =>
    tab === "resume" && resume ? DocumentKind.RESUME : tab === "letter" && letter ? DocumentKind.COVER_LETTER : tab === "email" && email ? DocumentKind.EMAIL : null;
  // Change needs a document to change; elsewhere the composer asks.
  const composerMode: ComposerMode = onScreen() || target ? mode : "ask";
  /** Each document's units as the page has them. */
  const unitsByKind: Partial<Record<DocumentKind, Unit[]>> = { [DocumentKind.RESUME]: resume?.units, [DocumentKind.COVER_LETTER]: letter?.units, [DocumentKind.EMAIL]: email ?? undefined };
  // While a change shows where it landed, the requirement its new lines serve is selected (E30-12).
  const landedRequirement = (() => {
    if (!landing) return null;
    const [kind, unitId] = splitKey(landing.key);
    const unit = unitsByKind[kind]?.find((entry) => entry.id === unitId);
    if (!unit || unit.text === landing.before) return null;
    const lines = changedLines(landing.before, unit.text) ?? unit.text.split("\n").map(lineText);
    return unit.serves?.find((entry) => lines.includes(entry.line))?.requirements[0] ?? null;
  })();
  const selected = landedRequirement ?? focused;

  const selectTab = (value: string) => {
    const next = value as Tab;
    setTab(next);
    // Next.js follows replaceState, so a refresh keeps the tab.
    const url = new URL(window.location.href);
    if (next === "resume") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };

  const changeLayout = (follow: boolean) =>
    startTransition(async () => {
      showFollowLayout(follow);
      toastResult(await setFollowThemeLayout({ id: application.id, follow }));
    });

  const changeTheme = (themeId: string) =>
    startTransition(async () => {
      showThemeChoice(themes.find((theme) => theme.id === themeId) ?? null);
      toastResult(await setApplicationTheme({ id: application.id, themeId }));
    });
  const [sectionsChoice, showSections] = useOptimistic(sections);
  const changeSections = (next: SectionLayout) =>
    startTransition(async () => {
      showSections(next);
      toastResult(await setApplicationSections({ id: application.id, order: next.order, off: next.off, titles: next.titles }));
    });
  const addSection = (key: string) =>
    startTransition(async () => {
      toastResult(await addApplicationSection({ id: application.id, key }));
    });
  const updateProfile = () =>
    startTransition(async () => {
      const result = toastResult(await updateFromProfile({ id: application.id }));
      if (!result.ok) return;
      const previous = result.data;
      if (!previous) return void toast("This resume already matches your profile.");
      toast("Updated from your profile.", {
        action: {
          label: "Undo",
          onClick: async () => {
            const undone = toastResult(await undoUpdateFromProfile({ id: application.id, ...previous }));
            if (undone.ok) toast("Put the resume back as it was.");
          },
        },
      });
    });
  const followBase = () =>
    startTransition(async () => {
      toastResult(await followBaseSections({ id: application.id }));
    });

  const themeMenu = (current: ThemeData, options?: { label: string; checked: boolean; onChange: (checked: boolean) => void }[]) => (
    <ThemeMenu themes={themes} baseThemeId={baseThemeId} current={current} onChange={changeTheme} options={options} />
  );
  // Only where there are languages to pick from, as in a view that wasn't given them.
  // Documents in another language get an English copy to read (jobauto fork).
  const notEnglish = application.language.trim() !== "" && !/^english$/i.test(application.language.trim());
  const languageMenu =
    languages.length > 0 ? <RewriteInMenu languages={languages} current={application.language} busy={languageJob?.language ?? null} onChoose={askLanguage} /> : null;

  const changePhoto = (show: boolean) =>
    startTransition(async () => {
      showPhotoChoice(show);
      toastResult(await setShowPhoto({ id: application.id, show }));
    });

  /** Saves a unit's new text; `saved` is said once it's in, for a change made from elsewhere than the unit's own editor. */
  const save = (kind: DocumentKind, unit: Unit, text: string, saved?: string) => {
    const key = keyOf(kind, unit.id);
    startTransition(async () => {
      showSaving({ key, text: cleanUnitText(unit.id, text) });
      const result = await saveUnit({ id: application.id, document: kind, unitId: unit.id, text, expected: unit.text });
      if (!result.ok) {
        // The editor stays open with what was typed.
        toast(result.error);
        return;
      }
      setEditing((current) => (current === key ? null : current));
      flashing.start([key]);
      if (saved) toast(saved);
    });
  };

  const needsAi = () => {
    toast(NO_AI, { action: { label: "Open Settings", onClick: () => router.push("/settings?section=ai") } });
  };

  /** "Rewrite in…", once confirmed: the resume, cover letter and email written again in the language (jobauto fork). */
  const rewriteLanguage = async (chosen: string) => {
    if (!aiReady) return needsAi();
    setLanguageJob({ jobId: "", revision: 0, language: chosen });
    const result = await rewriteInLanguage({ id: application.id, language: chosen });
    if (result.ok) setLanguageJob({ jobId: result.data, revision: 0, language: chosen });
    else {
      setLanguageJob(null);
      toast(result.error);
    }
  };

  const languageChanged = (job: JobView<TranslateDocumentsResult>) => {
    if (!languageJob) return;
    if (job.status === "FAILED") {
      // Nothing was saved, so the documents are as they were.
      const { jobId, revision, language: asked } = languageJob;
      setLanguageJob(null);
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: jobId }).then((retried) => {
              if (retried.ok) setLanguageJob({ jobId, revision: revision + 1, language: asked });
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE" || !job.result) return;
    const { language: written, rewritten, left } = job.result;
    setLanguageJob(null);
    if (rewritten === 0) toast(`Nothing could be written in ${written}. The documents are as they were. Try again.`);
    else {
      toast(`Written in ${written}.${left.length > 0 ? ` Left as they were: ${left.join(", ")}.` : ""} The earlier text is in the history.`);
      startTransition(() => router.refresh());
    }
  };

  const stopRewriting = (key: string) =>
    setRewrites((current) => Object.fromEntries(Object.entries(current).filter(([entry]) => entry !== key)));

  /** "Regenerate" (E8-4): the unit dims while it's rewritten; the rest stays usable. */
  const regenerate = async (kind: DocumentKind, unit: Unit, { stored = true }: { stored?: boolean } = {}) => {
    if (!aiReady) return needsAi();
    const key = keyOf(kind, unit.id);
    setRewrites((current) => ({ ...current, [key]: { jobId: "", revision: 0 } }));
    // A letter part an older letter only shows (E8-11) is stored as shown, then rewritten.
    const result = await startRegenerating({ id: application.id, document: kind, unitId: unit.id, ...(stored ? {} : { shown: unit.text }) });
    if (result.ok) setRewrites((current) => ({ ...current, [key]: { jobId: result.data, revision: 0 } }));
    else {
      stopRewriting(key);
      toast(result.error);
    }
  };

  const rewriteChanged = (kind: DocumentKind, unitId: string, job: JobView<RegenerateUnitResult>) => {
    const key = keyOf(kind, unitId);
    const units = { [DocumentKind.RESUME]: resume?.units, [DocumentKind.COVER_LETTER]: letter?.units, [DocumentKind.EMAIL]: email }[kind];
    const name = unitName(units?.find((entry) => entry.id === unitId) ?? { id: unitId, label: "" });
    if (job.status === "FAILED") {
      // Nothing was changed, so the unit is as it was.
      stopRewriting(key);
      const { jobId, revision } = rewrites[key] ?? { jobId: job.id, revision: 0 };
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: jobId }).then((retried) => {
              if (retried.ok) setRewrites((current) => ({ ...current, [key]: { jobId, revision: revision + 1 } }));
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE" || !job.result) return;
    stopRewriting(key);
    const result = job.result;
    if (result.outcome === "changed") {
      toast(`The ${name} changed while I was rewriting it, so I left your version.`);
      return;
    }
    startTransition(() => router.refresh());
    flashing.start([key]);
    land(kind, unitId, result.previous.text);
    toast(`Rewrote the ${name}.`, {
      action: {
        label: "Undo",
        onClick: () =>
          startTransition(async () => {
            const undone = await restoreUnit({
              id: application.id,
              document: kind,
              unitId,
              text: result.previous.text,
              unverified: result.previous.unverified,
              expected: result.unit.text,
            });
            if (!undone.ok) return toast(undone.error);
            flashing.start([key]);
            toast(`Put the ${name} back.`);
          }),
      },
    });
  };

  /** "Ask AI" (APP-5): the next change is about this unit. */
  const askAbout = (kind: DocumentKind, unit: Unit) => {
    setTarget({ document: kind, unitId: unit.id, label: unit.label, name: unitName(unit) });
    setMode("change");
    focusChat((count) => count + 1);
  };

  /**
   * Sends a chat message (E8-5): a change to the document on screen, or the
   * one said, or a question in Ask (E30-10); resolves to whether it went.
   * `unit` is the part it's about: the one picked with "Ask AI", or one given
   * here (the ATS check's "Mention in the summary").
   */
  const send = (text: string, about?: DocumentKind, as: ComposerMode = about ? "change" : composerMode, unit: Target | null = target) =>
    new Promise<boolean>((resolve) => {
      const viewing = about ?? onScreen();
      if (!aiReady) {
        needsAi();
        return resolve(false);
      }
      startTransition(async () => {
        const result = await sendMessage({
          id: application.id,
          text,
          viewing,
          target: as === "change" && unit ? { document: unit.document, unitId: unit.unitId } : null,
          mode: as,
        });
        if (!result.ok) {
          toast(result.error);
          return resolve(false);
        }
        setTarget(null);
        if (result.data.jobId) setReply({ jobId: result.data.jobId, revision: 0 });
        resolve(true);
      });
    });

  const replyChanged = (job: JobView<RefineResult>) => {
    if (job.status === "FAILED") {
      setReply(null);
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: job.id }).then((retried) => {
              if (retried.ok) setReply((current) => ({ jobId: job.id, revision: (current?.revision ?? 0) + 1 }));
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE" || !job.result) return;
    setReply(null);
    startTransition(() => router.refresh());
    const { edited } = job.result;
    flashing.start(edited.map(({ document, unitId }) => keyOf(document, unitId)));
    // Show the change, on the other document if that's where it is.
    const viewing = onScreen();
    const first = edited.find(({ document }) => document === viewing) ?? edited[0];
    if (first && first.document !== viewing) selectTab(TAB_OF[first.document]);
    // It lands on the first changed part: scrolled to and marked (E30-12).
    const before = first && unitsByKind[first.document]?.find((unit) => unit.id === first.unitId)?.text;
    if (first && before !== undefined) land(first.document, first.unitId, before);
  };

  /**
   * "Prepare" (E30-6): writes "Getting ready" for the next round, only on
   * this click, and shows the Interview column, over the document on narrow
   * windows.
   */
  const prepare = () => {
    if (!aiReady) return needsAi();
    setShowFit(false);
    setFitOpen(true);
    if (prepareJob) return;
    void startPreparing({ id: application.id }).then((result) => {
      if (!result.ok) return void toast(result.error);
      setPrepareJob({ jobId: result.data, revision: 0 });
    });
  };

  const prepareChanged = (job: JobView) => {
    if (job.status === "FAILED") {
      setPrepareJob(null);
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: job.id }).then((retried) => {
              if (retried.ok) setPrepareJob((current) => ({ jobId: job.id, revision: (current?.revision ?? 0) + 1 }));
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE") return;
    setPrepareJob(null);
    startTransition(() => router.refresh());
    toast("Your checklist for the interview is ready.");
  };

  /** Where a drafted message shows: in the conversation when it can go out in the Gmail thread, else with the email. */
  const messageTab: Tab = threadReady ? "conversation" : "email";

  /**
   * Draft an acceptance, Ask for more, Decline politely (E30-7) and Draft a
   * follow-up (E30-8): drafted on this click, shown where it can be sent.
   */
  const draftMessage = (kind: MessageKind) => {
    if (!aiReady) return needsAi();
    if (messageJob) return;
    setMessageJob({ jobId: "", revision: 0 });
    selectTab(messageTab);
    void startWritingMessage({ id: application.id, kind }).then((result) => {
      if (!result.ok) {
        setMessageJob(null);
        return void toast(result.error);
      }
      setMessageJob({ jobId: result.data, revision: 0 });
    });
  };

  const messageChanged = (job: JobView) => {
    if (job.status === "FAILED") {
      setMessageJob(null);
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: job.id }).then((retried) => {
              if (retried.ok) setMessageJob((current) => ({ jobId: job.id, revision: (current?.revision ?? 0) + 1 }));
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE") return;
    setMessageJob(null);
    startTransition(() => router.refresh());
    toast("Drafted. Read it through before it goes.");
  };

  const messageCard =
    messageDraft || messageJob ? (
      messageDraft ? (
        <MessageDraftCard
          key={messageDraft.at}
          applicationId={application.id}
          draft={messageDraft}
          inThread={threadReady}
          writing={messageJob !== null}
          onWriteAgain={() => draftMessage(messageDraft.kind)}
        />
      ) : (
        <p role="status" className="w-full max-w-[820px] rounded-panel border border-line-strong bg-card px-6 py-5 text-sm text-muted">
          Drafting it…
        </p>
      )
    ) : null;

  // A Prepare button elsewhere (board, list, Needs you) asked for it on its click (U3): once, then out of the address.
  // A Follow up button too (E30-8): the follow-up is drafted on that click, where it can be sent.
  const startedFromLink = useRef(false);
  useEffect(() => {
    if (!start || startedFromLink.current) return;
    startedFromLink.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("start");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (!aiReady) return;
    if (start === "prepare") {
      void startPreparing({ id: application.id }).then((result) => {
        if (!result.ok) return void toast(result.error);
        setFitOpen(true);
        setPrepareJob({ jobId: result.data, revision: 0 });
      });
      return;
    }
    // Where it can be sent: the conversation in the Gmail thread, else with the email.
    const where = threadReady ? "conversation" : "email";
    url.searchParams.set("tab", where);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    void startWritingMessage({ id: application.id, kind: "follow-up" }).then((result) => {
      if (!result.ok) return void toast(result.error);
      setTab(where);
      setMessageJob({ jobId: result.data, revision: 0 });
    });
  }, [start, aiReady, application.id, threadReady]);

  /** Another tone or language on the letter's toolbar (E30-9): the letter is written again in it. */
  const rewriteInLetter = (change: { tone?: Tone; language?: string }) => {
    if (!aiReady) return needsAi();
    if (letterJob || rewritingIn) return;
    setRewritingIn({ tone: change.tone ?? tone, language: change.language ?? language });
    startTransition(async () => {
      const result = await rewriteLetter({ id: application.id, ...change });
      if (!result.ok) {
        setRewritingIn(null);
        return void toast(result.error);
      }
      setLetterJob({ jobId: result.data, revision: 0 });
    });
  };

  const letterChanged = (job: JobView) => {
    if (job.status === "FAILED") {
      setLetterJob(null);
      setRewritingIn(null);
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: job.id }).then((retried) => {
              if (retried.ok) setLetterJob((current) => ({ jobId: job.id, revision: (current?.revision ?? 0) + 1 }));
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE") return;
    setLetterJob(null);
    setRewritingIn(null);
    startTransition(() => router.refresh());
    flashing.start((letter?.units ?? []).map((unit) => keyOf(DocumentKind.COVER_LETTER, unit.id)));
    toast("Wrote the letter again. The one before is in its history.");
  };

  /** "Write the email" and "Rewrite" on the Email tab: written in the background. */
  const writeEmail = async () => {
    if (!aiReady) return needsAi();
    if (emailJob) return;
    setEmailJob({ jobId: "", revision: 0 });
    const result = await startWritingEmail({ id: application.id });
    if (result.ok) setEmailJob({ jobId: result.data, revision: 0 });
    else {
      setEmailJob(null);
      toast(result.error);
    }
  };

  const emailChanged = (job: JobView<WriteEmailResult>) => {
    if (job.status === "FAILED") {
      setEmailJob(null);
      toast(job.error ?? "That didn't work. Try again.", {
        action: {
          label: "Retry",
          onClick: () =>
            void retry({ id: job.id }).then((retried) => {
              if (retried.ok) setEmailJob((current) => ({ jobId: job.id, revision: (current?.revision ?? 0) + 1 }));
              else toast(retried.error);
            }),
        },
      });
      return;
    }
    if (job.status !== "DONE" || !job.result) return;
    setEmailJob(null);
    startTransition(() => router.refresh());
    const keys = EMAIL_UNITS.map((id) => keyOf(DocumentKind.EMAIL, id));
    flashing.start(keys);
    // The first email just appears; a rewrite can be undone.
    if (!job.result.previous) return;
    toast("Rewrote the email.", {
      action: {
        label: "Undo",
        onClick: () =>
          startTransition(async () => {
            const undone = await undoEmailRewrite({ id: application.id, jobId: job.id });
            if (!undone.ok) return toast(undone.error);
            flashing.start(keys);
            toast("Put the email back.");
          }),
      },
    });
  };

  /**
   * "Add to profile" on a gap in the Fit column (E8-7, E30-5): the skill,
   * linked to the role it was used in, then an offer to rewrite that role.
   */
  const addSkill = async (index: number, _skill: string, { experienceId, did }: GapAnswer) => {
    const result = await addMatchSkill({ id: application.id, index, experienceId, did: did || undefined });
    if (!result.ok) {
      toast(result.error);
      return false;
    }
    const { name, where, experienceId: linked } = result.data;
    const unit = linked ? resume?.units.find((entry) => entry.id === `experience:${linked}`) : undefined;
    if (!linked) toast(`Added “${name}” to your skills. Attach it to a role under Experience to make it count.`);
    else if (!unit) toast(`Added “${name}” to your profile, at ${where}.`);
    else
      toast(`Added “${name}” to your profile, at ${where}. Rewrite that role on the resume?`, {
        action: { label: "Rewrite it", onClick: () => void regenerate(DocumentKind.RESUME, unit) },
      });
    return true;
  };

  /** "I don't have this" on a gap (E30-5), with Undo. */
  const knownGap = (requirement: string) =>
    startTransition(async () => {
      if (!toastResult(await markKnownGap({ id: application.id, requirement })).ok) return;
      toast("Noted. It won't come up again for this application.", {
        action: { label: "Undo", onClick: () => void forgetKnownGap({ id: application.id, requirement }).then(toastResult) },
      });
    });

  /** "Mention in the letter" on a gap (E30-5): asks for it on the letter, honestly. */
  const mention = (requirement: string) => {
    selectTab("letter");
    void send(`Address “${requirement}” honestly in the letter, without claiming I have it.`, DocumentKind.COVER_LETTER);
  };

  /** "Put back" something left out by hand (#217), or by the page limit of earlier versions (E10-10). */
  const putBack = (index: number) =>
    startTransition(async () => {
      const result = await putBackTrimmed({ id: application.id, index });
      if (!result.ok) return toast(result.error);
      toast("Put back.");
    });

  /** "Leave out" on a part of the tailored resume (#217), with Undo on the toast. */
  const leaveOut = (unit: Unit) =>
    startTransition(async () => {
      const result = await leaveOutUnit({ id: application.id, unitId: unit.id });
      if (!result.ok) return toast(result.error);
      toast(`Left out: ${unit.label}.`, { action: { label: "Undo", onClick: () => putBack(result.data.index) } });
    });

  /**
   * Undo on the latest change (E30-11): the versions before it, or, for a
   * first change from the chat on documents without an earlier version, what
   * that reply replaced (E8-6).
   */
  const undoLatest = () => {
    const ids = undoIds(latestChange ?? undefined);
    if (ids) return void goBack(ids, "Undone. It's in the history if you want it back.");
    const messageId = latestChange?.kind === "change" ? latestChange.messageId : undefined;
    if (!messageId) return;
    setGoingBack(true);
    startTransition(async () => {
      const result = await undoMessage({ id: application.id, messageId });
      setGoingBack(false);
      if (!result.ok) return void toast(result.error);
      flashing.start(result.data.edited.map(({ document, unitId }) => keyOf(document, unitId)));
      toast("Undone. It's in the history if you want it back.");
    });
  };

  /**
   * Undo on the latest change, and "Go back to this" in the history (E30-11,
   * AP2): the versions come back as new ones, so this can be undone too.
   */
  const goBack = async (versionIds: string[], said: string) => {
    setGoingBack(true);
    const result = await goBackTo({ id: application.id, versionIds });
    setGoingBack(false);
    if (!result.ok) return void toast(result.error);
    startTransition(() => router.refresh());
    const changed = { [DocumentKind.RESUME]: resume?.units, [DocumentKind.COVER_LETTER]: letter?.units, [DocumentKind.EMAIL]: email };
    flashing.start(result.data.flatMap((kind) => (changed[kind] ?? []).map((unit) => keyOf(kind, unit.id))));
    toast(said);
  };

  // ─── The ATS check (Resume tab, jobauto fork) ──────────────────────────────

  /** What the check printed: a change to any of it makes the report stale. */
  const checkedState = JSON.stringify([
    followLayout,
    showPhoto,
    resumeTheme?.id,
    application.language,
    application.role,
    sectionsChoice,
    resume?.units.map((unit) => [unit.id, unit.text]),
  ]);

  /** "Check for ATS": prints the resume and reads it back as a parser would; the report stays until the next check. */
  const runCheck = () => {
    if (checking) return;
    const of = checkedState;
    startChecking(async () => {
      const result = await checkResumeAts({ id: application.id });
      if (!result.ok) return toast(result.error);
      setCheck({ report: result.data, of });
    });
  };

  /** A fix the report offers: the tab's own switch or setting, an edit, or a request to the AI. The links it offers go to Settings and the profile themselves. */
  const applyFix = (fix: CheckFix) => {
    switch (fix.kind) {
      case "single-column":
        return changeLayout(false);
      case "photo":
        return changePhoto(false);
      case "language":
        return startFixing(async () => {
          if (toastResult(await setDocumentLanguage({ id: application.id, language: fix.language })).ok) startTransition(() => router.refresh());
        });
      case "clean-up":
        return startFixing(async () => {
          if (toastResult(await cleanUpDocument({ id: application.id })).ok) startTransition(() => router.refresh());
        });
      case "add-skill": {
        const skills = resume?.units.find((unit) => unit.id === "skills");
        if (!skills) return toast("This resume has no Skills section to add it to.");
        // The report isn't run again, so its button stays: a second press mustn't add the skill twice.
        const listed = skillNamesIn(skills.text).flatMap((name) => name.split(",")).map((name) => name.trim().toLocaleLowerCase());
        if (listed.includes(fix.skill.trim().toLocaleLowerCase())) return toast(`“${fix.skill}” is in this resume's Skills already.`);
        // With skill groups the unit has a line per group: the skill goes on the line without a label, or on a line of its own.
        const lines = skills.text.split("\n");
        const plain = lines.findIndex((line) => skillLine(line.trim()).label === null);
        const text = plain < 0 ? [...lines, fix.skill].join("\n") : lines.map((line, index) => (index === plain ? `${line} · ${fix.skill}` : line)).join("\n");
        return save(DocumentKind.RESUME, skills, text, `Added “${fix.skill}” to this resume's Skills.`);
      }
      case "mention": {
        if (!aiReady) {
          return toast("Dossier's own AI isn't set up, so ask Claude or edit the summary by hand.", {
            action: { label: "Open Settings", onClick: () => router.push("/settings?section=ai") },
          });
        }
        const summary = resume?.units.find((unit) => unit.id === "summary");
        if (!summary) return toast("This resume has no summary to mention it in.");
        // One message at a time, as the composer allows: not while a reply is coming, nor twice on a double click.
        if (reply) return toast("The AI is still answering. Try again when it's done.");
        return startFixing(async () => {
          const about: Target = { document: DocumentKind.RESUME, unitId: summary.id, label: summary.label, name: unitName(summary) };
          // The answer shows at the bottom of the page, which may be out of view.
          if (await send(`Mention ${fix.term} in the summary, from my profile.`, DocumentKind.RESUME, "change", about)) {
            toast(`Asked the AI to mention “${fix.term}” in the summary. Its answer shows at the bottom of the page.`);
          }
        });
      }
      case "settings":
      case "theme":
        return;
    }
  };

  /** The document's units, with texts being saved in place. */
  const shown = (kind: DocumentKind, units: Unit[]) =>
    units.map((unit) => {
      const text = saving[keyOf(kind, unit.id)];
      return text === undefined ? unit : { ...unit, text, unverified: undefined };
    });

  /**
   * Draws each unit of a document with its toolbar and editor (E8-3). The
   * letter's sender, date and signature are edited, not written by the AI
   * (E8-11); a part an older letter only shows is stored when it's first
   * edited or regenerated.
   */
  const unitsOf = (kind: DocumentKind, units: Unit[], stored: ReadonlySet<string> = new Set(units.map((unit) => unit.id))): UnitRenderer =>
    function renderEditableUnit({ id, className, head, children }) {
      const unit = units.find((entry) => entry.id === id);
      if (!unit) return plainUnit({ id, className, head, children });
      const key = keyOf(kind, id);
      const written =
        kind === DocumentKind.EMAIL
          ? WRITTEN_EMAIL_UNITS.has(id)
          : kind === DocumentKind.RESUME
            ? !isVerbatimUnit(id)
            : !isFrameUnit(id) || WRITTEN_FRAME_UNITS.has(id);
      return (
        <UnitFrame
          id={id}
          className={className}
          head={head}
          unit={unit}
          editing={editing === key}
          saving={editing === key && saving[key] !== undefined}
          busy={key in rewrites}
          flashing={flashing.keys.has(key)}
          highlight={selected ? (unit.serves ?? []).filter((entry) => entry.requirements.includes(selected)).map((entry) => entry.line) : null}
          landing={
            landing?.key === key && unit.text !== landing.before
              ? {
                  lines: changedLines(landing.before, unit.text),
                  onKeep: () => setLanding(null),
                  onUndo: () => {
                    setLanding(null);
                    undoLatest();
                  },
                }
              : null
          }
          onEdit={() => setEditing(key)}
          onCancel={() => setEditing(null)}
          onSave={(text) => save(kind, unit, text)}
          onRegenerate={written ? () => void regenerate(kind, unit, { stored: stored.has(id) }) : undefined}
          // The chat only edits parts the letter stores.
          onAskAi={written && stored.has(id) ? () => askAbout(kind, unit) : undefined}
          onLeaveOut={kind === DocumentKind.RESUME ? () => leaveOut(unit) : undefined}
          profileHref={kind === DocumentKind.COVER_LETTER && senderFromProfile && PROFILE_FRAME_UNITS.has(id) ? "/profile?section=basics" : undefined}
        >
          {children}
        </UnitFrame>
      );
    };

  const resumeUnits = resume && shown(DocumentKind.RESUME, resume.units);
  // Every part of the letter, those it doesn't store yet as they've always been drawn (E8-11).
  const letterFrame = defaultFrame({
    basics: profile.basics,
    company: application.company,
    location: application.location,
    date: letterDate,
    dateFormat,
    labels: documentLabels(application.language),
  });
  const letterUnits = letter && withFrame(shown(DocumentKind.COVER_LETTER, letter.units), letterFrame);
  const letterStored = new Set(letter?.units.map((unit) => unit.id));
  const emailUnits = email && shown(DocumentKind.EMAIL, email);
  const paragraphs = letterUnits?.filter(isParagraph).map((unit) => unit.text) ?? [];
  // Which requirements the document on screen has lines for (E30-4), and on the letter, which paragraphs.
  const screenUnits = tab === "resume" ? resumeUnits : tab === "letter" ? letterUnits : tab === "email" ? emailUnits : null;
  const served = new Set((screenUnits ?? []).flatMap((unit) => (unit.serves ?? []).flatMap((entry) => entry.requirements)));
  const places = tab === "letter" && served.size > 0 && match ? letterPlaces(match, letterUnits ?? []) : undefined;
  // While New application writes (E31-5): each requirement "Used in the resume" as the resume lands.
  const usedInResume = new Set((resumeUnits ?? []).flatMap((unit) => (unit.serves ?? []).flatMap((entry) => entry.requirements)));
  // A model that doesn't say which lines serve what (older prompts, some providers) leaves the rows as they were.
  const resumeMapped = !resume || (resumeUnits ?? []).some((unit) => unit.serves !== undefined);
  const writingPlaces =
    writingApp && match && resumeMapped
      ? Object.fromEntries(
          match.items.flatMap((item) => {
            const place = usedInResume.has(item.requirement)
              ? "Used in the resume"
              : item.result === "gap"
                ? writingApp.write !== "resume" && !letter
                  ? "For the letter, next"
                  : null
                : resume
                  ? "Not in the resume"
                  : "Not used yet";
            return place ? [[item.requirement, place]] : [];
          }),
        )
      : undefined;
  const writingStrip = writingApp && <WritingStrip steps={writingSteps(writingApp.write)} step={writeStep} />;

  // The letter on screen as text, for a job site that wants it in a box (public issue 101).
  const copyLetter = async () => {
    const units = letterUnits ?? [];
    const text = letterText(withFrame(units, letterFrame), TONES[application.tone].signOff);
    toast((await copyText(text)) ? "Copied the letter, from the greeting to your name." : "That didn't copy. Select the text and copy it yourself.");
  };
  /** The document's PDF (E30-2), in its toolbar rather than the header. */
  const pdfButton = (doc: "resume" | "letter") => {
    const what = doc === "letter" ? "cover letter" : "tailored resume";
    return (
      <DownloadPdfButton variant="secondary" size="sm" href={`/api/pdf?doc=${doc}&application=${application.id}`} progress={`Rendering your ${what} as a PDF…`}>
        <Download size={14} aria-hidden="true" />
        <span className="sr-only">Download the {what} as a</span> PDF
      </DownloadPdfButton>
    );
  };
  /** The letter, the resume and the Anlagen in one PDF, for job portals that take a single file (jobauto fork). */
  const mappeButton = (
    <DownloadPdfButton variant="secondary" size="sm" href={`/api/pdf?doc=mappe&application=${application.id}`} progress="Putting your letter, resume and Anlagen into one PDF…">
      Bewerbungsmappe
    </DownloadPdfButton>
  );
  const historyButton = (document: DocumentKind) => (
    <Button variant="text" size="sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen(true)}>
      History{versions[document] ? ` · v${versions[document]}` : ""}
    </Button>
  );
  // Above the composer, only the latest (E30-10, E30-11): the newest change, or a newer reply that changed nothing.
  const latestChange = history.find((entry) => entry.kind === "change") ?? null;
  const latestReply = messages.findLast((message) => message.role === "AI" && !message.canUndo) ?? null;
  // A hidden reply gives its place back to the latest change.
  const replyFirst = latestReply !== null && latestReply.id !== hiddenReply && (!latestChange || (latestReply.at ?? "") > latestChange.at);
  const shownReply = replyFirst ? latestReply : null;
  const shownChange = !replyFirst && latestChange?.kind === "change" ? latestChange : null;
  const earlier = history.length - (shownChange || history.some((entry) => entry.id === shownReply?.id) ? 1 : 0);
  const waiting = gmail?.emails.filter((email) => email.direction === "INCOMING" && !email.handled).length ?? 0;
  // The one thing to do next, by status (E30-2), as cards and list rows say it.
  const next = application.archived ? null : rowAction({ status: application.status, waiting, docs: { resume: resume !== null, letter: letter !== null }, flag }, "header");
  const NextIcon = next ? NEXT_ICONS[next.label] ?? FileText : FileText;
  // A written draft's one next step is the send guide's (send-step.ts, jobauto fork): by how this employer takes applications.
  const sending =
    next && application.status === "DRAFT" && !application.awaitingReview && !writingApp && (resume || letter)
      ? sendStep(apply.plan, { hasEmail: Boolean(emailUnits), waitingInBrowser: apply.attempts[0]?.status === "WAITING", gmailSends: Boolean(gmail?.sender.from) })
      : null;

  return (
    // Wide enough for the refine panel beside the documents, the page fills the
    // window: the document scrolls in its column and the panel keeps its input
    // in view. Narrower, the panel moves below and the page scrolls as usual.
    <div className="@container/page flex flex-1 flex-col">
    <Tabs value={tab} onValueChange={selectTab} className="flex flex-1 flex-col @min-[780px]/page:h-panel @min-[780px]/page:flex-none">
      {Object.entries(rewrites).map(([key, { jobId, revision }]) =>
        jobId ? (
          <JobWatcher<RegenerateUnitResult>
            key={jobId}
            id={jobId}
            revision={revision}
            onChange={(job) => {
              const [kind, unitId] = splitKey(key);
              rewriteChanged(kind, unitId, job);
            }}
          />
        ) : null,
      )}
      {languageJob?.jobId && <JobWatcher<TranslateDocumentsResult> key={languageJob.jobId} id={languageJob.jobId} revision={languageJob.revision} onChange={languageChanged} />}
      <ConfirmDialog
        open={languageAsked !== null}
        onOpenChange={(open) => !open && askLanguage(null)}
        title={`Write everything in ${languageAsked ?? ""}?`}
        description={`Dossier's AI writes the resume, the cover letter and the email again in ${languageAsked ?? ""}: the same content, translated. A part that is in it already stays as it is${languageAsked === application.language ? ", so this only writes the parts that aren't" : ""}. It takes a minute or two. The earlier text stays in the history, and a part you edit meanwhile keeps your edit.`}
        confirmLabel={`Rewrite in ${languageAsked ?? ""}`}
        onConfirm={() => {
          const chosen = languageAsked;
          askLanguage(null);
          if (chosen) void rewriteLanguage(chosen);
        }}
      />
      {reply && <JobWatcher<RefineResult> key={reply.jobId} id={reply.jobId} revision={reply.revision} onChange={replyChanged} />}
      {letterJob?.jobId && <JobWatcher key={letterJob.jobId} id={letterJob.jobId} revision={letterJob.revision} onChange={letterChanged} />}
      {writingApp && <JobWatcher key={writingApp.jobId} id={writingApp.jobId} revision={0} onChange={writingChanged} />}
      {prepareJob?.jobId && <JobWatcher key={prepareJob.jobId} id={prepareJob.jobId} revision={prepareJob.revision} onChange={prepareChanged} />}
      {messageJob?.jobId && <JobWatcher key={messageJob.jobId} id={messageJob.jobId} revision={messageJob.revision} onChange={messageChanged} />}
      {emailJob?.jobId && (
        <JobWatcher<WriteEmailResult> key={emailJob.jobId} id={emailJob.jobId} revision={emailJob.revision} onChange={emailChanged} />
      )}
      <ApplicationHeader
        role={application.role}
        company={application.company}
        title={application.title}
        status={application.status}
        flag={flag}
        tabs={
          // On a phone, one row that scrolls sideways, faded at the edge with more (jobauto fork).
          <ScrollEdges className="max-sm:w-full">
            <TabsList
              variant="pills"
              aria-label="Application"
              className="max-sm:w-full max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:[&>*]:shrink-0 max-sm:[&>*]:whitespace-nowrap"
            >
              <TabsTrigger value="resume">Resume{dot(null)}</TabsTrigger>
              <TabsTrigger value="letter">Cover letter{dot(null)}</TabsTrigger>
              <TabsTrigger value="email">Email{dot(application.status === "DRAFT" && email ? "ready" : null)}</TabsTrigger>
              {/* The apply assistant and call prep (jobauto fork). */}
              <TabsTrigger value="apply">
                {apply.attempts[0]?.status === "WAITING" ? "Apply · waiting for you" : apply.attempts[0]?.status === "SUBMITTED" ? "Apply · sent" : "Apply"}
                {dot(null)}
              </TabsTrigger>
              {gmail && (gmail.reading || gmail.emails.length > 0) && <TabsTrigger value="conversation">Conversation{dot(waiting > 0 ? `${waiting} new` : null)}</TabsTrigger>}
              <TabsTrigger value="prep">Call prep{dot(null)}</TabsTrigger>
              {/* "My first 90 days" for this job (jobauto fork). */}
              <TabsTrigger value="sample">Work sample{dot(null)}</TabsTrigger>
              <TabsTrigger value="posting">Job posting{dot(null)}</TabsTrigger>
              {/* In the ⋯ menu on narrow windows (E30-3). */}
              <TabsTrigger value="notes" className="max-[1500px]:hidden">
                Notes{dot(null)}
              </TabsTrigger>
            </TabsList>
          </ScrollEdges>
        }
        actions={
          <>
            {application.archived && <span className="rounded-full bg-track px-3 py-1.5 text-meta text-muted">Archived</span>}
            {application.awaitingReview && (
              <Link href="/agent" className="rounded-full bg-warning-surface px-3 py-1.5 text-meta text-warning hover:text-warning">
                From the job agent · waiting for review
              </Link>
            )}
            <StatusControl id={application.id} status={application.status} interviewAt={application.nextInterviewAt} timeZone={timeZone} />
            {writingApp ? (
              <Button variant="secondary" aria-disabled="true">
                Writing…
              </Button>
            ) : sending ? (
              "href" in sending.target ? (
                <a href={sending.target.href} target="_blank" rel="noopener noreferrer" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
                  <Send size={15} aria-hidden="true" />
                  {sending.label}
                  <span aria-hidden>↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <Button onClick={() => "tab" in sending.target && selectTab(sending.target.tab)}>
                  <Send size={15} aria-hidden="true" />
                  {sending.label}
                </Button>
              )
            ) : next && (
              <Button
                onClick={() =>
                  next.start === "prepare"
                    ? prepare()
                    : next.start === "follow-up"
                      ? draftMessage("follow-up")
                      : next.label === "Review offer"
                        ? (setShowFit(false), setFitOpen(true))
                        : selectTab(next.tab)
                }
              >
                <NextIcon size={15} aria-hidden="true" />
                {next.label}
              </Button>
            )}
            <ApplicationMenu id={application.id} archived={application.archived} onNotes={() => selectTab("notes")} />
          </>
        }
      />

      {/* How to send a draft (jobauto fork): above the Fit column and the canvas. */}
      {sending && <SendGuide step={sending} letterAsks={letterAsks} onTab={selectTab} />}

      {/* On a phone the Fit column is a button above the document (jobauto fork). */}
      <div className="flex min-h-0 flex-1 max-sm:flex-col">
      <FitColumn match={match} open={fitOpen} onOpenChange={setFitOpen}>
        {application.status === "OFFER" && !showFit ? (
          <OfferPanel
            applicationId={application.id}
            offer={offer}
            postedSalary={application.salary ?? ""}
            drafting={messageJob !== null}
            aiReady={aiReady}
            onDraft={draftMessage}
            fitLine={match && match.items.length > 0 ? `${matchScore(match).hit} of ${matchScore(match).total} requirements covered` : "No requirements checked yet"}
            onShowFit={() => setShowFit(true)}
          />
        ) : application.status === "INTERVIEW" && !showFit ? (
          <InterviewPanel
            applicationId={application.id}
            interviews={interviews}
            timeZone={timeZone}
            inCalendar={inCalendar}
            preparing={prepareJob !== null}
            aiReady={aiReady}
            onPrepare={prepare}
            fitLine={match && match.items.length > 0 ? `${matchScore(match).hit} of ${matchScore(match).total} requirements covered` : "No requirements checked yet"}
            onShowFit={() => setShowFit(true)}
            onCallPrep={() => selectTab("prep")}
          />
        ) : (
        <>
        {(application.status === "INTERVIEW" || application.status === "OFFER") && (
          <button type="button" className="mb-4 text-meta text-link underline-offset-2 hover:underline" onClick={() => setShowFit(false)}>
            {application.status === "OFFER" ? "← Back to the offer" : "← Back to the interview"}
          </button>
        )}
        <FitPanel
          summary={
            <FitSummary
              applicationId={application.id}
              match={match}
              checking={checkingRequirements}
              canCheck={posting.text.trim() !== "" && !writingApp}
              note={writingApp && match && resumeMapped ? `${match.items.filter((item) => usedInResume.has(item.requirement)).length} of ${match.items.length} used in the resume so far` : undefined}
            />
          }
          meta={meta}
          match={match}
          requirements={requirements}
          knownGaps={knownGaps}
          roles={roles}
          onAddSkill={addSkill}
          onKnownGap={knownGap}
          onMention={letter ? mention : undefined}
          coverage={{
            selected,
            onSelect: (requirement) => {
              // Picking one ends the landing's selection.
              setLanding(null);
              setFocused(requirement);
            },
            served: writingApp ? usedInResume : served,
            places: writingPlaces ?? places,
            used: writingApp ? usedInResume : undefined,
          }}
        />
        </>
        )}
      </FitColumn>
      {/* The composer floats over the canvas; each tab leaves room for it under its content. */}
      <div className="@container relative flex min-h-0 min-w-0 flex-1 [--composer-space:15rem] max-sm:[--composer-space:6rem]">
        <TabsContent value="resume" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          {resume && resumeTheme && resumeUnits ? (
            <DocumentPreview
              maxWidth={820}
              reading={{
                // On a phone, the same resume to read, in one column (jobauto fork).
                title: "Tailored resume",
                document: (
                  <TailoredResume
                    resume={{ ...resume, theme: resumeTheme, units: resumeUnits }}
                    profile={profile}
                    paper={paper}
                    followThemeLayout={false}
                    showPhoto={photoChoice}
                    language={application.language}
                    includeReferences={includeReferences}
                    sections={sectionsChoice}
                  />
                ),
              }}
              meta={
                <span className="flex items-center gap-3">
                  {mappeButton}
                  {pdfButton("resume")}
                </span>
              }
              notice={writingStrip || (resume.trimmed?.length ? <TrimmedNotice items={resume.trimmed} onPutBack={putBack} /> : undefined)}
              label={
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-[13.5px] font-medium text-ink">Tailored resume</span>
                  {themeMenu(resumeTheme, [
                    ...(hasSidebar(resumeTheme.layout) ? [{ label: "Sidebar layout", checked: followLayout, onChange: changeLayout }] : []),
                    ...(profile.photo ? [{ label: "Photo", checked: showPhoto, onChange: changePhoto }] : []),
                  ])}
                  <SectionsMenu
                    sections={sectionsChoice}
                    present={sectionsWithContent(resumeContent(profile, { units: resumeUnits, includeReferences }))}
                    base={baseSections.map((section) => section.key)}
                    nameOf={(key) => baseSections.find((section) => section.key === key)?.name ?? sectionName(key, profile.customSections)}
                    isSidebar={(key) => inSidebar(key, profile.customSections)}
                    sidebar={followLayout && hasSidebar(resumeTheme.layout)}
                    own={ownSections}
                    sent={sent}
                    canUpdate={canUpdate}
                    onUpdate={updateProfile}
                    onChange={changeSections}
                    onAdd={addSection}
                    onFollowBase={followBase}
                  />
                  {languageMenu}
                  {notEnglish && aiReady && <EnglishCopy applicationId={application.id} kind={DocumentKind.RESUME} what="resume" />}
                  {historyButton(DocumentKind.RESUME)}
                  <Button variant="text" size="sm" aria-disabled={checking || undefined} onClick={runCheck}>
                    Check for ATS
                  </Button>
                </span>
              }
              panel={
                checking || check ? (
                  <div className="flex flex-col gap-3">
                    {checking && (
                      <p role="status" className="text-meta text-muted">
                        Checking…
                      </p>
                    )}
                    {check && <ResumeCheckCard report={check.report} onFix={applyFix} fixing={fixing} stale={check.of !== checkedState} />}
                  </div>
                ) : undefined
              }
            >
              <TailoredResume
                resume={{ ...resume, theme: resumeTheme, units: resumeUnits }}
                profile={profile}
                paper={paper}
                followThemeLayout={followLayout}
                showPhoto={photoChoice}
                language={application.language}
                includeReferences={includeReferences}
                sections={sectionsChoice}
                renderUnit={unitsOf(DocumentKind.RESUME, resumeUnits)}
              />
            </DocumentPreview>
          ) : writingApp && writingApp.write !== "letter" ? (
            <WritingPage strip={writingStrip} name={profile.basics.name} waiting="Your tailored resume is being written." />
          ) : (
            <WriteMissingDocument applicationId={application.id} kind={DocumentKind.RESUME} aiReady={aiReady} writing={writingDocuments.resume} />
          )}
        </TabsContent>

        <TabsContent value="letter" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          {letter && letterTheme && letterUnits ? (
            <DocumentPreview
              maxWidth={820}
              reading={{
                // On a phone, the same letter to read (jobauto fork).
                title: "Cover letter",
                document: (
                  <TailoredLetter
                    letter={{ ...letter, theme: letterTheme, units: letterUnits }}
                    profile={profile}
                    paper={paper}
                    company={application.company}
                    location={application.location}
                    tone={application.tone}
                    date={letterDate}
                    dateFormat={dateFormat}
                    language={application.language}
                    role={application.role}
                    anlagen={anlagen}
                  />
                ),
              }}
              label={
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-[13.5px] font-medium text-ink">Cover letter</span>
                  <ToneMenu tone={tone} disabled={letterJob !== null || rewritingIn !== null} onChange={(next) => rewriteInLetter({ tone: next })} />
                  <LanguageMenu
                    language={language}
                    languages={languages.length > 0 ? languages : undefined}
                    disabled={letterJob !== null || rewritingIn !== null}
                    onChange={(next) => rewriteInLetter({ language: next })}
                  />
                  {languageMenu}
                  {notEnglish && aiReady && <EnglishCopy applicationId={application.id} kind={DocumentKind.COVER_LETTER} what="cover letter" />}
                  {historyButton(DocumentKind.COVER_LETTER)}
                </span>
              }
              meta={
                <span className="flex items-center gap-3">
                  <Button variant="text" size="sm" title={aboutWords(paragraphs)} onClick={() => void copyLetter()}>
                    Copy text
                  </Button>
                  {mappeButton}
                  {pdfButton("letter")}
                </span>
              }
              notice={
                writingStrip ? (
                  writingStrip
                ) : rewritingIn || letterJob ? (
                  <p role="status" className="rounded-card bg-track px-4 py-2.5 text-meta text-muted">
                    Writing the letter again, in {language || "English"} and a {TONES[tone].label.toLowerCase()} tone…
                  </p>
                ) : letterAsks.length > 0 ? (
                  // What the posting asks the letter to state that has no standard answer yet (jobauto fork).
                  <p role="note" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card bg-warning-surface px-4 py-2.5 text-meta text-warning">
                    <span>
                      The posting asks for {missingWords(letterAsks)}. Add {letterAsks.length > 1 ? "them" : "it"} to your standard answers, then regenerate the closing paragraph.
                    </span>
                    <button type="button" className="font-medium underline underline-offset-2" onClick={() => selectTab("apply")}>
                      Open the Apply tab
                    </button>
                  </p>
                ) : undefined
              }
            >
              <TailoredLetter
                letter={{ ...letter, theme: letterTheme, units: letterUnits }}
                profile={profile}
                paper={paper}
                company={application.company}
                location={application.location}
                tone={application.tone}
                date={letterDate}
                dateFormat={dateFormat}
                language={application.language}
                renderUnit={unitsOf(DocumentKind.COVER_LETTER, letterUnits, letterStored)}
                role={application.role}
                anlagen={anlagen}
              />
            </DocumentPreview>
          ) : writingApp && writingApp.write !== "resume" ? (
            <WritingPage
              strip={writingStrip}
              name={profile.basics.name}
              waiting={writingApp.write === "both" && !resume ? "The cover letter is written once the resume is done." : "Your cover letter is being written."}
            />
          ) : (
            <WriteMissingDocument applicationId={application.id} kind={DocumentKind.COVER_LETTER} aiReady={aiReady} writing={writingDocuments.letter} />
          )}
        </TabsContent>

        <TabsContent value="email" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <EmailTab
            applicationId={application.id}
            units={emailUnits}
            renderUnit={!emailUnits ? plainUnit : unitsOf(DocumentKind.EMAIL, emailUnits)}
            history={historyButton(DocumentKind.EMAIL)}
            hint="Hover a part to edit or regenerate it"
            writing={emailJob !== null}
            onWrite={() => void writeEmail()}
            attachments={attachments}
            gmail={gmail && { sender: gmail.sender, sentBefore: gmail.sentBefore }}
            markAsSent={application.status === "DRAFT" ? <MarkAsSent id={application.id} variant={email ? "secondary" : "primary"} /> : undefined}
            before={messageTab === "email" ? messageCard : null}
          />
        </TabsContent>

        <TabsContent value="apply" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <ApplyTab applicationId={application.id} data={apply} onGoToEmail={() => selectTab("email")} gmailSends={Boolean(gmail?.sender.from)} />
        </TabsContent>

        <TabsContent value="sample" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <WorkSampleTab
            applicationId={application.id}
            data={workSample}
            aiReady={aiReady}
            theme={letterTheme ?? null}
            name={profile.basics.name}
            paper={paper}
            language={application.language}
          />
        </TabsContent>

        <TabsContent value="prep" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <PrepTab applicationId={application.id} data={prep} aiReady={aiReady} company={application.company} />
        </TabsContent>

        <TabsContent value="conversation" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <ConversationTab emails={gmail?.emails ?? []} moveTo={gmail?.moveTo ?? []} aiReady={aiReady} timeZone={timeZone} reading={gmail?.reading ?? false} after={messageTab === "conversation" ? messageCard : null} />
        </TabsContent>

        <TabsContent value="posting" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <PostingTab applicationId={application.id} posting={posting} facts={facts} setFacts={setFacts}>
            {/* The people she knows there, and what a German recruiter may wonder (jobauto fork). */}
            {known.length > 0 && (
              <div className="w-full max-w-[640px]">
                <KnownPeople people={known} />
              </div>
            )}
            <RecruiterEyeCard doubts={doubts} onOpenAnswers={() => selectTab("apply")} />
          </PostingTab>
        </TabsContent>

        <TabsContent value="notes" className="flex min-h-0 min-w-0 flex-[999_1_480px]">
          <NotesTab applicationId={application.id} activity={activity} />
        </TabsContent>

        {writingApp && <WritingNote notifies={writingApp.notifies} stopping={stopping} onStop={() => void stopWriting()} />}
        {tab !== "notes" && !writingApp && (
          <Composer
            tab={tab}
            status={application.status}
            mode={composerMode}
            canChange={onScreen() !== null || target !== null}
            onModeChange={setMode}
            suggestions={tab === "resume" ? suggestions.resume : tab === "letter" ? suggestions.letter : tab === "email" && email ? suggestions.email : []}
            thinking={reply !== null}
            target={target}
            onClearTarget={() => setTarget(null)}
            onSend={(text) => send(text)}
            aiReady={aiReady}
            focusRequest={chatFocus}
            above={
              <>
                {historyOpen && <HistoryPanel entries={history} busy={goingBack} onGoBack={(ids) => void goBack(ids, "Went back. What you had is in the history too.")} onUndo={undoLatest} onClose={() => setHistoryOpen(false)} />}
                <LatestReply
                  change={shownChange && { text: shownChange.text, canUndo: undoIds(shownChange) !== null || shownChange.messageId !== undefined }}
                  message={shownReply}
                  thinking={reply !== null}
                  undoing={goingBack}
                  onUndo={undoLatest}
                  onHide={() => shownReply && setHiddenReply(shownReply.id)}
                  earlier={
                    earlier > 0 && (
                      <button
                        type="button"
                        aria-expanded={historyOpen}
                        onClick={() => setHistoryOpen(!historyOpen)}
                        className="text-[12.5px] text-muted hover:text-ink"
                      >
                        {earlier} earlier <span aria-hidden="true">{historyOpen ? "▾" : "▴"}</span>
                      </button>
                    )
                  }
                />
              </>
            }
          />
        )}
      </div>
      </div>
    </Tabs>
    </div>
  );
}

/** Units that glow for a moment after they changed; `start` makes them glow. */
function useFlashing() {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const start = (started: string[]) => {
    setKeys((current) => new Set([...current, ...started]));
    for (const key of started) {
      clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setKeys((current) => new Set([...current].filter((entry) => entry !== key)));
        }, FLASH_MS),
      );
    }
  };

  return { keys, start };
}
