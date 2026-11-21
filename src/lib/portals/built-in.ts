import { portalConfigSchema, type PortalConfig } from "./format";
import adzuna from "./built-in/adzuna.json";
import arbeitsagentur from "./built-in/arbeitsagentur.json";
import freehire from "./built-in/freehire.json";
import jooble from "./built-in/jooble.json";
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
// SerpApi and Jooble (jobauto fork) are built in too, but not in the public
// repository, and `yarn portals-snapshot` leaves them be: what they need
// can't be said in a config (SerpApi asks Google in the country's language
// and reads the ages it writes in it; Jooble is asked by POST, with the key
// in the path), so they run on code of their own (src/lib/portals/adapters.ts),
// and their configs say what Settings and Find work show.

export const BUILT_IN_PORTALS: readonly PortalConfig[] = [jsearch, serpapi, adzuna, jooble, freehire, arbeitsagentur].map((config) => portalConfigSchema.parse(config));

const BY_ID = new Map(BUILT_IN_PORTALS.map((config) => [config.id, config]));

/** A built-in portal's config, or undefined for any other id. */
export function builtInPortal(id: string): PortalConfig | undefined {
  return BY_ID.get(id);
}
