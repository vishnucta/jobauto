import { portalConfigSchema, type PortalConfig } from "./format";
import adzuna from "./built-in/adzuna.json";
import arbeitsagentur from "./built-in/arbeitsagentur.json";
import freehire from "./built-in/freehire.json";
import jsearch from "./built-in/jsearch.json";
import serpapi from "./built-in/serpapi.json";

// The portals that come with Dossier (E22-2, #388): JSearch, Adzuna, FreeHire
// and the Bundesagentur für Arbeit, as configs in the same format as any
// other portal, in the order Settings lists them. This is the snapshot a
// release bundles (`yarn portals-snapshot`); the public dossier-portals
// repository is their one source (E23-1, S4a), and newer versions reach
// installs through the catalog between releases. Their environment variables
// are mapped in code, in src/lib/job-search/config.ts, never in the configs.
//
// SerpApi (jobauto fork) is built in too, but not in the public repository,
// and `yarn portals-snapshot` leaves it be: what it needs can't be said in a
// config (it asks Google in the country's language and reads the ages it
// writes in it), so it runs on code of its own (src/lib/portals/adapters.ts),
// and its config says what Settings and Find work show. The fork's Jooble
// was removed: it answered a search in Hamburg with jobs in the US.

export const BUILT_IN_PORTALS: readonly PortalConfig[] = [jsearch, serpapi, adzuna, freehire, arbeitsagentur].map((config) => portalConfigSchema.parse(config));

const BY_ID = new Map(BUILT_IN_PORTALS.map((config) => [config.id, config]));

/** A built-in portal's config, or undefined for any other id. */
export function builtInPortal(id: string): PortalConfig | undefined {
  return BY_ID.get(id);
}
