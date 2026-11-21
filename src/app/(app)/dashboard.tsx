import Link from "next/link";
import type { ReactNode } from "react";

import { buttonClassName } from "@/components/ui/button";
import { DEFAULT_QUIET_DAYS, type DashboardFigures, type DashboardPeriod } from "@/lib/dashboard";
import { doToday, doTodaySummary } from "@/lib/do-today";
import type { DayPeriod } from "@/lib/greeting";
import type { SetupStep } from "@/lib/setup-checklist";
import type { TodayItem } from "@/lib/today";
import { SHOW_WORKING_FROM, type Insights } from "@/lib/insights";
import type { ScoringOffNotice } from "@/lib/scoring-off";
import type { WeeklyProgress } from "@/lib/weekly-target";

import { ActivityChart } from "./activity-chart";
import { DailyNote, type DailyNoteValue } from "./daily-note";
import { DoToday } from "./do-today";
import { FunnelChart } from "./funnel-chart";
import { Greeting } from "./greeting";
import { PeriodControl, PeriodProvider, PeriodScoped } from "./period-filter";
import { WeeklyTarget } from "./weekly-target";
import { WhatsWorking } from "./whats-working";
import { SetupCard } from "./setup-card";
import { ScoringOffNotice as ScoringOff } from "./scoring-off-notice";

const card = "flex flex-col rounded-panel border border-line-card bg-card";

/**
 * The dashboard (DSH-1 to DSH-6, laid out as the UI refresh's 2a, E28-1): a
 * header with today's date, the greeting and what needs the user this week;
 * then Do today (jobauto fork: Needs you and Today's three in one list) and
 * Start here across the page; then two zones. On the left, "Your search so
 * far", which the period scopes: the funnel and week by week (Where things
 * stand, which repeated the sidebar's counts, is gone in the fork). On the
 * right, this week, which it doesn't: the weekly target (jobauto fork) and
 * the calendar, when there's one to show. Below about 1500px they stack, the
 * left zone first. What's working (jobauto fork) runs across both, below
 * them, once there are enough sent to say something.
 */
export function Dashboard({
  figures,
  firstName,
  period,
  today,
  range = "all",
  quietDays = DEFAULT_QUIET_DAYS,
  empty,
  calendar,
  note,
  week,
  working,
  todaysThree,
  setup,
  scoringOff = null,
}: {
  figures: DashboardFigures;
  firstName: string;
  period: DayPeriod;
  /** "Monday, 16 November", in the user's time zone. */
  today?: string;
  /** The time filter (E9-8). */
  range?: DashboardPeriod;
  /** Days without news before a follow-up is suggested (E9-9). */
  quietDays?: number;
  /** No applications at all yet. */
  empty: boolean;
  /** The calendar (E15-6), which the time filter doesn't scope; left out when there's nothing for it to show (jobauto fork). */
  calendar?: ReactNode;
  /** Today's note (E28-6): its text, null until it's written, "hidden" for today, or undefined for none. */
  note?: DailyNoteValue | "hidden";
  /** This week against the weekly target (jobauto fork); the time filter doesn't scope it either. */
  week?: WeeklyProgress;
  /** What's working (jobauto fork), from every sent application; left out until about 10 are sent. */
  working?: Insights;
  /** Today's three (today.ts), folded into Do today; missing in older callers. */
  todaysThree?: TodayItem[];
  /** Start here (setup-checklist.ts); missing in older callers. */
  setup?: SetupStep[];
  /** Scoring is off while a profile has no levels (scoring-off.ts, jobauto fork); null when it's on. */
  scoringOff?: ScoringOffNotice | null;
}) {
  const { sent, heardBack } = figures.overall;
  // Needs you and Today's three, each thing once (do-today.ts, jobauto fork).
  const rows = doToday(empty ? [] : figures.needsYou, todaysThree ?? []);
  return (
    <>
      <header className="-mx-px bg-paper pt-2">
        <div className="flex flex-col gap-1 rounded-t-panel border border-b-0 border-line-card bg-surface px-12 pt-7">
          {note !== undefined && note !== "hidden" && (
            <div className="pb-6">
              <DailyNote initial={note} />
            </div>
          )}
          {today && <p className="text-meta text-muted">{today}</p>}
          <h1 className="font-serif text-title text-pretty">
            <Greeting name={firstName} serverPeriod={period} />
          </h1>
          <p className="pt-1 text-lead text-pretty text-muted">
            {sent > 0 ? `${sent} sent, ${heardBack} heard back. ` : "Nothing sent yet. "}
            <strong className="font-medium text-ink">{doTodaySummary(rows, { empty })}</strong>
          </p>
        </div>
      </header>

      <div className="@container px-12 pt-7 pb-[72px]">
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 @min-[1500px]:grid-cols-[minmax(0,1fr)_580px]">
          {/* Scoring is off (jobauto fork): first, across both zones, until the levels are chosen. */}
          {scoringOff && <ScoringOff off={scoringOff} className="col-span-full" />}
          {/* What to do today, and the ways in not used yet (jobauto fork): first, across both zones. Before the first application, only when something waits. */}
          {(rows.length > 0 || !empty) && <DoToday rows={rows} quietDays={quietDays} />}
          {setup && <SetupCard steps={setup} />}
          {empty ? (
            <Welcome />
          ) : (
            <PeriodProvider period={range}>
              <section aria-labelledby="search-heading" className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="search-heading" className="text-meta text-muted">
                    Your search so far
                  </h2>
                  <PeriodControl aria-label="Period" />
                </div>
                <PeriodScoped className="flex flex-col gap-5">
                  <Funnel figures={figures} />
                  <ActivityChart weeks={figures.weeks} />
                </PeriodScoped>
              </section>
            </PeriodProvider>
          )}
          {(week || calendar) && (
            <section aria-labelledby="week-heading" className="@container/week flex min-w-0 flex-col gap-3">
              <h2 id="week-heading" className="flex min-h-[30px] items-center text-meta text-muted">
                This week · not affected by the period
              </h2>
              {/* One above the other in the 580px column; side by side when the zones stack and there's room. */}
              <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 @min-[900px]/week:grid-cols-2">
                {/* The one place the weekly target is set; Start here's step links to it (jobauto fork). */}
                {week && <WeeklyTarget progress={week} />}
                {calendar}
              </div>
            </section>
          )}
          {/* Every sent application counts here, whatever the period, so it sits below both zones, across them; with fewer than about 10 sent it can't say anything yet (jobauto fork). */}
          {!empty && working && working.sent >= SHOW_WORKING_FROM && <WhatsWorking insights={working} />}
        </div>
      </div>
    </>
  );
}

/** "Your funnel" (DSH-2): how far every sent application got, closed ones included, as a Sankey diagram. */
function Funnel({ figures }: { figures: DashboardFigures }) {
  const { funnel, sent, heardBackPercent, reachedInterview } = figures;
  const offers = funnel.find((step) => step.stage === "OFFER")?.count ?? 0;
  return (
    <section aria-labelledby="funnel-heading" className={`${card} gap-6 p-7`}>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="funnel-heading" className="font-serif text-section">
            Your funnel
          </h2>
          <p className="text-control text-muted">How far each application you&apos;ve sent has made it, and where the ones that stopped are now.</p>
        </div>
        <dl className="flex gap-7">
          <Figure value={String(sent)} label="sent" />
          <Figure value={heardBackPercent === null ? "None yet" : `${heardBackPercent}%`} label="heard back" />
          <Figure value={String(reachedInterview)} label="reached interview" />
          <Figure value={String(offers)} label="offers" />
        </dl>
      </div>
      <FunnelChart funnel={funnel} />
    </section>
  );
}

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-0.5">
      <dt className="text-label text-muted">{label}</dt>
      <dd className="font-serif text-[32px] leading-none tabular-nums">{value}</dd>
    </div>
  );
}

/** Before the first application: where to begin. */
function Welcome() {
  return (
    <Panel>
      <h2 className="font-serif text-section">Welcome to Dossier</h2>
      <p className="text-sm text-muted">
        Start with your profile: your roles, skills and education are what every tailored resume and cover letter is built from.
        Then paste a job posting, and your funnel and next steps will show up here.
      </p>
      <div className="flex flex-wrap items-center gap-4 pt-1">
        <Link href="/profile" className={buttonClassName("secondary")}>
          Fill in your profile
        </Link>
        <Link href="/new?fresh=1" className={buttonClassName("primary", "md", "hover:text-on-primary")}>
          + New application
        </Link>
        <Link href="/welcome" className="text-sm text-muted underline underline-offset-2 hover:text-ink">
          Open the setup guide
        </Link>
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return <div className={`${card} items-start gap-3 p-7`}>{children}</div>;
}
