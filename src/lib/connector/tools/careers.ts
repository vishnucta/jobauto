import "server-only";

import { z } from "zod";

import { BOARD_NAMES, type BoardKind } from "@/lib/careers/boards";
import { startCareersCheck } from "@/lib/careers/check";
import { createEmployer, employerFields, listEmployers, removeEmployer, setEmployerEnabled, updateEmployer, type EmployerView } from "@/lib/careers/store";

import { failure, started, text, type ToolContext } from "../kit";

// Careers pages, under Find jobs (jobauto fork): the employers whose own
// careers pages are checked each morning, as the Careers pages tab lists
// them, and Check now. New jobs go into Find jobs as a search from the
// careers source, which list_postings reads.

const GONE = "That employer is no longer followed.";
const id = z.string().min(1).max(64);

function employerLine(employer: EmployerView) {
  return {
    id: employer.id,
    name: employer.name,
    careers_page: employer.careersUrl,
    job_system: BOARD_NAMES[employer.ats as BoardKind] ?? employer.ats,
    words: employer.keywords || undefined,
    places: employer.places || undefined,
    checked_each_morning: employer.enabled,
    last_checked: employer.lastCheckedAt ?? undefined,
    last_matching: employer.lastCheckedAt ? employer.lastMatched : undefined,
    last_new: employer.lastCheckedAt ? employer.lastNew : undefined,
    problem: employer.problem ?? undefined,
  };
}

const fieldsInput = {
  careers_page: z.string().min(1).max(2000).describe("The page that lists the employer's jobs, e.g. https://acme.jobs.personio.de or https://acme.wd3.myworkdayjobs.com/Careers"),
  name: z.string().max(120).optional().describe("The employer's name; read from the address when left out"),
  words: z.string().max(500).optional().describe("Comma-separated words one of which a job's title must hold, e.g. 'Reporting, Meldewesen'; empty keeps every job"),
  places: z.string().max(300).optional().describe("Comma-separated places one of which a job's place must name, e.g. 'Hamburg, Remote'; empty keeps every place"),
};

export function registerCareersTools({ server, linkTo }: ToolContext): void {
  const link = linkTo("/careers");

  server.registerTool(
    "list_careers_pages",
    {
      title: "List careers pages followed",
      description:
        "The employers whose own careers pages Dossier checks each morning (Find jobs → Careers pages), with the words and places each keeps and what the last check found. " +
        "New jobs from them are in list_postings with source careers.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const employers = await listEmployers();
      return text({ total: employers.length, employers: employers.map(employerLine), link });
    },
  );

  server.registerTool(
    "follow_careers_page",
    {
      title: "Follow a careers page",
      description:
        "Adds an employer to Find jobs → Careers pages, as Follow does: its careers page is read each morning, and new jobs that match its words and places go into Find jobs. " +
        "Dossier reads Personio, Greenhouse, Lever, SmartRecruiters, Recruitee, Ashby and Workday pages, and pages with job data (JSON-LD). Follow with check_careers_pages to read it now.",
      inputSchema: z.object(fieldsInput),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ careers_page, name, words, places }) => {
      const parsed = employerFields.safeParse({ careersUrl: careers_page, name, keywords: words, places });
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Those details can't be saved.");
      const employer = await createEmployer(parsed.data);
      return text({ employer: employerLine(employer), message: `Following ${employer.name}. check_careers_pages with its id reads it now.`, link });
    },
  );

  server.registerTool(
    "update_careers_page",
    {
      title: "Change a careers page followed",
      description: "Changes an employer on Careers pages: its page, name, words or places, or whether it's checked each morning. Fields left out stay as they are.",
      inputSchema: z.object({
        id,
        careers_page: fieldsInput.careers_page.optional(),
        name: fieldsInput.name,
        words: fieldsInput.words,
        places: fieldsInput.places,
        checked_each_morning: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ id: employerId, careers_page, name, words, places, checked_each_morning }) => {
      const current = (await listEmployers()).find((employer) => employer.id === employerId);
      if (!current) return failure(GONE);
      const parsed = employerFields.safeParse({ careersUrl: careers_page ?? current.careersUrl, name: name ?? current.name, keywords: words ?? current.keywords, places: places ?? current.places, notes: current.notes });
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Those details can't be saved.");
      let saved = await updateEmployer(employerId, parsed.data);
      if (saved && checked_each_morning !== undefined) saved = await setEmployerEnabled(employerId, checked_each_morning);
      if (!saved) return failure(GONE);
      return text({ employer: employerLine(saved), link });
    },
  );

  server.registerTool(
    "remove_careers_page",
    {
      title: "Stop following a careers page",
      description: "Stops checking an employer's careers page, as Stop following does. The jobs already found on it stay in Find jobs.",
      inputSchema: z.object({ id }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ id: employerId }) => {
      if (!(await removeEmployer(employerId))) return failure(GONE);
      return text({ removed: true, message: "No longer followed. The jobs found on its page stay in Find jobs.", link });
    },
  );

  server.registerTool(
    "check_careers_pages",
    {
      title: "Check careers pages now",
      description:
        "Reads the careers pages now, as Check now does: the given employers, or every one checked each morning. New matching jobs go into Find jobs as one search. " +
        "Answers with a task_id: follow it with check_task, whose result has the search_id of the jobs added.",
      inputSchema: z.object({ ids: z.array(id).max(200).optional().describe("Only these employers; without it, every one checked each morning") }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ ids }) => {
      const { jobId, reused } = await startCareersCheck(ids);
      return started(jobId, reused ? { note: "A check was already under way: this is that one." } : {});
    },
  );
}
