import "server-only";

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { ApplicationStatus, DocumentKind } from "@/generated/prisma/enums";
import { ActionError } from "@/lib/action";
import { approveCandidate } from "@/lib/agent/draft";
import { isAiUsable } from "@/lib/ai/config";
import { AiError } from "@/lib/ai/errors";
import { scoreFrom } from "@/lib/ai/tasks/score-posting";
import { fitBand } from "@/lib/fit";
import { GoogleError } from "@/lib/google/errors";
import { countryCodeFor, countryName } from "@/lib/job-search/countries";
import { JobSearchError } from "@/lib/job-search/errors";
import { DEFAULT_RADIUS_KM, foundPostingSchema, POSTED_WITHIN, RADII_KM, type JobSource, type PostedWithin, type SearchQuery } from "@/lib/job-search/search";
import { describeSourceProblem } from "@/lib/job-search/sources";
import { getJob, startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { saveScore } from "@/lib/posting-scores";
import { loadSearch, runSearch, showMoreFor } from "@/lib/posting-searches";
import { foundFromPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { statusInfo } from "@/lib/status";
import { applyStatusChange } from "@/lib/status-changes";
import { appVersion } from "@/lib/version";

import { connectorDraftJob } from "./draft";
import { documentText, failure, postingLine, postingSource, resolvePosting, text, type ToolContext } from "./kit";
import { registerAgentTools } from "./tools/agent";
import { registerApplicationTools } from "./tools/applications";
import { registerApplyTools } from "./tools/apply";
import { registerDocumentTools } from "./tools/documents";
import { registerInboxTools } from "./tools/inbox";
import { registerPostingTools } from "./tools/postings";
import { registerProfileTools } from "./tools/profile";
import { registerSettingsTools } from "./tools/settings";
import { registerTaskTools } from "./tools/tasks";
import { saveWrittenApplication, WRITTEN_IN_CLAUDE, writtenDetailsSchema, writtenLetterSchema, writtenMatchSchema, writtenResumeSchema } from "./write";

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

/** Failures whose messages are written for the user, so Claude may pass them on as they are. */
const FOR_THE_USER = [ActionError, AiError, GoogleError, JobSearchError];

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

/**
 * Dossier as an MCP server, for one request; `origin` is the address links in
 * answers point to, `clientName` the name the client signed in with.
 */
/** The sources search_jobs can be asked for, as the From filter names them. */
const SOURCE_NAMES = ["jsearch", "serpapi", "adzuna", "arbeitsagentur"] as const satisfies readonly Lowercase<JobSource>[];

export function createDossierServer(origin: string, clientName = ""): McpServer {
  const linkTo = (path: string) => `${origin}${path}`;
  const server = guardTools(
    new McpServer(
      { name: "dossier", title: "Dossier", version: appVersion },
      {
        instructions:
          "Dossier is the user's own job search app: one profile, tailored resumes and cover letters, and every application tracked from Draft to Offer. " +
          "Its tools do what its screens do. " +
          "Find jobs with search_jobs (in the profile's city and country unless the user says otherwise) and more_jobs; " +
          "jobs you find yourself on the web go into Find jobs with add_found_jobs, kept apart from the job source's as found by an AI client; score postings yourself and save the scores with save_job_scores, " +
          "or have Dossier's AI score them with score_with_dossier; keep or drop postings with update_postings. " +
          "To draft an application, write it yourself: call get_profile and get_posting, write a tailored resume and cover letter from facts in the profile only " +
          "(never invent experience, employers, numbers or degrees; say what's missing instead), show the user a short summary, then save it with save_application. " +
          "Or let Dossier's AI draft it with draft_application. Review and change documents with get_document and edit_document, rewrite them with rewrite_document, and get PDFs with export_pdf. " +
          "Change the profile only with what the user told you or confirmed. " +
          "Work that takes a while answers with a task_id: follow it with check_task. " +
          "start_apply fills in the employer's application form in a browser window on the user's computer; the user checks it and presses Send there, then settle_apply records it. " +
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
        "Searches the job source set up in Dossier's settings, or the sources given, together, and keeps the search in Find jobs → Past searches. Each search uses one search from the user's plan with each source. " +
        "Returns a search_id and numbered postings; pass both to get_posting, save_job_scores or save_application, or the search_id to more_jobs.",
      inputSchema: z.object({
        keywords: z.string().trim().min(1).max(200).describe("Job title, skill or company, e.g. 'product designer'"),
        place: z.string().max(200).optional().describe("City or region. Defaults to the profile's city. Use '' for the whole country."),
        country: z.string().max(60).optional().describe("Country name or ISO code, e.g. 'Germany' or 'de'. Defaults to the profile's country."),
        remote_only: z.boolean().optional().describe("Only remote postings."),
        radius_km: z.literal(RADII_KM).optional(),
        posted_within: z.enum(POSTED).optional().describe("any, day, 3days, week or month. Defaults to month."),
        sources: z
          .array(z.enum(SOURCE_NAMES))
          .min(1)
          .optional()
          .describe("Which sources to search, together, with the same job listed once: jsearch, serpapi, adzuna, arbeitsagentur. Defaults to the one chosen in Settings. A source that can't answer is reported, and a ready one stands in for it."),
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
      };
      const ran = await runSearch(query, input.sources?.map((name) => name.toUpperCase() as JobSource));
      if (!ran.ok) return failure(ran.message);
      const search = await loadSearch(ran.id);
      if (!search) return failure("The search ran, but couldn't be read back. Try again.");
      return text({
        search_id: search.id,
        searched: `${query.keywords} in ${query.place || countryName(country)}${query.remoteOnly ? " (remote only)" : ""}`,
        sources: search.sources.map((source) => source.toLowerCase()),
        problems: search.problems.length > 0 ? search.problems.map(describeSourceProblem) : undefined,
        found: search.postings.length,
        more_available: search.more,
        postings: search.postings.map((posting, index) => postingLine(posting, index + 1)),
        link: linkTo(`/jobs?search=${search.id}`),
      });
    },
  );

  server.registerTool(
    "more_jobs",
    {
      title: "Show more jobs",
      description: "The next page of a search from search_jobs. Uses one more search from the user's plan.",
      inputSchema: z.object({ search_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ search_id }) => {
      const before = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { found: true } });
      if (!before) return failure("That search is no longer kept. Search again.");
      const more = await showMoreFor(search_id);
      if (!more.ok) return failure(more.message);
      return text({
        search_id,
        added: more.postings.length,
        more_available: more.more,
        problems: more.problems.length > 0 ? more.problems.map(describeSourceProblem) : undefined,
        postings: more.postings.map((posting, index) => postingLine(posting, before.found + index + 1)),
      });
    },
  );

  server.registerTool(
    "save_job_scores",
    {
      title: "Save fit scores for postings",
      description:
        "Saves how well postings fit the user (from a search_jobs search by number, or handed over by posting_id), so Find jobs shows each score with its reasons. " +
        "Read the profile first, and the whole posting with get_posting when the snippet is too short to judge. " +
        "Score each from 0 to 100 against the profile from get_profile: 85-100 excellent (clearly meets the core requirements), 70-84 good (most core requirements, a gap or two), 50-69 possible (meaningful gaps or a stretch), 0-49 poor. " +
        "Judge skills and experience, seniority and scope, location, remote work and language, and salary when both say something. " +
        "Give one to four short reasons, each tying a requirement to a specific role, project, skill or degree, and up to three real red flags. " +
        "Never invent experience, and never use age, gender, nationality or any other protected characteristic.",
      inputSchema: z.object({
        search_id: z.string().max(100).optional().describe("The search the numbered postings are from"),
        scores: z
          .array(
            z.object({
              number: z.number().int().min(1).optional().describe("The posting's number in the search"),
              posting_id: z.string().max(100).optional().describe("Instead of a number: a posting Dossier handed over"),
              score: z.number().int().min(0).max(100),
              reasons: z.array(z.string().max(300)).min(1).max(4),
              red_flags: z.array(z.string().max(300)).max(3).default([]),
            }),
          )
          .min(1)
          .max(50),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ search_id, scores }) => {
      const search = search_id ? await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { postings: true } }) : null;
      if (search_id && !search) return failure("That search is no longer kept. Search again.");
      const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
      const saved: { number?: number; posting_id?: string; title: string; score: number; band: string }[] = [];
      const missing: (number | string)[] = [];
      for (const entry of scores) {
        const row = entry.posting_id ? await prisma.posting.findUnique({ where: { id: entry.posting_id } }) : null;
        const posting = row ? foundFromPosting(row) : entry.number ? kept[entry.number - 1] : undefined;
        if (!posting) {
          missing.push(entry.posting_id ?? entry.number ?? "?");
          continue;
        }
        const fit = scoreFrom({ score: entry.score, reasons: entry.reasons, redFlags: entry.red_flags });
        await saveScore(posting, fit, WRITTEN_IN_CLAUDE);
        saved.push({ number: entry.number, posting_id: entry.posting_id, title: posting.title, score: fit.score, band: fitBand(fit.score) });
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
      description: "One application with its posting, how the profile matches it, and the tailored resume and cover letter as text. Private notes and contact details are left out.",
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
          documents: { select: { kind: true, units: true } },
        },
      });
      if (!application) return failure("That application no longer exists.");
      const doc = (kind: DocumentKind) => documentText(application.documents.find((document) => document.kind === kind)?.units);
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
        "Only use facts from the profile. Nothing is sent.",
      inputSchema: z.object({
        ...postingSource,
        details: writtenDetailsSchema,
        resume: writtenResumeSchema,
        cover_letter: writtenLetterSchema,
        match: writtenMatchSchema.describe("What the posting asks for and whether the profile covers it, partly covers it, or has a gap; Dossier shows it as the application's match"),
        note: z.string().max(2000).optional().describe("What the user asked to stress, kept with the application"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ details, resume, cover_letter, match, note, ...source }) => {
      const posting = await resolvePosting(source);
      if ("error" in posting) return failure(posting.error);
      const saved = await saveWrittenApplication({
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
    "draft_application",
    {
      title: "Have Dossier draft an application",
      description:
        "Has Dossier's own AI model draft the application, only when an AI provider is set up in Dossier's settings. " +
        "Without one, write it yourself with get_profile, get_posting and save_application. Takes one to three minutes: follow it with check_draft.",
      inputSchema: z.object({ ...postingSource, note: z.string().max(2000).optional().describe("Anything the documents should stress, in the user's words") }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ note, ...source }) => {
      if (!(await isAiUsable())) {
        return failure("Dossier has no AI model of its own set up. Write the application yourself: get_profile, get_posting, then save_application.");
      }
      const posting = await resolvePosting(source);
      if ("error" in posting) return failure(posting.error);
      const jobId = await startJob(connectorDraftJob, { posting: posting.text.slice(0, 100_000), postingUrl: posting.url.slice(0, 2000), note: note ?? "", postingId: posting.postingId });
      return text({ draft_id: jobId, status: "started", next: "Call check_draft with this draft_id in a minute or so." });
    },
  );

  server.registerTool(
    "check_draft",
    {
      title: "Check a draft",
      description: "How a draft from draft_application is coming along; once done, the new application's id and link.",
      inputSchema: z.object({ draft_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ draft_id }) => {
      const job = await getJob(draft_id);
      if (!job || job.type !== connectorDraftJob.type) return failure("There's no such draft.");
      if (job.status === "FAILED") return failure(job.error ?? "The draft couldn't be written.");
      if (job.status !== "DONE") return text({ draft_id, status: "working", step: job.step ?? "Starting", next: "Check again in a little while." });
      const result = connectorDraftJob.result.safeParse(job.result);
      if (!result.success) return failure("The draft finished, but its application couldn't be found.");
      return text({ draft_id, status: "done", application_id: result.data.applicationId, link: linkTo(`/applications/${result.data.applicationId}`) });
    },
  );

  server.registerTool(
    "set_application_status",
    {
      title: "Move an application",
      description: "Changes an application's status, e.g. to SENT once the user has applied, or INTERVIEW. It only records the change; nothing is sent.",
      inputSchema: z.object({ id: z.string().min(1).max(100), status: z.enum(ApplicationStatus) }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ id, status }) => {
      // A job agent draft waiting for review is approved first, as moving it on the Agent screen does.
      if (status !== ApplicationStatus.DRAFT) {
        const pending = await prisma.agentCandidate.findFirst({ where: { applicationId: id, application: { awaitingReview: true } }, select: { id: true } });
        if (pending) await approveCandidate(pending.id);
      }
      const result = await applyStatusChange(prisma, id, status);
      if (result.outcome === "not-found") return failure("That application no longer exists.");
      return text({ id, status: statusInfo(status).label, changed: result.outcome !== "unchanged" });
    },
  );

  const context: ToolContext = { server, linkTo, clientName };
  registerProfileTools(context);
  registerDocumentTools(context);
  registerApplicationTools(context);
  registerApplyTools(context);
  registerPostingTools(context);
  registerTaskTools(context);
  registerAgentTools(context);
  registerInboxTools(context);
  registerSettingsTools(context);

  return server;
}
