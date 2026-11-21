import type { ApplicationStatus } from "@/generated/prisma/enums";

// The supporter digest (jobauto fork): once a week, a short summary of her
// search for the person who supports it, on their phone: what went out,
// what moved on, the interviews coming, the follow-ups due, and where help
// matters most this week. A search is a long haul; seeing it is half of
// helping with it.

export type DigestApplication = {
  company: string;
  role: string;
  status: ApplicationStatus;
  sentAt: Date | null;
  nextInterviewAt: Date | null;
  /** When it last moved, or was made: for "no news for a while". */
  lastChange: Date;
  /** Status changes, with when. */
  moves: { to: ApplicationStatus; at: Date }[];
};

const WEEK = 7 * 86_400_000;
const MOVED_ON: ReadonlySet<ApplicationStatus> = new Set(["SCREENING", "INTERVIEW", "OFFER", "ACCEPTED"]);
const OPEN: ReadonlySet<ApplicationStatus> = new Set(["SENT", "SCREENING", "INTERVIEW", "OFFER"]);

const name = (application: Pick<DigestApplication, "company" | "role">) => [application.role, application.company].filter(Boolean).join(" at ") || "an application";
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export type Digest = { title: string; message: string };

/** The week's digest, as of `now`, in the supporter's time zone for the days it names. */
export function supporterDigest(
  applications: readonly DigestApplication[],
  { target, quietDays, now, timeZone }: { target: number; quietDays: number; now: Date; timeZone: string },
): Digest {
  const since = now.getTime() - WEEK;
  const day = (date: Date) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone }).format(date);

  const sent = applications.filter((application) => application.sentAt && application.sentAt.getTime() >= since);
  const movedOn = applications.filter((application) => application.moves.some((move) => MOVED_ON.has(move.to) && move.at.getTime() >= since));
  const interviews = applications
    .filter((application) => application.nextInterviewAt && application.nextInterviewAt.getTime() >= now.getTime() && application.nextInterviewAt.getTime() < now.getTime() + WEEK)
    .sort((a, b) => a.nextInterviewAt!.getTime() - b.nextInterviewAt!.getTime());
  const quiet = applications.filter((application) => application.status === "SENT" && now.getTime() - application.lastChange.getTime() >= quietDays * 86_400_000);
  const open = applications.filter((application) => OPEN.has(application.status));

  const lines = [
    `Sent this week: ${sent.length}${target > 0 ? ` of ${target}` : ""}.`,
    movedOn.length > 0 ? `Moved on: ${movedOn.map(name).join("; ")}.` : "No new answers that moved one on this week.",
    ...interviews.map((application) => `Interview: ${name(application)}, ${day(application.nextInterviewAt!)}.`),
    quiet.length > 0 ? `${plural(quiet.length, "application has", "applications have")} had no news for ${quietDays}+ days: worth a follow-up.` : "",
    `Open: ${plural(open.length, "application", "applications")} in progress.`,
  ];

  // Where help matters most, in order: a call coming, then the week's target, then the quiet ones.
  const help = interviews[0]
    ? `How you can help: practise the call for ${name(interviews[0])} with her before ${day(interviews[0].nextInterviewAt!)}. Its Call prep tab has the questions and her answers.`
    : target > 0 && sent.length < target
      ? `How you can help: an evening together to send ${plural(target - sent.length, "more application", "more applications")}.`
      : quiet.length > 0
        ? "How you can help: go through the quiet ones with her and send the follow-ups."
        : "How you can help: tell her the week went well.";

  return {
    title: interviews.length > 0 ? `Her week: ${plural(interviews.length, "interview", "interviews")} coming` : `Her week: ${sent.length} sent, ${movedOn.length} moved on`,
    message: [...lines.filter(Boolean), "", help].join("\n"),
  };
}

/** Whether the week's digest is due: on its weekday, from its hour, once that day. */
export function digestDue(now: Date, timeZone: string, { weekday, hour, sentOn }: { weekday: number; hour: number; sentOn: string | null }): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(now).map((part) => [part.type, part.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return day === weekday && Number(parts.hour) >= hour && sentOn !== today;
}
