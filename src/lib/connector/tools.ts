import "server-only";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApplicationStatus, DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { approveCandidate } from "@/lib/agent/draft";
import { isAiUsable } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { moveAsSentOn } from "@/lib/application-create";
import { factorsFrom } from "@/lib/ai/tasks/score-posting";
import { fitFromAnswers } from "@/lib/fit";
import { GoogleError } from "@/lib/google/errors";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { JobSearchError } from "@/lib/job-search/errors";
import {
  DEFAULT_RADIUS_KM,
  EXPERIENCE_LEVELS,
  experienceAskedFor,
  POSTED_WITHIN,
  RADII_KM,
  type ExperienceLevel,
  type PostedWithin,
  type SearchQuery,
} from "@/lib/job-search/search";
import { startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { coverageOf, fitWords } from "@/lib/posting-coverage";
import { saveScore } from "@/lib/posting-scores";
import { postingsOfSearch } from "@/lib/library";
import { sameLinkApplication } from "@/lib/posting-application";
import { loadSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { foundFromPosting } from "@/lib/postings";
import { postingApplication, startPreparing } from "@/lib/jobs/prepare-application";
import { prepareOnStatus } from "@/lib/jobs/prepare-call";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { levelsProblem, profileNamed } from "@/lib/profiles";
import { LOCATION_FITS, SENIORITY_FITS } from "@/lib/scoring/factors";
import { MAX_LINES } from "@/lib/scoring/posting-lines";
import { EDUCATION_LEVELS, EXTRA_LEVELS, LOCATION_OPTIONS, REQUIREMENT_KINDS, SENIORITY_OPTIONS, WORK_LEVELS } from "@/lib/scoring/questions";
import { statusInfo } from "@/lib/status";
import { applyStatusChange } from "@/lib/status-changes";
import { lastKnownTimeZone } from "@/lib/time-zone";
import { appVersion } from "@/lib/version";

import { connectorDraftJob } from "./draft";
import { documentText, failure, hasMore, herGerman, portalProblems, portalsAnswered, postingLine, postingSource, profileInput, resolvePosting, started, text, type ToolContext } from "./kit";
import { registerAgentTools } from "./tools/agent";
import { registerApplicationTools } from "./tools/applications";
import { registerApplyTools } from "./tools/apply";
import { registerDocumentTools } from "./tools/documents";
import { registerInboxTools } from "./tools/inbox";
import { messageDraftView, offerView, registerInterviewTools, roundsView } from "./tools/interviews";
import { registerPostingTools } from "./tools/postings";
import { registerProfileTools } from "./tools/profile";
import { registerRecruiterTools } from "./tools/recruiters";
import { registerCareersTools } from "./tools/careers";
import { registerPrepTools } from "./tools/prep";
import { registerSettingsTools } from "./tools/settings";
import { registerTaskTools } from "./tools/tasks";
import { registerTodayTools } from "./tools/today";
import {
  reviseWrittenApplication,
  saveWrittenApplication,
  WRITTEN_IN_CLAUDE,
  writtenDetailsSchema,
  writtenLetterSchema,
  writtenMatchSchema,
  writtenResumeSchema,
} from "./write";

// The Claude connector's tools (#221, src/app/api/mcp), adapted from Anirudh
// Sharma's fork of Dossier: search for jobs, read the profile and the
// applications, save applications and fit scores, and move applications
// along. The jobauto fork adds a group of tools per screen (./tools/*), so
// Claude can do what the screens do. Tools that send, delete or archive say
// so in their description and carry destructiveHint, for the user to allow
// one by one. No tool reads or saves a secret, deletes everything, imports
// over the data or turns the connector off. Contact details, references'
// email and phone, and a letter's sender and signature stay out of what
// Claude reads; private notes only through list_notes, when the user asks.

const POSTED = POSTED_WITHIN.map((option) => option.value) as [PostedWithin, ...PostedWithin[]];
const LEVELS = EXPERIENCE_LEVELS.map((option) => option.value) as [ExperienceLevel, ...ExperienceLevel[]];

/** Failures whose messages are written for the user, so Claude may pass them on as they are. */
const FOR_THE_USER = [ActionError, AiError, GoogleError, JobSearchError];

/** "product designer in Berlin (remote only, entry level)": what search_jobs searched. */
function searchedLine(query: SearchQuery, country: string): string {
  const level = EXPERIENCE_LEVELS.find((option) => option.value === experienceAskedFor(query));
  const notes = [query.remoteOnly ? "remote only" : "", level ? level.label.toLowerCase() : ""].filter(Boolean);
  return `${query.keywords} in ${query.place || country}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

/**
 * Makes every tool registered on `server` answer an unexpected error with a
 * plain message, logged on the server: the SDK would otherwise hand Claude
 * the raw message, which can hold database details.
 */
function guardTools(server: McpServer): McpServer {
  type Handler = (...args: unknown[]) => unknown;
  const register = server.registerTool.bind(server) as (name: string, config: unknown, handler: Handler) => unknown;
  (server as { registerTool: unknown }).registerTool = (name: string, config: unknown, handler: Handler) =>
    register(name, config, async (...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        if (FOR_THE_USER.some((kind) => error instanceof kind)) return failure((error as Error).message);
        logServerError(`Claude connector: ${name}`, error);
        return failure("Dossier couldn't do that just now. Try again in a moment, or do it in the app.");
      }
    });
  return server;
}

// save_job_scores takes the answers Dossier's scoring models give (E25-1), so
// a score written in Claude chat counts requirements like any other.
const scale = (levels: readonly { means: string }[]) => levels.map((level, index) => `${index}: ${level.means}`).join(" ");
const choices = (options: Record<string, { means: string }>) =>
  Object.entries(options)
    .map(([value, { means }]) => `"${value}": ${means}`)
    .join(" ");
const reason = z.string().max(300).describe("One short sentence to the user (\"You…\"), pointing at the posting and the profile");
const levelAnswer = (levels: readonly { means: string }[]) => z.object({ level: z.number().int().min(0).max(levels.length - 1).describe(scale(levels)), reason });
const answersSchema = z.object({
  requirements: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(300).describe("One thing the posting asks of applicants, copied word for word from the posting"),
        must_have: z.boolean().describe(`true for ${REQUIREMENT_KINDS.must.means} false for ${REQUIREMENT_KINDS.nice.means}`),
        covered: z.boolean().describe("Whether the profile shows it, anywhere in it, directly or clearly, never a stretch"),
        evidence: z.string().max(120).optional().describe("When covered: the part of the profile that shows it, in a few words, such as \"Senior Designer at Acme\" or \"Figma (skill)\""),
        skill: z.string().max(60).optional().describe("The one skill, tool or language it's about, as the user would list it, such as \"Kubernetes\"; left out when it's about something else, such as years or a degree"),
      }),
    )
    .max(MAX_LINES)
    .describe("Each requirement once. Leave out what isn't asked of applicants, such as the company, the team, the job's tasks, benefits, pay or how to apply."),
  work: levelAnswer(WORK_LEVELS).describe("How close the profile's paid work is to the job's day-to-day work"),
  extra: levelAnswer(EXTRA_LEVELS).describe("How much the profile's projects, volunteering, certifications, publications and other activities support it for the job"),
  education: levelAnswer(EDUCATION_LEVELS).describe("How well the profile's education meets what the posting asks for"),
  seniority: z.object({ fit: z.enum(SENIORITY_FITS).describe(choices(SENIORITY_OPTIONS)), reason }).describe("The job's level against jobsItsFor from get_profile"),
  location: z.object({ fit: z.enum(LOCATION_FITS).describe(choices(LOCATION_OPTIONS)), reason }).describe("Whether the user can work where and how the job is, by whereItWantsToWork from get_profile"),
  thin: z.boolean().default(false).describe("true when the posting is too short or too vague to tell what it requires of applicants"),
});

/**
 * Dossier as an MCP server, for one request; `origin` is the address links in
 * answers point to, `clientName` the name the client signed in with.
 */
export function createDossierServer(origin: string, clientName = ""): McpServer {
  const linkTo = (path: string) => `${origin}${path}`;
  const server = guardTools(
    new McpServer(
      { name: "dossier", title: "Dossier", version: appVersion },
      {
        instructions:
          "Dossier is the user's own job search app: their profiles (one per kind of job they look for), tailored resumes and cover letters, and every application tracked from Draft to Offer. " +
          "Its tools do what its screens do. Tools that read or write a profile take its name as profile (get_profile lists them); without one they use the first. " +
          "When the user asks what to do next, get_today answers as the dashboard does: its Do today list (Today's three and Needs you), the weekly target and what's left of Start here. " +
          "Find jobs with search_jobs (in the profile's city and country unless the user says otherwise) and more_jobs: they ask every portal switched on in Settings and keep what they find in Positions; " +
          "keep its keywords short, as a portal treats every word as a requirement: get_search_words suggests them from the profile; " +
          "jobs you find yourself on the web go into Positions with add_found_jobs, marked as found by an AI client; score postings yourself and save the scores with save_job_scores, " +
          "or have Dossier's AI score them with score_with_dossier; keep or drop postings with update_postings. " +
          "To draft an application, write it yourself: call get_profile and get_posting, write a tailored resume and cover letter from facts in the profile only " +
          "(never invent experience, employers, numbers or degrees; say what's missing instead), show the user a short summary, then save it with save_application; " +
          "change a saved Draft with update_application rather than saving it again. " +
          "Or let Dossier's AI draft it with draft_application, which prepares a posting from Positions as Prepare it for me does: one application per posting. Review and change documents with get_document and edit_document, rewrite them with rewrite_document, and get PDFs with export_pdf. " +
          "Recruiters are the agencies and recruiters on Find work → Recruiters: list_recruiters, add_recruiter, update_recruiter, set_recruiter_status, snooze_recruiter and remove_recruiter keep track of them, " +
          "and draft_recruiter_message drafts the message to write; Dossier sends nothing, so record that the user wrote or heard back only when they say so. " +
          "check_resume says whether a resume's PDF reads correctly for an applicant tracking system, names the posting's requirements, and has clean text. " +
          "Rehearse a first call with get_call_prep for an application, or get_practice_prep before there is one; get_salary_guide fills the salary line. " +
          "Change the profile only with what the user told you or confirmed. " +
          "Work that takes a while answers with a task_id: follow it with check_task. " +
          "start_apply fills in the employer's application form in a browser window on the computer Dossier runs on, or in the laptop's Chrome set up for it; the user checks it and presses Send there, then settle_apply records it. " +
          "It types the user's details into the employer's site, so use it only when the user asked for exactly that; on a server without a screen and no laptop Chrome set up, it says so and opens nothing. " +
          "search_jobs, more_jobs, test_connection of a portal and update_job_agent with run_now spend searches from the user's paid portal plans (JSearch, SerpApi): run them when the user asks for a search, not again on your own, and never in a loop. " +
          "Tools marked destructive send email, delete or can't be undone: use them only when the user asked for exactly that, after telling them what will happen. " +
          "Links in answers open the screen in Dossier where the user sees the result.",
      },
    ),
  );

  server.registerTool(
    "search_jobs",
    {
      title: "Search for jobs",
      description:
        "Searches every job portal switched on in Settings → Job search that lists jobs in the country, and keeps what they find in Positions. A portal that limits searches, such as JSearch, counts it as one of them. " +
        "Keep the keywords to a title or two or three words (get_search_words suggests them): a whole headline finds nothing. " +
        "Returns a search_id and numbered postings; pass both to get_posting, save_job_scores or save_application, or the search_id to more_jobs.",
      inputSchema: z.object({
        keywords: z.string().trim().min(1).max(200).describe("Job title, skill or company, e.g. 'product designer'"),
        place: z.string().max(200).optional().describe("City or region. Defaults to the profile's city. Use '' for the whole country."),
        country: z.string().max(60).optional().describe("Country name or ISO code, e.g. 'Germany' or 'de'. Defaults to the profile's country."),
        remote_only: z.boolean().optional().describe("Only remote postings."),
        radius_km: z.literal(RADII_KM).optional(),
        posted_within: z.enum(POSTED).optional().describe("any, day, 3days, week or month. Defaults to month."),
        experience: z
          .enum(LEVELS)
          .optional()
          .describe(
            "The experience level, as the Level in Positions' search: any, intern, junior (entry level), mid, senior or lead. Defaults to any. " +
              "Postings for another level are left out, so a page can come back short: more_jobs has the next.",
          ),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (input) => {
      const { basics } = await loadProfile();
      const country = countryCodeFor(input.country ?? basics.country) || (input.country?.trim().length === 2 ? input.country.trim().toLowerCase() : "");
      if (!country) return failure("Say which country to search in, e.g. country: 'Germany'.");
      const remoteOnly = input.remote_only ?? false;
      const query: SearchQuery = {
        keywords: input.keywords,
        place: remoteOnly ? "" : (input.place ?? basics.city).trim(),
        country,
        radiusKm: input.radius_km ?? DEFAULT_RADIUS_KM,
        remoteOnly,
        postedWithin: input.posted_within ?? "month",
        // Left out rather than "any", as Find jobs does (public issue 100).
        ...(input.experience ? { experience: input.experience } : {}),
      };
      const ran = await runSearch(query, { wait: true });
      if (!ran.ok) return failure(ran.message);
      const search = await loadSearch(ran.id);
      if (!search) return failure("The search ran, but couldn't be read back. Try again.");
      return text({
        search_id: search.id,
        searched: searchedLine(query, countryName(country)),
        // The portals that answered, and those that failed or were skipped, with why (E22-4).
        portals: portalsAnswered(search.portals),
        problems: portalProblems(search.portals),
        found: search.postings.length,
        more_available: hasMore(search.portals),
        postings: await herGerman().then((german) => search.postings.map((posting, index) => postingLine(posting, index + 1, german))),
        link: linkTo(`/jobs?search=${search.id}`),
      });
    },
  );

  server.registerTool(
    "more_jobs",
    {
      title: "Show more jobs",
      description: "The next page of a search from search_jobs, from the portals that have more. A portal that limits searches counts it as one of them.",
      inputSchema: z.object({ search_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ search_id }) => {
      const before = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { found: true } });
      if (!before) return failure("That search is no longer kept. Search again.");
      const more = await showMoreFor(search_id, { wait: true });
      if (!more.ok) return failure(more.message);
      return text({
        search_id,
        added: more.postings.length,
        more_available: more.next !== null,
        postings: await herGerman().then((german) => more.postings.map((posting, index) => postingLine(posting, before.found + index + 1, german))),
      });
    },
  );

  server.registerTool(
    "save_job_scores",
    {
      title: "Save fit scores for postings",
      description:
        "Saves how well postings fit a profile (from a search_jobs search by number, or handed over by posting_id), so Positions shows how many of each posting's requirements the profile covers, with the reasons. " +
        "Read the profile with get_profile first, and the whole posting with get_posting when the snippet is too short to judge. " +
        "For each posting, answer the questions Dossier's scoring models answer: each requirement, whether it's a must-have and whether the profile shows it; then work, extra activities, education, seniority and location. Dossier adds the answers up. " +
        "Never invent experience, and never use age, gender, nationality or any other protected characteristic.",
      inputSchema: z.object({
        search_id: z.string().max(100).optional().describe("The search the numbered postings are from"),
        scores: z
          .array(
            answersSchema.extend({
              number: z.number().int().min(1).optional().describe("The posting's number in the search"),
              posting_id: z.string().max(100).optional().describe("Instead of a number: a posting Dossier handed over"),
            }),
          )
          .min(1)
          .max(50),
        profile: profileInput.describe("The profile from get_profile the scores are against; the first when left out"),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ search_id, scores, profile }) => {
      // Each posting keeps a score per profile (E25-5).
      const chosen = await profileNamed(profile);
      if ("error" in chosen) return failure(chosen.error);
      // As in Dossier, nothing scores against a profile until the user has chosen its levels (E24-3).
      const waiting = await levelsProblem(chosen.id);
      if (waiting) return failure(`${waiting.message} Ask the user which levels it's for and save them with set_profile_levels, or they choose them in Profile → Jobs it's for: ${linkTo(waiting.href)}`);
      const search = search_id ? await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { id: true } }) : null;
      if (search_id && !search) return failure("That search is no longer kept. Search again.");
      const kept = search ? await postingsOfSearch(search.id) : [];
      const saved: { number?: number; posting_id?: string; title: string; covered: string; fit: string }[] = [];
      const missing: (number | string)[] = [];
      for (const entry of scores) {
        const row = entry.posting_id ? await prisma.posting.findUnique({ where: { id: entry.posting_id } }) : null;
        const posting = row ? foundFromPosting(row) : entry.number ? kept[entry.number - 1] : undefined;
        if (!posting) {
          missing.push(entry.posting_id ?? entry.number ?? "?");
          continue;
        }
        // The requirements stand in for the posting's numbered lines, which the AI model answers by number.
        const requirements = entry.requirements.map((requirement, line) => ({
          line,
          kind: requirement.must_have ? ("must" as const) : ("nice" as const),
          covered: requirement.covered,
          evidence: requirement.evidence ?? "",
          skill: requirement.skill ?? "",
        }));
        const fit = fitFromAnswers(factorsFrom({ ...entry, requirements }, entry.requirements.map((requirement) => requirement.text)));
        await saveScore(posting, fit, WRITTEN_IN_CLAUDE, chosen.id);
        const coverage = coverageOf(fit);
        saved.push({ number: entry.number, posting_id: entry.posting_id, title: posting.title, covered: `${coverage.hit} of ${coverage.total}`, fit: fitWords(coverage) });
      }
      return text({ saved, not_found: missing.length > 0 ? missing : undefined, link: linkTo(search_id ? `/jobs?search=${search_id}` : "/jobs?view=saved") });
    },
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "The user's applications in Dossier, newest activity first, with their status. Optionally only one status.",
      inputSchema: z.object({
        status: z.enum(ApplicationStatus).optional().describe("DRAFT, SENT, SCREENING, INTERVIEW, OFFER, ACCEPTED, REJECTED or DECLINED"),
        include_archived: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ status, include_archived, limit }) => {
      const rows = await prisma.application.findMany({
        where: { awaitingReview: false, ...(status ? { status } : {}), ...(include_archived ? {} : { archivedAt: null }) },
        orderBy: { updatedAt: "desc" },
        take: limit ?? 30,
        select: { id: true, title: true, company: true, role: true, location: true, status: true, updatedAt: true, postingUrl: true },
      });
      return text(
        rows.map((row) => ({
          id: row.id,
          title: row.title,
          company: row.company,
          role: row.role,
          location: row.location,
          status: statusInfo(row.status).label,
          updated: row.updatedAt.toISOString().slice(0, 10),
          posting: row.postingUrl || undefined,
          link: linkTo(`/applications/${row.id}`),
        })),
      );
    },
  );

  server.registerTool(
    "get_application",
    {
      title: "Read an application",
      description:
        "One application with its posting, how the profile matches it, the tailored resume and cover letter as text, and once there are, its interview rounds, offer and drafted message. " +
        "Private notes and contact details are left out.",
      inputSchema: z.object({ id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const application = await prisma.application.findUnique({
        where: { id, awaitingReview: false },
        select: {
          id: true,
          title: true,
          company: true,
          role: true,
          location: true,
          mode: true,
          salary: true,
          status: true,
          postingUrl: true,
          postingText: true,
          match: true,
          sentAt: true,
          documents: { select: { kind: true, units: true } },
          interviews: { select: { id: true, round: true, at: true, minutes: true, place: true, people: true, notes: true, prep: true } },
          offer: true,
          messageDraft: true,
          workSample: true,
        },
      });
      if (!application) return failure("That application no longer exists.");
      const doc = (kind: DocumentKind) => documentText(application.documents.find((document) => document.kind === kind)?.units);
      const timeZone = application.interviews.length > 0 ? await lastKnownTimeZone() : undefined;
      return text({
        id: application.id,
        title: application.title,
        company: application.company,
        role: application.role,
        location: application.location,
        mode: application.mode,
        salary: application.salary,
        status: statusInfo(application.status).label,
        posting_url: application.postingUrl || undefined,
        posting: application.postingText.slice(0, 20_000),
        match: application.match,
        resume: doc(DocumentKind.RESUME),
        cover_letter: doc(DocumentKind.COVER_LETTER),
        // What came after applying (1.15), as its page's Interview and Offer columns keep it.
        sent_on: application.sentAt?.toISOString().slice(0, 10),
        interviews: timeZone ? roundsView(application.interviews, timeZone) : undefined,
        time_zone: timeZone,
        offer: offerView(application.offer) ?? undefined,
        message_draft: messageDraftView(application.messageDraft),
        work_sample: application.workSample ? "get_work_sample reads it" : undefined,
        link: linkTo(`/applications/${application.id}`),
      });
    },
  );

  server.registerTool(
    "get_posting",
    {
      title: "Read a posting",
      description:
        "The whole text of a job posting, from a search (search_id and number), one Dossier handed over (posting_id or paste_id) or a link (posting_url), to write an application from or score.",
      inputSchema: z.object({
        posting_id: postingSource.posting_id,
        paste_id: postingSource.paste_id,
        search_id: postingSource.search_id,
        number: postingSource.number,
        posting_url: postingSource.posting_url,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const posting = await resolvePosting(input);
      if ("error" in posting) return failure(posting.error);
      return text({ url: posting.url || undefined, title: posting.title, company: posting.company, place: posting.place, text: posting.text });
    },
  );

  server.registerTool(
    "save_application",
    {
      title: "Save an application you wrote",
      description:
        "Saves a tailored resume and cover letter you wrote as a Draft application in Dossier, where the user can review, edit and download them as PDFs. " +
        "Give the posting (posting_id or paste_id when Dossier handed it over, search_id and number, posting_url or posting_text), its details, the resume (by the ids from get_profile) and the letter. " +
        "Only use facts from the profile. Nothing is sent. A posting gets one application: one that has an application already, or one being written, answers with it and nothing is saved; " +
        "to change an application already saved, use update_application instead of saving it again.",
      inputSchema: z.object({
        ...postingSource,
        details: writtenDetailsSchema,
        resume: writtenResumeSchema,
        cover_letter: writtenLetterSchema,
        match: writtenMatchSchema.describe("What the posting asks for and whether the profile covers it, partly covers it, or has a gap; Dossier shows it as the application's match"),
        note: z.string().max(2000).optional().describe("What the user asked to stress, kept with the application"),
        profile: profileInput.describe("The profile from get_profile the resume was written from; the first when left out"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ details, resume, cover_letter, match, note, profile, ...source }) => {
      const chosen = await profileNamed(profile);
      if ("error" in chosen) return failure(chosen.error);
      const posting = await resolvePosting(source);
      if ("error" in posting) return failure(posting.error);
      // One application per posting, as Prepare it for me and draft_application keep it (audit round 2).
      const existing = posting.postingId ? await postingApplication(posting.postingId) : { jobId: null, applicationId: await sameLinkApplication(posting.url) };
      if (existing.applicationId) {
        return text({
          application_id: existing.applicationId,
          status: "exists",
          message: "This posting has an application already, so nothing was saved.",
          next: "Read it with get_application; to put what you wrote in it, use update_application on this application_id.",
          link: linkTo(`/applications/${existing.applicationId}`),
        });
      }
      if (existing.jobId) {
        return text({
          task_id: existing.jobId,
          status: "being written",
          message: "Dossier is writing this posting's application already, so nothing was saved.",
          next: "Follow it with check_task; once it's done, change it with update_application.",
        });
      }
      const saved = await saveWrittenApplication({
        profileId: chosen.id,
        posting: posting.text.slice(0, 100_000),
        postingUrl: posting.url.slice(0, 2000),
        postingId: posting.postingId,
        details,
        resume,
        letter: cover_letter,
        match,
        note: note ?? "",
      });
      return text({
        application_id: saved.applicationId,
        status: "Draft",
        link: linkTo(`/applications/${saved.applicationId}`),
        check_these: saved.unverified.length > 0 ? saved.unverified : undefined,
        next: saved.unverified.length > 0 ? "Dossier marked names or numbers it couldn't find in the profile or posting; tell the user to check them." : undefined,
      });
    },
  );

  server.registerTool(
    "update_application",
    {
      title: "Change a draft application",
      description:
        "Replaces the resume, the cover letter or the match of a Draft application, for changes the user asks for after save_application. " +
        "Read it with get_application first and keep what the user changed by hand. Give only the parts that change, each whole, in save_application's form; the rest stays. " +
        "Only a Draft can be changed. Only use facts from the profile. Nothing is sent.",
      inputSchema: z.object({
        application_id: z.string().min(1).max(100),
        change: z.string().trim().min(1).max(200).describe("What the user asked to change, in a few words, e.g. 'Shorter first bullet'; shown in the document's history"),
        resume: writtenResumeSchema.optional(),
        cover_letter: writtenLetterSchema.optional(),
        // Without save_application's default: a match left out stays as it is.
        match: writtenMatchSchema.unwrap().optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ application_id, change, resume, cover_letter, match }) => {
      if (!resume && !cover_letter && !match) return failure("Give the resume, cover_letter or match to change.");
      const revised = await reviseWrittenApplication(application_id, { resume, letter: cover_letter, match, change });
      if ("error" in revised) return failure(revised.error);
      return text({
        application_id,
        status: "Draft",
        link: linkTo(`/applications/${application_id}`),
        check_these: revised.unverified.length > 0 ? revised.unverified : undefined,
        next: revised.unverified.length > 0 ? "Dossier marked names or numbers it couldn't find in the profile or posting; tell the user to check them." : undefined,
      });
    },
  );

  server.registerTool(
    "draft_application",
    {
      title: "Have Dossier draft an application",
      description:
        "Has Dossier's own AI model draft the application, only when an AI provider is set up in Dossier's settings. " +
        "A posting Positions keeps (posting_id, or search_id and number) is prepared as Prepare it for me on Positions does it: it gets one application, and the email too when the employer takes applications by email; " +
        "a posting that has one already answers with it. Without an AI model, write it yourself with get_profile, get_posting and save_application. " +
        "Takes one to three minutes: follow it with check_task.",
      inputSchema: z.object({
        ...postingSource,
        note: z.string().max(2000).optional().describe("Anything the documents should stress, in the user's words"),
        profile: profileInput.describe("The profile to write it from; left out, the one that fits the posting best, else the first"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ note, profile, ...source }) => {
      if (!(await isAiUsable())) {
        return failure("Dossier has no AI model of its own set up. Write the application yourself: get_profile, get_posting, then save_application.");
      }
      const chosen = await profileNamed(profile);
      if ("error" in chosen) return failure(chosen.error);
      // The one writer Positions' Prepare it for me uses, so a posting it keeps gets one application (round 2 of the audit).
      const prepare = async (postingId: string) => {
        const prepared = await startPreparing(postingId, { profileId: profile === undefined ? null : chosen.id, note: note ?? "" });
        if (!prepared.applicationId) return started(prepared.jobId!, { posting_id: postingId, link: linkTo("/jobs") });
        return text({
          application_id: prepared.applicationId,
          status: "exists",
          message: "This posting has an application already, so no second one is made.",
          next: "get_application reads it.",
          link: linkTo(`/applications/${prepared.applicationId}`),
        });
      };
      // Prepared from what Positions keeps, as its button does: nothing to fetch.
      if (source.posting_id) return prepare(source.posting_id);
      const posting = await resolvePosting(source);
      if ("error" in posting) return failure(posting.error);
      // A posting from a search is kept in Positions first, then prepared the same way.
      if (posting.postingId) return prepare(posting.postingId);
      const jobId = await startJob(connectorDraftJob, {
        posting: posting.text.slice(0, 100_000),
        postingUrl: posting.url.slice(0, 2000),
        note: note ?? "",
        postingId: null,
        profileId: chosen.id,
      });
      return started(jobId);
    },
  );

  server.registerTool(
    "set_application_status",
    {
      title: "Move an application",
      description:
        "Changes an application's status, e.g. to SENT once the user has applied, or INTERVIEW. It only records the change; nothing is sent. " +
        "For one sent before today, give sent_on, as Already sent it? does in New application.",
      inputSchema: z.object({
        id: z.string().min(1).max(100),
        status: z.enum(ApplicationStatus),
        sent_on: z.iso.date().optional().describe("The day it was sent, YYYY-MM-DD, while it isn't marked sent yet"),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, status, sent_on }) => {
      if (sent_on) {
        if (status === ApplicationStatus.DRAFT) return failure("sent_on goes with SENT or a later status.");
        // A day ahead allows for time zones east of the server's, as Already sent it? does.
        if (Date.parse(`${sent_on}T00:00:00Z`) > Date.now() + 24 * 60 * 60 * 1000) return failure("The day it was sent can't be in the future.");
        const before = await prisma.application.findUnique({ where: { id }, select: { sentAt: true } });
        if (!before) return failure("That application no longer exists.");
        if (before.sentAt) return failure(`It's marked sent on ${before.sentAt.toISOString().slice(0, 10)} already; sent_on is only for one not marked sent yet.`);
      }
      // A job agent draft waiting for review is approved first, as moving it on the Agent screen does.
      if (status !== ApplicationStatus.DRAFT) {
        const pending = await prisma.agentCandidate.findFirst({ where: { applicationId: id, application: { awaitingReview: true } }, select: { id: true } });
        if (pending) await approveCandidate(pending.id);
      }
      const result = sent_on && status !== ApplicationStatus.DRAFT ? await moveAsSentOn(id, sent_on, status) : await applyStatusChange(prisma, id, status);
      if (result.outcome === "not-found") return failure("That application no longer exists.");
      if (result.outcome === "changed") await prepareOnStatus(id, status);
      return text({ id, status: statusInfo(status).label, changed: result.outcome !== "unchanged", sent_on });
    },
  );

  const context: ToolContext = { server, linkTo, clientName };
  registerTodayTools(context);
  registerProfileTools(context);
  registerDocumentTools(context);
  registerApplicationTools(context);
  registerInterviewTools(context);
  registerApplyTools(context);
  registerPostingTools(context);
  registerRecruiterTools(context);
  registerCareersTools(context);
  registerPrepTools(context);
  registerTaskTools(context);
  registerAgentTools(context);
  registerInboxTools(context);
  registerSettingsTools(context);

  return server;
}
