"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { FitDetails } from "@/components/fit-details";
import { GermanBadge, GermanNote } from "@/components/german-badge";
import { ScoreBadge } from "@/components/score-badge";
import { linksAttribution, SourceAttribution } from "@/components/source-attribution";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { useJob } from "@/hooks/use-job";
import { openPendingTab, sendPendingTab } from "@/lib/claude-tab";
import { cn } from "@/lib/cn";
import type { PostingFit } from "@/lib/fit";
import { germanFit, textForGerman, type GermanFit, type ProfileGerman } from "@/lib/german-need";
import type { JobView } from "@/lib/jobs/runner";
import { byScore, postedAgo, postingKey, type FoundPosting, type PostingState, type ShownPosting, type StoredSearch } from "@/lib/job-search/search";
import { arbeitsagenturPage, describeSourceProblem, searchesWithin, searchSourcesName, SOURCE_INFO } from "@/lib/job-search/sources";

import { dismissFoundPosting, loadFullText, restorePosting, savePostingForLater, showMorePostings, startScoringPosting, unsavePosting } from "./actions";
import { useStartApplication } from "./use-start-application";

/** Narrow windows show the posting above the list. */
const NARROW = "(max-width: 1023px)";

export type PostingResultsProps = {
  today: string;
  /** Score opens a Claude chat, which scores through the connector: it's on, and Dossier has no AI model of its own (#221). */
  scoreInClaude?: boolean;
  /** The profile's German, which each posting's is read against; postings that need far more are hidden until shown. */
  german?: ProfileGerman;
} & (
  | {
      mode: "search";
      /** The kept search (E14-10). */
      search: StoredSearch;
      /** Runs the same search anew, as a new kept search. */
      onSearchAgain: () => void;
      searching: boolean;
    }
  | {
      /** Saved or Dismissed postings (E14-7), or every posting past searches found, sorted by score to start with. */
      mode: "saved" | "dismissed" | "found";
      postings: ShownPosting[];
      /** Replaces the message shown when there are none, e.g. when the list is narrowed to one source. */
      empty?: string;
    }
);

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Found by an AI client" on a posting Claude, Gemini… added itself, so Saved shows it apart from the job source's. */
const foundBy = (posting: FoundPosting) => (posting.source === "CLIENT" ? "Found by an AI client" : "");

/** "Also on SerpApi": the other sources a search of several found the same job on. */
const alsoOn = (posting: FoundPosting) => (posting.alsoOn?.length ? `Also on ${posting.alsoOn.map((source) => SOURCE_INFO[source].name).join(" and ")}` : "");

/**
 * Postings in a list, and the selected one's whole text beside it, or above
 * it on narrow windows: what a kept search found (E14-6, E14-10), with
 * dismissed ones left out unless shown, or the Saved or Dismissed postings
 * (E14-7), which leave the list when they're no longer saved or dismissed,
 * or every posting past searches found. Sort by score puts the best fits
 * first, unscored ones after.
 */
export function PostingResults(props: PostingResultsProps) {
  const { mode } = props;
  const [postings, setPostings] = useState(mode === "search" ? props.search.postings : props.postings);
  const [more, setMore] = useState(mode === "search" ? props.search.more : false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [sorted, setSorted] = useState(mode === "found");
  const [showOut, setShowOut] = useState(false);
  const german = props.german ?? "NONE";
  // What German each posting asks for, by postingKey: read from its text, no AI.
  const germanFits = useMemo(() => new Map(postings.map((posting) => [postingKey(posting), germanFit(textForGerman(posting), german)])), [postings, german]);
  // Search results hide what needs far more German than the profile has; Saved and Dismissed are the user's own choices.
  const gates = mode === "search" || mode === "found";
  const outOfReach = (posting: ShownPosting) => gates && germanFits.get(postingKey(posting))?.verdict === "out";
  const inView = (posting: ShownPosting) => {
    const { state } = posting;
    if (mode === "saved") return state.saved;
    if (mode === "dismissed") return state.dismissed;
    return (showDismissed || !state.dismissed) && (showOut || !outOfReach(posting) || state.saved || Boolean(state.applicationId));
  };
  const visible = (sorted ? byScore(postings) : postings).filter(inView);
  const hidden = gates ? postings.filter((posting) => posting.state.dismissed).length : 0;
  const tooMuchGerman = gates ? postings.filter((posting) => !posting.state.dismissed && !posting.state.saved && !posting.state.applicationId && outOfReach(posting)).length : 0;
  const [selectedKey, setSelectedKey] = useState(visible[0] ? postingKey(visible[0]) : null);
  const selected = visible.find((posting) => postingKey(posting) === selectedKey) ?? visible[0] ?? null;
  const detail = useRef<HTMLElement>(null);
  const now = new Date(props.today);
  const { starting, start } = useStartApplication();
  // Postings being scored (#208), with the step under way, by postingKey.
  const [scoring, setScoring] = useState<Record<string, { jobId: string; step: string | null }>>({});

  const updateState = (key: string, change: Partial<PostingState>) =>
    setPostings((list) => list.map((posting) => (postingKey(posting) === key ? { ...posting, state: { ...posting.state, ...change } } : posting)));

  const select = (key: string, { reveal = false } = {}) => {
    setSelectedKey(key);
    if (reveal && window.matchMedia?.(NARROW).matches) detail.current?.scrollIntoView({ block: "start" });
  };

  /** Changes a posting's state; when that takes it out of the list, the next one takes its place. */
  const change = (posting: ShownPosting, state: Partial<PostingState>) => {
    const key = postingKey(posting);
    const index = visible.findIndex((entry) => postingKey(entry) === key);
    const after = visible[index + 1] ?? visible[index - 1];
    updateState(key, state);
    if (!inView({ ...posting, state: { ...posting.state, ...state } }) && after) setSelectedKey(postingKey(after));
  };

  const save = async (posting: ShownPosting) => {
    const result = toastResult(await savePostingForLater({ posting: withoutState(posting) }));
    if (!result.ok) return;
    change(posting, { saved: true, dismissed: false, postingId: result.data.postingId });
    setSelectedKey(postingKey(posting));
  };

  const unsave = async (posting: ShownPosting) => {
    const result = await unsavePosting({ source: posting.source, externalId: posting.externalId });
    if (!result.ok) return void toast(result.error);
    change(posting, { saved: false });
    // In Saved, the posting leaves the list: Undo puts it back.
    if (mode === "saved") toast("Removed from Saved.", { action: { label: "Undo", onClick: () => void save(posting) } });
    else toastResult(result);
  };

  const restore = async (posting: ShownPosting, saved: boolean) => {
    const result = toastResult(await restorePosting({ source: posting.source, externalId: posting.externalId, saved }));
    if (!result.ok) return;
    change(posting, { dismissed: false, saved });
    if (mode === "dismissed") toast("Brought back. It'll show in your searches again.");
  };

  const dismiss = async (posting: ShownPosting) => {
    const result = await dismissFoundPosting({ posting: withoutState(posting) });
    if (!result.ok) return void toast(result.error);
    change(posting, { dismissed: true, saved: false });
    toast("Dismissed. It won't show in your searches.", {
      action: {
        label: "Undo",
        onClick: () => {
          void restore(posting, result.data.wasSaved);
          setSelectedKey(postingKey(posting));
        },
      },
    });
  };

  const score = async (posting: ShownPosting) => {
    const key = postingKey(posting);
    if (scoring[key]) return;
    setScoring((current) => ({ ...current, [key]: { jobId: "", step: null } }));
    // Opened now, while the click still counts: a tab opened after waiting is blocked as a pop-up (#221).
    const chat = props.scoreInClaude ? openPendingTab() : null;
    const result = toastResult(await startScoringPosting({ posting: withoutState(posting) }));
    if (result.ok && "handoff" in result.data) {
      sendPendingTab(chat, result.data.handoff);
      setScoring((current) => without(current, key));
      toast("Scoring it in Claude. Reload this page once Claude has saved the score.");
      return;
    }
    chat?.close();
    setScoring((current) => (result.ok && "jobId" in result.data ? { ...current, [key]: { jobId: result.data.jobId, step: null } } : without(current, key)));
  };

  const scoringChanged = (key: string, job: JobView<PostingFit>) => {
    if (job.status === "DONE" || job.status === "FAILED") {
      setScoring((current) => without(current, key));
      if (job.status === "DONE" && job.result) updateState(key, { score: job.result });
      else toast(job.error ?? "The posting couldn't be scored. Try again.");
      return;
    }
    setScoring((current) => (current[key] ? { ...current, [key]: { ...current[key], step: job.step } } : current));
  };

  const showMore = async () => {
    if (props.mode !== "search" || !more || loadingMore) return;
    setLoadingMore(true);
    const result = await showMorePostings({ searchId: props.search.id });
    setLoadingMore(false);
    if (!result.ok) return void toast(result.error);
    if (!result.data.ok) return void toast(result.data.message);
    const seen = new Set(postings.map(postingKey));
    setPostings([...postings, ...result.data.postings.filter((posting) => !seen.has(postingKey(posting)))]);
    setMore(result.data.more);
    for (const problem of result.data.problems) toast(describeSourceProblem(problem));
  };

  const searched = props.mode === "search" ? props.search.query : null;
  const radius = props.mode === "search" && searchesWithin(props.search.sources);
  const empty =
    props.mode !== "search" && props.empty
      ? props.empty
      : mode === "saved"
        ? "Nothing saved yet. Save a posting from your search results to keep it here."
        : mode === "dismissed"
          ? "Nothing dismissed. Postings you dismiss stay out of your searches and wait here."
          : postings.length > 0
            ? "You've dismissed every posting here."
            : !searched
              ? "Your past searches found no postings yet."
              : radius
                ? `No postings for “${searched.keywords}”${searched.place ? ` within ${searched.radiusKm} km of ${searched.place}` : ""}. Try a bigger radius or fewer words.`
                : `No postings for “${searched.keywords}”${searched.place ? ` in ${searched.place}` : ""}. Try fewer words.`;

  return (
    <div className="flex flex-wrap items-start gap-6 px-10 pb-16">
      {Object.entries(scoring).map(([key, { jobId }]) =>
        jobId ? <ScoreWatcher key={jobId} jobId={jobId} onChange={(job) => scoringChanged(key, job)} /> : null,
      )}
      <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
        {props.mode === "search" && props.search.problems.length > 0 && (
          <div role="note" className="flex flex-col gap-1 rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
            {props.search.problems.map((problem) => (
              <p key={problem.source}>{describeSourceProblem(problem)}</p>
            ))}
            {props.search.problems.some((problem) => problem.problem === "no-key" || problem.problem === "key" || problem.problem === "not-accepted") && (
              <Link href="/settings?section=jobs" className="self-start font-medium underline underline-offset-2">
                Settings → Job search
              </Link>
            )}
          </div>
        )}
        <p className={cn("flex flex-wrap items-baseline gap-x-3 gap-y-1 text-meta text-muted", (mode === "saved" || mode === "dismissed") && visible.length === 0 && "hidden")}>
          <span>
            {props.mode === "search"
              ? `${plural(postings.length, "posting", "postings")} from ${searchSourcesName(props.search.sources, props.search.addedBy)}${more ? ", more to come" : ""} · ${props.search.sources.includes("CLIENT") ? "added" : "searched"} ${props.search.ranAt}`
              : mode === "found"
                ? `${plural(postings.length, "posting", "postings")} from your past searches, each job once · ${plural(postings.filter((posting) => posting.state.score).length, "scored", "scored")}`
                : mode === "saved"
                  ? plural(visible.length, "saved posting", "saved postings")
                  : `${plural(visible.length, "dismissed posting", "dismissed postings")}, kept out of your searches`}
          </span>
          {postings.some((posting) => posting.state.score) && (
            <button
              type="button"
              aria-pressed={sorted}
              onClick={() => setSorted(!sorted)}
              className="underline-offset-3 hover:text-ink aria-pressed:text-ink aria-pressed:underline"
            >
              Sort by score
            </button>
          )}
          {props.mode === "search" && (
            <button
              type="button"
              onClick={props.searching ? undefined : props.onSearchAgain}
              aria-disabled={props.searching || undefined}
              className="underline underline-offset-3 hover:text-ink aria-disabled:text-faint"
            >
              Search again
            </button>
          )}
          {tooMuchGerman > 0 && (
            <button
              type="button"
              aria-pressed={showOut}
              onClick={() => setShowOut(!showOut)}
              title="Read from each posting's text: the German it asks for against the German in your profile."
              className="underline-offset-3 hover:text-ink aria-pressed:text-ink aria-pressed:underline"
            >
              {tooMuchGerman === 1 ? "1 needs more German than you have" : `${tooMuchGerman} need more German than you have`} · {showOut ? "Hide" : "Show"}
            </button>
          )}
          {hidden > 0 && (
            <button
              type="button"
              aria-pressed={showDismissed}
              onClick={() => setShowDismissed(!showDismissed)}
              className="underline-offset-3 hover:text-ink aria-pressed:text-ink aria-pressed:underline"
            >
              {hidden === 1 ? "1 dismissed posting hidden" : `${hidden} dismissed postings hidden`} · {showDismissed ? "Hide" : "Show"}
            </button>
          )}
        </p>

        {visible.length === 0 ? (
          <div className="rounded-panel border border-line-card bg-card px-5 py-9 text-center text-sm text-muted">{empty}</div>
        ) : (
          <PostingList
            postings={visible}
            selectedKey={selected ? postingKey(selected) : null}
            now={now}
            onSelect={select}
            germanFits={germanFits}
            scoring={scoring}
            onScore={(posting) => void score(posting)}
          />
        )}

        {more && (
          <Button variant="secondary" className="self-start" onClick={() => void showMore()} aria-disabled={loadingMore || undefined}>
            {loadingMore ? "Loading more…" : "Show more"}
          </Button>
        )}
      </div>

      {selected && (
        <PostingDetail
          key={postingKey(selected)}
          ref={detail}
          posting={selected}
          german={german}
          now={now}
          onSave={() => void save(selected)}
          onUnsave={() => void unsave(selected)}
          onDismiss={() => void dismiss(selected)}
          onRestore={() => void restore(selected, false)}
          scoring={scoring[postingKey(selected)] ?? null}
          onScore={() => void score(selected)}
        >
          {!selected.state.dismissed && (
            <StartButton starting={starting === postingKey(selected)} onClick={() => void start(withoutState(selected), postingKey(selected))} />
          )}
        </PostingDetail>
      )}
    </div>
  );
}

/** A copy of `record` without `key`. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Follows a posting's scoring job (#208). */
function ScoreWatcher({ jobId, onChange }: { jobId: string; onChange: (job: JobView<PostingFit>) => void }) {
  useJob<PostingFit>(jobId, 0, onChange);
  return null;
}

/** "Start application →" on a posting (E14-8). */
export function StartButton({ starting, onClick }: { starting: boolean; onClick: () => void }) {
  return (
    <Button size="sm" aria-disabled={starting || undefined} onClick={starting ? undefined : onClick}>
      {starting ? "Starting…" : "Start application →"}
    </Button>
  );
}

/** The posting as the server takes it back: without where it stands. */
function withoutState(posting: ShownPosting): FoundPosting {
  const { state, ...found } = posting;
  void state;
  return found;
}

/** The Score pill on an unscored posting in the list, and the room the card keeps for it. */
const pill = "inline-flex h-6 items-center rounded-full border px-2 text-xs";

function PostingList({
  postings,
  selectedKey,
  now,
  onSelect,
  germanFits,
  scoring,
  onScore,
}: {
  postings: ShownPosting[];
  selectedKey: string | null;
  now: Date;
  onSelect: (key: string, options?: { reveal?: boolean }) => void;
  /** What German each posting asks for, by postingKey. */
  germanFits: Map<string, GermanFit>;
  /** Postings being scored, by postingKey. */
  scoring: Record<string, unknown>;
  onScore: (posting: ShownPosting) => void;
}) {
  // Up and down move through the list, as in a mail inbox.
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-posting]")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const target = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    event.preventDefault();
    target.focus();
    onSelect(target.dataset.posting!);
  };

  return (
    <ul aria-label="Postings" className="flex flex-col gap-2" onKeyDown={move}>
      {postings.map((posting) => {
        const key = postingKey(posting);
        const current = key === selectedKey;
        const title = posting.title || "Untitled posting";
        const pillLabel = scoring[key] ? "Scoring…" : "Score";
        return (
          <li key={key} className={cn("group relative", posting.state.dismissed && "opacity-60")}>
            <button
              type="button"
              data-posting={key}
              aria-pressed={current}
              onClick={() => onSelect(key, { reveal: true })}
              className={cn(
                "flex w-full flex-col gap-1 rounded-card border bg-card px-4 py-3.5 text-left group-hover:border-line-strong",
                current ? "border-primary bg-selected shadow-[0_0_0_1px_var(--color-primary)]" : "border-line-card",
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="text-field font-medium text-pretty">{title}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <GermanBadge fit={germanFits.get(key)} />
                  <StateBadges state={posting.state} />
                  {posting.state.score ? (
                    <ScoreBadge score={posting.state.score.score} size="sm" />
                  ) : (
                    <span aria-hidden className={cn(pill, "invisible")}>
                      {pillLabel}
                    </span>
                  )}
                </span>
              </span>
              <span className="text-meta text-muted">{[posting.company, posting.place, posting.remote ? "Remote" : ""].filter(Boolean).join(" · ")}</span>
              <span className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs text-muted">
                  {[postedAgo(posting.postedAt, now), posting.via && `via ${posting.via}`, foundBy(posting), alsoOn(posting), posting.salary].filter(Boolean).join(" · ")}
                </span>
                <SourceAttribution source={posting.source} url={posting.url} placeholder />
              </span>
            </button>
            {/* A button can't hold another, so the pill lies over the room the card keeps for it, with the card's border and padding. */}
            {!posting.state.score && (
              <span className="pointer-events-none absolute inset-0 flex items-start justify-end border border-transparent px-4 py-3.5">
                <button
                  type="button"
                  aria-label={`${pillLabel} “${title}”`}
                  aria-disabled={scoring[key] ? true : undefined}
                  onClick={scoring[key] ? undefined : () => onScore(posting)}
                  className={cn(
                    pill,
                    "pointer-events-auto border-dashed border-line-strong text-muted hover:border-muted hover:text-ink aria-disabled:cursor-default aria-disabled:hover:border-line-strong aria-disabled:hover:text-muted motion-safe:aria-disabled:animate-pulse",
                  )}
                >
                  {pillLabel}
                </button>
              </span>
            )}
            {/* Adzuna's label is a link, so it lies over room the card keeps too (E14-2). */}
            {linksAttribution(posting.source) && (
              <span className="pointer-events-none absolute inset-0 flex items-end justify-end border border-transparent px-4 py-3.5">
                <SourceAttribution source={posting.source} url={posting.url} className="pointer-events-auto" />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function StateBadges({ state }: { state: PostingState }) {
  const badges = [state.applicationId && "Applied", state.saved && "Saved", state.dismissed && "Dismissed"].filter(Boolean) as string[];
  if (badges.length === 0) return null;
  return (
    <span className="flex shrink-0 gap-1.5">
      {badges.map((badge) => (
        <span key={badge} className="rounded-full bg-track px-2 py-0.5 text-xs text-ink">
          {badge}
        </span>
      ))}
    </span>
  );
}


type Text = { status: "ready"; text: string } | { status: "loading" } | { status: "partial"; text: string };

/** The selected posting: its facts, what to do with it, and its whole text. */
function PostingDetail({
  ref,
  posting,
  german,
  now,
  onSave,
  onUnsave,
  onDismiss,
  onRestore,
  scoring,
  onScore,
  children,
}: {
  ref: Ref<HTMLElement>;
  posting: ShownPosting;
  german: ProfileGerman;
  now: Date;
  onSave: () => void;
  onUnsave: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  /** While it's being scored (#208): the step under way. */
  scoring: { step: string | null } | null;
  onScore: () => void;
  /** More actions, before Save (E14-8). */
  children?: ReactNode;
}) {
  const headingId = useId();
  const sourcePage = arbeitsagenturPage(posting);
  // The posting as first shown; the component is keyed by it.
  const [initial] = useState(posting);
  const [text, setText] = useState<Text>(initial.complete ? { status: "ready", text: initial.description } : { status: "loading" });

  // A source that only sent the start: ask for the rest (E14-2, E14-3).
  useEffect(() => {
    if (initial.complete) return;
    let current = true;
    void loadFullText({ posting: withoutState(initial) }).then((result) => {
      if (!current) return;
      const full = result.ok ? result.data.text : null;
      setText(full ? { status: "ready", text: full } : { status: "partial", text: initial.description });
    });
    return () => {
      current = false;
    };
  }, [initial]);

  const { state } = posting;
  const ago = postedAgo(posting.postedAt, now);
  // Read again from the whole text, once it's here.
  const fullGerman = germanFit(textForGerman({ title: posting.title, description: text.status === "loading" ? posting.description : text.text }), german);

  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      className="flex min-w-0 flex-[999_1_420px] scroll-mt-[121px] flex-col gap-4 rounded-panel border border-line-card bg-card p-7 max-lg:order-first max-lg:max-h-[75vh] lg:sticky lg:top-[121px] lg:max-h-[calc(100dvh-145px)]"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={headingId} className="font-serif text-section text-pretty">
          {posting.title || "Untitled posting"}
        </h2>
        <p className="text-sm text-muted">{[posting.company, posting.place, posting.remote ? "Remote" : "", posting.salary].filter(Boolean).join(" · ")}</p>
        {(ago || posting.via || foundBy(posting) || alsoOn(posting)) && (
          <p className="text-meta text-muted">{[ago && `Posted ${ago === "Today" || ago === "Yesterday" ? ago.toLowerCase() : ago}`, posting.via && `via ${posting.via}`, foundBy(posting), alsoOn(posting)].filter(Boolean).join(" · ")}</p>
        )}
      </div>

      {state.applicationId && (
        <p role="note" className="rounded-card bg-track px-4 py-3 text-meta">
          You&apos;ve applied for this.{" "}
          <Link href={`/applications/${state.applicationId}`} className="underline underline-offset-2">
            Open the application
          </Link>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {children}
        {state.dismissed ? (
          <Button variant="secondary" size="sm" onClick={onRestore}>
            Bring back
          </Button>
        ) : (
          <Button variant="secondary" size="sm" aria-pressed={state.saved} onClick={state.saved ? onUnsave : onSave}>
            {state.saved ? "Saved" : "Save"}
          </Button>
        )}
        {posting.url && (
          <a href={posting.url} target="_blank" rel="noopener noreferrer" className={buttonClassName("secondary", "sm")}>
            Open posting<span aria-hidden>↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        {/* A BA posting with a link of its own still links to its ad on arbeitsagentur.de (#223). */}
        {sourcePage && sourcePage !== posting.url && (
          <a href={sourcePage} target="_blank" rel="noopener noreferrer" className={buttonClassName("secondary", "sm")}>
            On arbeitsagentur.de<span aria-hidden>↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <Button variant="secondary" size="sm" aria-disabled={scoring ? true : undefined} onClick={scoring ? undefined : onScore}>
          {scoring ? "Scoring…" : state.score ? "Score again" : "Score"}
        </Button>
        {!state.dismissed && (
          <Button variant="secondary" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>

      <GermanNote fit={fullGerman} />

      {scoring ? (
        <p role="status" className="text-meta text-muted">
          {scoring.step ?? "Starting…"}
        </p>
      ) : (
        state.score && <FitDetails fit={state.score} />
      )}

      {/* Only the text scrolls, so the title and actions stay in view; focusable, so it scrolls from the keyboard too. */}
      <div tabIndex={0} role="region" aria-label="Posting text" className="-mx-1 min-h-0 flex-1 overflow-y-auto border-t border-line px-1 pt-4">
        {text.status === "loading" ? (
          <p role="status" className="text-sm text-muted">
            Getting the whole posting…
          </p>
        ) : (
          <>
            {text.status === "partial" && (
              <p className="mb-3 rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
                This is only the start of the posting. When you start an application, you can paste the rest from the posting&apos;s page.
              </p>
            )}
            <div className="text-sm leading-relaxed whitespace-pre-line">{text.text || "The source didn't send a description."}</div>
          </>
        )}
      </div>
      {/* As the source's terms ask (E14-2, E14-3). */}
      <SourceAttribution source={posting.source} url={posting.url} className="self-start" />
    </section>
  );
}
