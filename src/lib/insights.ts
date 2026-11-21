import type { ApplicationStatus, FunnelStage } from "@/generated/prisma/enums";

// What's working (jobauto fork): how often sent applications got an answer
// that moved them on, split by where the job was found, agency or employer,
// the documents' language, the resume's theme, and the German the posting
// asked for. Every couple of weeks it shows where the effort pays, so the
// next applications go there.

/** A sent application, with what it's grouped by. */
export type SentApplication = {
  status: ApplicationStatus;
  furthestStage: FunnelStage | null;
  /** "Job agent", "JSearch", "Careers pages", "By hand"… */
  foundVia: string;
  agency: boolean;
  /** The documents' language, e.g. "German"; "" when not set. */
  language: string;
  /** The resume's theme name; "" when it has none. */
  theme: string;
  /** Whether the posting's German was within reach (german-need.ts); null without a posting text. */
  german: "fits" | "stretch" | "out" | null;
};

export type InsightRow = {
  label: string;
  sent: number;
  /** Moved on to Screening or further. */
  replies: number;
  /** Rejected without getting further than Sent. */
  rejections: number;
  /** Replies as a percent of sent, rounded. */
  rate: number;
};

export type InsightGroup = { id: string; title: string; rows: InsightRow[] };

export type Insights = {
  sent: number;
  replies: number;
  /** Too few sent applications to tell groups apart. */
  early: boolean;
  /** Only groupings with at least two kinds in them. */
  groups: InsightGroup[];
};

/** About this many sent applications before the differences mean much. */
export const ENOUGH_SENT = 20;

/** The dashboard shows What's working from this many sent (jobauto fork): before that it can't say anything yet. */
export const SHOW_WORKING_FROM = 10;

/** The stages that mean an answer that moved it on. */
export const MOVED_ON: ReadonlySet<FunnelStage> = new Set<FunnelStage>(["SCREENING", "INTERVIEW", "OFFER", "ACCEPTED"]);
const replied = (application: SentApplication) => application.furthestStage !== null && MOVED_ON.has(application.furthestStage);

const GERMAN_LABELS = { fits: "Within your German", stretch: "A stretch", out: "Needed more German" } as const;

const GROUPINGS: { id: string; title: string; label: (application: SentApplication) => string }[] = [
  { id: "found", title: "Where you found it", label: (application) => application.foundVia },
  { id: "agency", title: "Through an agency or straight to the employer", label: (application) => (application.agency ? "Through an agency" : "Straight to the employer") },
  { id: "language", title: "Language of your documents", label: (application) => application.language || "Not set" },
  { id: "german", title: "German the posting asked for", label: (application) => (application.german ? GERMAN_LABELS[application.german] : "No posting text") },
  { id: "theme", title: "Resume theme", label: (application) => application.theme || "Base theme" },
];

export function insights(applications: readonly SentApplication[]): Insights {
  const groups = GROUPINGS.map(({ id, title, label }) => {
    const rows = new Map<string, InsightRow>();
    for (const application of applications) {
      const key = label(application);
      const row = rows.get(key) ?? { label: key, sent: 0, replies: 0, rejections: 0, rate: 0 };
      row.sent += 1;
      if (replied(application)) row.replies += 1;
      else if (application.status === "REJECTED") row.rejections += 1;
      rows.set(key, row);
    }
    return {
      id,
      title,
      rows: [...rows.values()].map((row) => ({ ...row, rate: Math.round((row.replies / row.sent) * 100) })).sort((a, b) => b.sent - a.sent || a.label.localeCompare(b.label)),
    };
  }).filter((group) => group.rows.length > 1);
  return { sent: applications.length, replies: applications.filter(replied).length, early: applications.length < ENOUGH_SENT, groups };
}

/** The group with the best reply rate among those sent at least three times, for a sentence; null when none stands out. */
export function bestRow(group: InsightGroup): InsightRow | null {
  const sized = group.rows.filter((row) => row.sent >= 3);
  if (sized.length < 2) return null;
  const [best, next] = sized.toSorted((a, b) => b.rate - a.rate);
  return best.rate > next.rate ? best : null;
}
