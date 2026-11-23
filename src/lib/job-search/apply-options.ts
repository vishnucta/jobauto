import { bestApplyLink } from "@/lib/apply/link-owner";

import { linkKey, MAX_APPLY_OPTIONS, safeLink, type ApplyOption, type FoundPosting } from "./search";

// Every place a portal lists to apply at (jobauto fork, "Keep every apply
// option"): Google Jobs, through JSearch and SerpApi, lists a posting on the
// employer's site, its job system, boards, agencies and sites that copy ads,
// and a portal keeps one link. That one is now the best of them
// (link-owner.ts: the employer's own first, a copy of the ad last), and the
// rest are kept with the posting, to show and to choose from. Only what the
// search returned is used: nothing is asked of any portal for this.

/** Each link once (by linkKey), only web addresses, names trimmed, at most MAX_APPLY_OPTIONS. */
export function cleanOptions(options: readonly { name?: string | null; url?: string | null }[]): ApplyOption[] {
  const seen = new Set<string>();
  const kept: ApplyOption[] = [];
  for (const option of options) {
    const url = safeLink(option.url).slice(0, 2000);
    const key = linkKey(url);
    if (!url || !key || seen.has(key)) continue;
    seen.add(key);
    kept.push({ name: (option.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100), url });
    if (kept.length === MAX_APPLY_OPTIONS) break;
  }
  return kept;
}

/**
 * A posting as a portal found it, with the places it lists to apply at: its
 * link becomes the best of them and its own (bestApplyLink), the portal's own
 * staying on a tie, and all of them are kept, its own among them. A portal
 * that lists none leaves the posting as it was.
 */
export function withApplyOptions(posting: FoundPosting, listed: readonly { name?: string | null; url?: string | null }[]): FoundPosting {
  const given = cleanOptions(listed);
  // Its own link first, named as the list names it (not "via", which is where the portal found the posting).
  const own = posting.url ? [{ name: given.find((option) => linkKey(option.url) === linkKey(posting.url))?.name ?? "", url: posting.url }] : [];
  const options = cleanOptions([...own, ...given]);
  if (options.length <= own.length) return posting;
  return { ...posting, url: bestApplyLink(options, posting.company) || posting.url, applyOptions: options };
}

/**
 * What a posting kept before and one found again give together: the link it
 * has stays (a posting's link never changes once kept, so nothing that
 * matches it by link loses it), and the places to apply at are both lists,
 * its link first. Undefined when neither has any.
 */
export function mergedOptions(kept: { url: string; applyOptions?: readonly ApplyOption[] | null }, found: { applyOptions?: readonly ApplyOption[] }): ApplyOption[] | undefined {
  if (!kept.applyOptions?.length && !found.applyOptions?.length) return undefined;
  const options = cleanOptions([...(kept.url ? [{ name: "", url: kept.url }] : []), ...(kept.applyOptions ?? []), ...(found.applyOptions ?? [])]);
  // The link's own name, from either list, rather than the empty one put first.
  const named = [...(kept.applyOptions ?? []), ...(found.applyOptions ?? [])];
  return options.map((option) => (option.name ? option : { ...option, name: named.find((other) => linkKey(other.url) === linkKey(option.url))?.name ?? "" }));
}

/** Every link a posting is known by: its own and each place to apply at, as linkKey has them, without empty ones. */
export function linkKeysOf(posting: { url: string; applyOptions?: readonly ApplyOption[] | null }): string[] {
  return [...new Set([posting.url, ...(posting.applyOptions ?? []).map((option) => option.url)].map(linkKey).filter(Boolean))];
}

/** The places to apply at other than the posting's own link, in the portal's order. */
export const otherOptions = (posting: { url: string; applyOptions?: readonly ApplyOption[] | null }): ApplyOption[] =>
  (posting.applyOptions ?? []).filter((option) => linkKey(option.url) !== linkKey(posting.url));

/** The stored column as options, or undefined when it holds none or doesn't read. */
export function optionsFromColumn(value: unknown): ApplyOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = cleanOptions(value.filter((entry): entry is { name?: string; url?: string } => typeof entry === "object" && entry !== null));
  return options.length > 0 ? options : undefined;
}
