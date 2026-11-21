"use client";

import Link from "next/link";
import { useId, useMemo } from "react";

import { buttonClassName } from "@/components/ui/button";
import { searchWords } from "@/lib/job-search/suggestions";
import type { ProfileData } from "@/lib/profile";

/** Where the search words are kept (jobauto fork): Positions, with Edit search open. */
export const SEARCH_WORDS_HREF = "/jobs?edit=1";

/**
 * Search words (jobauto fork): how many the profile shown gives, and a link
 * to them. They're shown in one place, Positions' Edit search, where one
 * click fills in What; this panel no longer keeps a second list. They are
 * worked out from the profile as it is now, so they change as it does.
 */
export function SearchWordsPanel({ profile }: { profile: Pick<ProfileData, "basics" | "skills" | "experience"> }) {
  const headingId = useId();
  const { groups, german } = useMemo(() => searchWords(profile, new Date()), [profile]);
  const count = groups.reduce((sum, group) => sum + group.words.length, 0);

  return (
    <aside aria-labelledby={headingId} className="sticky top-20 flex max-w-[300px] min-w-[260px] flex-[1_1_260px] flex-col gap-3 rounded-panel border border-line-card bg-card p-4">
      <h2 id={headingId} className="font-serif text-lead">
        Search words
      </h2>
      {count === 0 ? (
        <p className="text-sm text-muted">Add a role, a headline or skills, and search words appear in Positions, under Edit search.</p>
      ) : (
        <>
          <p className="text-meta text-pretty text-muted">
            {count} short {count === 1 ? "word" : "words"} from this profile{german ? ", in English and German," : ""} to search Positions with: job titles, specialties and
            skills. They&apos;re kept in one place, Positions&apos; Edit search, where one click fills in What.
          </p>
          <Link href={SEARCH_WORDS_HREF} className={buttonClassName("secondary", "sm", "self-start")}>
            See them in Positions <span aria-hidden="true">→</span>
          </Link>
        </>
      )}
    </aside>
  );
}
