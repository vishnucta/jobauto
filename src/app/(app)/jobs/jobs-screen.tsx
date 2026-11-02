"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { ArbeitsagenturNote } from "@/components/arbeitsagentur-note";
import { PageHeader } from "@/components/page-header";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { Country } from "@/lib/job-search/countries";
import {
  isJobSource,
  POSTING_SOURCES,
  searchHref,
  searchRunHref,
  viewHref,
  type JobSource,
  type JobsView,
  type PastSearchDay,
  type PostingOrigin,
  type SearchProblem as Problem,
  type SearchQuery,
  type ShownPosting,
  type SourceFilter,
  type SourceState,
  type StoredSearch,
} from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";

import { acceptArbeitsagenturNote, runJobSearch } from "./actions";
import { PastSearches } from "./past-searches";
import { PostingResults } from "./posting-results";
import { RemoteOnlyField, searchCost, SearchFields, SourcePicker, uncoveredCountry } from "./search-fields";

export type JobsScreenProps = {
  /** The source chosen in Settings; null while job search is off. */
  source: JobSource | null;
  /** Every source the server offers, with why one can't be searched now, for the form's Source list. */
  sources: SourceState[];
  /** The Bundesagentur für Arbeit is chosen, but its note isn't accepted yet: it isn't searched until then (#223). */
  arbeitsagenturNote?: boolean;
  /** Score opens a Claude chat, which scores through the connector (#221). */
  scoreInClaude?: boolean;
  /** Every country by name, named on the server. */
  countries: readonly Country[];
  /** The search, past searches, or the Saved or Dismissed postings. */
  view: JobsView;
  /** What the form starts from: the open search, else the last one, else the profile's. */
  query: SearchQuery;
  /** The kept search that's open (E14-10): the one in the URL, else the latest. */
  search: StoredSearch | null;
  /** The URL names a search that's no longer kept. */
  missingSearch?: boolean;
  /** The Saved or Dismissed postings, in those views. */
  kept?: ShownPosting[];
  /** Past searches by day, in that view. */
  history?: PastSearchDay[];
  /** Saved, Dismissed and Past searches narrowed to one source (?from=client); null shows every source. */
  from?: SourceFilter;
  /** How many searches, saved and dismissed postings there are, for the tabs. */
  counts: { searches: number; saved: number; dismissed: number };
  /** Now, from the server, so "3 days ago" reads the same on both sides. */
  today: string;
};

const SETTINGS_HREF = "/settings?section=jobs";

/** Find jobs (E14-6, E14-7, E14-10): the search form and a kept search's postings, past searches, or the postings kept from them. */
export function JobsScreen({
  source,
  sources,
  arbeitsagenturNote = false,
  scoreInClaude = false,
  countries,
  view,
  query,
  search,
  missingSearch = false,
  kept = [],
  history = [],
  from = null,
  counts,
  today,
}: JobsScreenProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A search that didn't work, with what was asked, for Try again.
  const [failed, setFailed] = useState<{ problem: Problem; query: SearchQuery; sources: JobSource[] } | null>(null);
  const header = (
    <>
      <PageHeader
        title="Find jobs"
        description={`Search ${source ? SOURCE_INFO[source].name : "job postings"} for postings near you, then start an application from the one you like.`}
      />
      <ViewTabs view={view} counts={counts} />
    </>
  );

  // What AI clients found stays apart from what the job source found: each list can be narrowed to one source.
  const fromSource = (origin: PostingOrigin) => from === null || origin === from;

  if (view === "history") {
    const days = history.map((day) => ({ ...day, searches: day.searches.filter((search) => search.sources.some(fromSource)) })).filter((day) => day.searches.length > 0);
    return (
      <>
        {header}
        <SourceFilter view={view} from={from} present={history.flatMap((day) => day.searches.flatMap((search) => search.sources))} />
        <PastSearches days={days} countries={countries} empty={from ? `No searches from ${filterName(from)}.` : undefined} />
      </>
    );
  }

  if (view !== "search") {
    return (
      <>
        {header}
        <SourceFilter view={view} from={from} present={kept.map((posting) => posting.source)} />
        <PostingResults
          key={`${view}:${from ?? ""}`}
          mode={view}
          postings={kept.filter((posting) => fromSource(posting.source))}
          today={today}
          scoreInClaude={scoreInClaude}
          empty={from ? `Nothing ${view} from ${filterName(from)}.` : undefined}
        />
      </>
    );
  }

  if (!source) {
    return (
      <>
        {header}
        <NoSource />
      </>
    );
  }

  // Each search is kept and gets its own history entry, so Back returns to it without asking the source again.
  const run = (next: SearchQuery, sources: JobSource[]) =>
    startTransition(async () => {
      const result = await runJobSearch({ query: next, sources });
      if (!result.ok) return void toast(result.error);
      if (!result.data.ok) return void setFailed({ problem: result.data, query: next, sources });
      setFailed(null);
      router.push(searchRunHref(result.data.id), { scroll: false });
    });
  // The sources the form starts with: the open search's, else the one chosen in Settings.
  const opened = search?.sources.filter(isJobSource) ?? [];
  const startSources = opened.length > 0 ? opened : [source];

  const acceptArbeitsagentur = async () => {
    const result = toastResult(await acceptArbeitsagenturNote({}));
    if (result.ok) {
      setFailed(null);
      router.refresh();
    }
    return result.ok;
  };

  return (
    <>
      {header}
      {arbeitsagenturNote && <ArbeitsagenturNote accepted={false} onAccept={acceptArbeitsagentur} className="mx-10 mb-5 max-w-[760px]" />}
      <SearchForm sources={sources} startSources={startSources} countries={countries} query={query} pending={pending} onSearch={run} />
      {/* Announces each new set of results; the list itself is replaced. */}
      <p role="status" className="sr-only">
        {pending ? "Searching…" : failed ? failed.problem.message : search ? `${search.postings.length} postings found.` : ""}
      </p>
      <div className={cn("flex flex-1 flex-col motion-safe:transition-opacity", pending && "opacity-60")} aria-busy={pending || undefined}>
        {failed ? (
          <SearchProblem problem={failed.problem.problem} message={failed.problem.message} onRetry={() => run(failed.query, failed.sources)} />
        ) : search ? (
          <PostingResults
            key={search.id}
            mode="search"
            search={search}
            today={today}
            scoreInClaude={scoreInClaude}
            onSearchAgain={() => run(search.query, startSources)}
            searching={pending}
          />
        ) : (
          <p className="px-10 pb-16 text-sm text-muted">
            {missingSearch
              ? "That search is no longer kept. Search again, or open one from Past searches."
              : "Search for a role, a skill or a company. Every search is kept with what it found, so you can come back to it without spending another search."}
          </p>
        )}
      </div>
    </>
  );
}

function SearchForm({
  sources,
  startSources,
  countries,
  query,
  pending,
  onSearch,
}: {
  sources: readonly SourceState[];
  startSources: readonly JobSource[];
  countries: readonly Country[];
  query: SearchQuery;
  pending: boolean;
  onSearch: (query: SearchQuery, sources: JobSource[]) => void;
}) {
  const [form, setForm] = useState(query);
  const [selected, setSelected] = useState<JobSource[]>([...startSources]);
  const [errors, setErrors] = useState<{ keywords?: string; country?: string; sources?: string }>({});
  // Back and forward change the URL's search; the form follows.
  const [shown, setShown] = useState(query);
  if (searchHref(query) !== searchHref(shown)) {
    setShown(query);
    setForm(query);
    setSelected([...startSources]);
    setErrors({});
  }

  const set = (patch: Partial<SearchQuery>) => setForm((current) => ({ ...current, ...patch }));
  const uncovered = uncoveredCountry(selected, form, countries);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const problems = {
      keywords: form.keywords.trim() ? undefined : "Type what you're looking for.",
      country: form.country ? uncovered : "Choose a country.",
      sources: selected.length > 0 ? undefined : "Choose at least one source.",
    };
    setErrors(problems);
    if (problems.keywords || problems.country || problems.sources) return;
    onSearch({ ...form, keywords: form.keywords.trim(), place: form.place.trim() }, selected);
  };

  return (
    <form
      role="search"
      aria-label="Search postings"
      noValidate
      onSubmit={submit}
      className="mx-10 mb-7 grid grid-cols-1 items-start gap-x-4 gap-y-4 rounded-panel border border-line-card bg-card p-6 sm:grid-cols-2 lg:grid-cols-[2fr_1.4fr_1.2fr_0.9fr_1fr_1.3fr]"
    >
      <SearchFields value={form} onChange={set} source={selected} countries={countries} errors={errors} />
      <SourcePicker sources={sources} selected={selected} onChange={setSelected} error={errors.sources} />
      <div className="flex flex-wrap items-center justify-between gap-4 sm:col-span-2 lg:col-span-6">
        <RemoteOnlyField value={form} onChange={set} source={selected.includes("ADZUNA") ? "ADZUNA" : null} />
        <span className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-muted">{searchCost(selected)}</span>
          <Button type="submit" aria-disabled={pending || undefined}>
            {pending ? "Searching…" : "Search"}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** A source as the From filter names it: "AI clients" for what Claude, Gemini… added, else the job source's name. */
const filterName = (source: PostingOrigin) => (source === "CLIENT" ? "AI clients" : SOURCE_INFO[source].name);

/**
 * Narrows Saved, Dismissed or Past searches to one source (?from=client,
 * ?from=jsearch…), so what AI clients found can be told from what the job
 * source found. Only shown once the list holds more than one source.
 */
function SourceFilter({ view, from, present }: { view: "history" | "saved" | "dismissed"; from: SourceFilter; present: readonly PostingOrigin[] }) {
  const router = useRouter();
  const sources = POSTING_SOURCES.filter((source) => present.includes(source) || source === from);
  if (sources.length < 2 && !from) return null;
  return (
    <div className="px-10 pb-5">
      <Select
        label="From"
        value={from ?? ""}
        onChange={(event) => router.push(viewHref(view, (event.target.value || null) as SourceFilter), { scroll: false })}
        className="w-full max-w-[300px]"
      >
        <option value="">All sources</option>
        {sources.map((source) => (
          <option key={source} value={source}>
            {source === "CLIENT" ? "AI clients (Claude, Gemini…)" : SOURCE_INFO[source].name}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Search, Past searches (E14-10), Saved and Dismissed (E14-7), with how many each holds. */
function ViewTabs({ view, counts }: { view: JobsView; counts: { searches: number; saved: number; dismissed: number } }) {
  const tabs = [
    // The latest search, as it was kept.
    { view: "search", label: "Search", href: "/jobs", count: null },
    { view: "history", label: "Past searches", href: viewHref("history"), count: counts.searches },
    { view: "saved", label: "Saved", href: viewHref("saved"), count: counts.saved },
    { view: "dismissed", label: "Dismissed", href: viewHref("dismissed"), count: counts.dismissed },
  ] as const;
  return (
    <nav aria-label="Find jobs views" className="flex flex-wrap gap-1.5 px-10 pb-[18px]">
      {tabs.map((tab) => (
        <Link
          key={tab.view}
          href={tab.href}
          aria-current={tab.view === view ? "page" : undefined}
          className={cn(
            "flex items-baseline gap-1.5 rounded-control border px-3 py-2 text-control",
            tab.view === view ? "border-primary bg-selected font-medium text-primary-text hover:text-primary-text" : "border-line-field bg-card text-ink hover:border-line-strong hover:bg-hover hover:text-ink",
          )}
        >
          {tab.label}
          {tab.count !== null && <span className="text-xs opacity-65">{tab.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Before a source is chosen: where to set one up. */
function NoSource() {
  return (
    <div className="mx-10 mb-16 flex max-w-[640px] flex-col items-start gap-3 rounded-panel border border-line-card bg-card px-7 py-7">
      <h2 className="font-serif text-section">Choose where to search</h2>
      <p className="text-sm text-muted">
        Find jobs searches one job source for you, such as JSearch (LinkedIn, Indeed and more) or Adzuna. Pick one in Settings. Until then,
        nothing is sent anywhere.
      </p>
      <Link href={SETTINGS_HREF} className={buttonClassName("primary", "md", "mt-1 hover:text-on-primary")}>
        Set up job search
      </Link>
    </div>
  );
}

/** A search that didn't work, and what to do about it. */
function SearchProblem({ problem, message, onRetry }: { problem: Problem["problem"]; message: string; onRetry: () => void }) {
  const toSettings = problem === "no-key" || problem === "key" || problem === "country" || problem === "changed" || problem === "off";
  return (
    <div role="alert" className="mx-10 mb-16 flex max-w-[640px] flex-col items-start gap-3 rounded-panel border border-line-card bg-card px-7 py-6">
      <p className="text-sm">{message}</p>
      {toSettings ? (
        <Link href={SETTINGS_HREF} className={buttonClassName("secondary", "sm")}>
          Open Settings → Job search
        </Link>
      ) : problem === "unavailable" ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
