"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/cn";
import { defaultSearch, searchHref } from "@/lib/job-search/search";
import { searchWords } from "@/lib/job-search/suggestions";
import type { ProfileData } from "@/lib/profile";

type Language = "all" | "en" | "de";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
];

/**
 * Search words for Find jobs, from the profile: click one to copy it, or
 * follow the arrow to Find jobs with it filled in (nothing is searched until
 * Search is pressed there). They are worked out from the profile as it is
 * now, so they change as it does.
 */
export function SearchWordsPanel({ profile }: { profile: Pick<ProfileData, "basics" | "skills" | "experience"> }) {
  const headingId = useId();
  const [language, setLanguage] = useState<Language>("all");
  const [senior, setSenior] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const { groups, german, seniorYears } = useMemo(() => searchWords(profile, new Date(), { senior }), [profile, senior]);

  const shown = groups
    .map((group) => ({ ...group, words: group.words.filter((word) => language === "all" || word.language === language) }))
    .filter((group) => group.words.length > 0);
  const place = profile.basics.city.trim();
  const where = [place, profile.basics.country.trim()].filter(Boolean).join(", ");

  const copy = async (text: string, announce = `Copied “${text}”. Paste it into What on Find jobs.`) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((current) => (current === text ? null : current)), 1400);
      toast(announce);
    } catch {
      toast("Couldn't copy. Select the word and copy it.");
    }
  };
  const copyAll = () => {
    const words = shown.flatMap((group) => group.words.map((word) => word.text));
    void copy(words.join("\n"), `Copied ${words.length} words, one per line.`);
  };
  const href = (word: string) => searchHref(defaultSearch({ role: word, city: place, country: profile.basics.country }));

  return (
    <aside aria-labelledby={headingId} className="sticky top-20 flex max-w-[300px] min-w-[260px] flex-[1_1_260px] flex-col gap-4 rounded-panel border border-line-card bg-card p-4">
      <div className="flex flex-col gap-0.5">
        <h2 id={headingId} className="font-serif text-lead">
          Search words
        </h2>
        <p className="text-meta text-muted">
          For Find jobs{where ? `, ${where}` : ""}. Short on purpose: a long phrase finds nothing, a short one finds hundreds.
        </p>
      </div>

      {german && (
        <div role="group" aria-label="Language of the postings" className="inline-flex self-start overflow-hidden rounded-control border border-line-field">
          {LANGUAGES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={language === option.value}
              onClick={() => setLanguage(option.value)}
              className={cn("px-3 py-1 text-control", language === option.value ? "bg-primary text-on-primary" : "bg-card text-ink hover:bg-hover")}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-muted">Add a role, a headline or skills, and search words appear here.</p>
      ) : (
        shown.map((group) => (
          <section key={group.title} aria-label={group.title} className="flex flex-col gap-2">
            <h3 className="text-label font-semibold tracking-wide text-muted uppercase">{group.title}</h3>
            <ul className="flex flex-wrap gap-1.5">
              {group.words.map((word) => (
                <li key={word.text} className={cn("inline-flex items-center overflow-hidden rounded-full border", copied === word.text ? "border-success bg-success text-white" : "border-line-field bg-paper hover:border-ink")}>
                  <button type="button" title={word.why} onClick={() => void copy(word.text)} className="py-[3px] pr-1 pl-3 text-control">
                    {word.text}
                  </button>
                  <Link href={href(word.text)} aria-label={`Search Find jobs for ${word.text}`} title="Open Find jobs with this filled in" className="py-[3px] pr-2.5 pl-1 text-xs text-muted hover:text-ink">
                    ↗
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {seniorYears !== null && (
        <Checkbox
          label={`Add “Senior” to my latest title`}
          checked={senior}
          onChange={(event) => setSenior(event.target.checked)}
          hint={`Your roles add up to about ${seniorYears} years. Your profile doesn't say “Senior”: this is a guess from the years.`}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={copyAll} aria-disabled={shown.length === 0 || undefined}>
          Copy all
        </Button>
        <span className="sr-only" role="status">
          {copied ? `Copied ${copied}` : ""}
        </span>
      </div>
      <p className="border-t border-line pt-3 text-meta text-muted">Search one word at a time, with your place. Words update when you change your profile.</p>
    </aside>
  );
}
