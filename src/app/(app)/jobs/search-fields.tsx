"use client";

import Link from "next/link";

import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { controlClassName, FieldShell, useField } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import type { Country } from "@/lib/job-search/countries";
import { JOB_SOURCES, POSTED_WITHIN, RADII_KM, type JobSource, type RadiusKm, type SearchQuery, type SourceState } from "@/lib/job-search/search";
import { SOURCE_INFO, sourceCovers } from "@/lib/job-search/sources";

// A search's fields, as Find jobs asks them (E14-6) and Settings → Job agent
// saves its search (E16-7).

export type SearchFieldErrors = { keywords?: string; country?: string };

/** The sources as a list, however they're given. */
const listOf = (sources: JobSource | readonly JobSource[] | null): readonly JobSource[] => (sources === null ? [] : typeof sources === "string" ? [sources] : sources);

/** "JSearch and SerpApi", "JSearch, SerpApi and Adzuna". */
const named = (sources: readonly JobSource[]) => {
  const names = sources.map((source) => SOURCE_INFO[source].name);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};

/**
 * Why none of `sources` can search the country, in words, or undefined:
 * when one of several covers it, that one searches, and the others say so
 * beside the results.
 */
export function uncoveredCountry(sources: JobSource | readonly JobSource[] | null, query: SearchQuery, countries: readonly Country[]): string | undefined {
  const list = listOf(sources);
  if (list.length === 0 || !query.country) return undefined;
  const missing = list.filter((source) => !sourceCovers(source, query.country));
  if (missing.length < list.length) return undefined;
  const name = countries.find((country) => country.code === query.country)?.name ?? query.country.toUpperCase();
  return `${named(missing)} ${missing.length === 1 ? "doesn't" : "don't"} list jobs in ${name}.`;
}

/** "Uses 1 search each from JSearch and SerpApi": what a search spends of the ticked sources' plans; nothing for a source without one. */
export function searchCost(sources: readonly JobSource[]): string {
  const metered = sources.filter((source) => SOURCE_INFO[source].quotaPeriod !== null);
  if (metered.length === 0) return sources.length > 0 ? "No search quota used" : "";
  return `Uses 1 search ${metered.length === 1 ? "from" : "each from"} ${named(metered)}`;
}

/** What, Where, Country, Within and Posted, for a grid; Remote only is RemoteOnlyField, Source is SourcePicker. */
export function SearchFields({
  value,
  onChange,
  source,
  countries,
  errors = {},
  onBlur,
}: {
  value: SearchQuery;
  onChange: (patch: Partial<SearchQuery>) => void;
  /** The source, or sources, the search goes to, for what they don't cover. */
  source: JobSource | readonly JobSource[] | null;
  countries: readonly Country[];
  errors?: SearchFieldErrors;
  /** For text fields that save once typing is done. */
  onBlur?: () => void;
}) {
  const uncovered = uncoveredCountry(source, value, countries);
  return (
    <>
      <Input
        label="What"
        className="sm:col-span-2 lg:col-span-1"
        value={value.keywords}
        placeholder="Job title, skill or company"
        error={errors.keywords}
        onChange={(event) => onChange({ keywords: event.target.value })}
        onBlur={onBlur}
      />
      <Input label="Where" value={value.place} placeholder="City or region" onChange={(event) => onChange({ place: event.target.value })} onBlur={onBlur} />
      <Select label="Country" value={value.country} error={errors.country ?? uncovered} onChange={(event) => onChange({ country: event.target.value })}>
        <option value="">Choose a country</option>
        {countries.map((country) => (
          <option key={country.code} value={country.code}>
            {country.name}
          </option>
        ))}
      </Select>
      <Select
        label="Within"
        value={String(value.radiusKm)}
        disabled={!value.place.trim()}
        hint={value.place.trim() ? undefined : "Add a place first"}
        onChange={(event) => onChange({ radiusKm: Number(event.target.value) as RadiusKm })}
      >
        {RADII_KM.map((km) => (
          <option key={km} value={km}>
            {km} km
          </option>
        ))}
      </Select>
      <Select label="Posted" value={value.postedWithin} onChange={(event) => onChange({ postedWithin: event.target.value as SearchQuery["postedWithin"] })}>
        {POSTED_WITHIN.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </>
  );
}

/**
 * Source: which of the server's sources a search goes to, one or several,
 * ticked in a menu that stays open for more. A source without its key, or
 * with its note not accepted, is listed but can't be ticked: it says why,
 * and where to fix it.
 */
export function SourcePicker({
  sources,
  selected,
  onChange,
  error,
}: {
  sources: readonly SourceState[];
  selected: readonly JobSource[];
  onChange: (selected: JobSource[]) => void;
  error?: string;
}) {
  const field = useField({ error });
  const toggle = (source: JobSource, on: boolean) => onChange(JOB_SOURCES.filter((candidate) => (candidate === source ? on : selected.includes(candidate))));
  return (
    <FieldShell {...field} label="Source" error={error}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" {...field.controlProps} className={cn(controlClassName, "flex cursor-pointer items-center justify-between gap-2 px-2.5 py-2.5 text-left")}>
            <span className="truncate">{selected.length > 0 ? selected.map((source) => SOURCE_INFO[source].name).join(" + ") : "Choose a source"}</span>
            <span aria-hidden className="text-xs text-muted">
              ▾
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[280px]">
          {sources.map(({ source, problem }) => (
            <DropdownMenuCheckboxItem
              key={source}
              checked={selected.includes(source)}
              disabled={problem !== null}
              onCheckedChange={(on) => toggle(source, on === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex flex-col">
                <span>{SOURCE_INFO[source].name}</span>
                {problem && <span className="text-xs text-muted">{problem}</span>}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings?section=jobs">Keys and sources in Settings → Job search</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </FieldShell>
  );
}

/** "Remote only", with what it means on Adzuna, which has no such filter. */
export function RemoteOnlyField({ value, onChange, source }: { value: SearchQuery; onChange: (patch: Partial<SearchQuery>) => void; source: JobSource | null }) {
  return (
    <Checkbox
      label="Remote only"
      checked={value.remoteOnly}
      onChange={(event) => onChange({ remoteOnly: event.target.checked })}
      hint={source === "ADZUNA" && value.remoteOnly ? "Adzuna has no remote filter, so this adds “remote” to your search." : undefined}
    />
  );
}
