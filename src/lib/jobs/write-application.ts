import "server-only";

import { createApplicationFromDocuments, type ApplicationClaim, type ApplicationDetails } from "@/lib/application-create";
import type { Extracted } from "@/lib/application-data";
import { prisma } from "@/lib/prisma";
import type { DocumentsToWrite } from "@/lib/settings";
import { loadSettings } from "@/lib/settings-data";

import { readPostingJob } from "./read-posting";
import type { JobContext } from "./runner";
import { writeDocumentsJob } from "./write-documents";

// One way of writing an application from a posting in the background
// (jobauto fork): read it, write the documents with Settings' tone, and
// create the application under its claim. The agent's drafts (Agent screen,
// Today's three) and Prepare it for me on Find jobs both come here.

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
  { posting, postingUrl, name, write, claim }: {
    /** The posting's whole text, as postingText() gives it. */
    posting: string;
    postingUrl: string;
    /** Who it's for, in the steps shown while it's written. */
    name: string;
    write?: DocumentsToWrite;
    claim: ApplicationClaim;
  },
  context: JobContext,
): Promise<string> {
  await context.step(`Reading the posting from ${name}`);
  const reading = await readPostingJob.run({ posting }, context);
  await context.step(`Writing the draft for ${name}`);
  const settings = await loadSettings();
  const documents = await writeDocumentsJob.run(
    { readJobId: context.id, posting, extracted: reading.extracted, match: reading.match, tone: settings.defaultTone, note: "", write: write ?? settings.documentsToWrite },
    context,
  );
  const applicationId = await createApplicationFromDocuments({
    reading: { posting, ...reading },
    documents,
    match: reading.match,
    details: detailsFrom(reading.extracted),
    postingUrl,
    tone: settings.defaultTone,
    note: "",
    claim,
  });
  // The job holds nothing of the application, but goes with it all the same.
  await prisma.job.updateMany({ where: { id: context.id }, data: { applicationId } });
  return applicationId;
}
