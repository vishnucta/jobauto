import "server-only";

import type { ProfilePhoto } from "@/lib/photo";
import type { EducationItem, ExperienceItem, ProjectItem, PublicationItem, ReferenceItem } from "@/lib/profile";

// What the connector's remove_profile_entry took out, kept so it can put it
// back (jobauto fork). The screen's Undo keeps a removed entry in the
// browser; the connector keeps it in the server's memory, so a reference's
// email and phone never reach Claude. For an hour at most, and only on the
// connection it was removed on: Disconnect Claude, turning the connector off
// and on, and Delete everything (which turns it off) start a new one. On
// globalThis, so the dev server's hot reloads keep it; it's gone when Dossier
// restarts.

/** How long a removed entry can be put back. */
export const KEEP_REMOVED_MS = 60 * 60_000;
/** The most removals kept; the oldest go first. */
const MAX_KEPT = 50;

/** A removed entry, with its place in its section. */
export type Removed = { title: string; position: number } & (
  | { kind: "experience"; entry: ExperienceItem }
  | { kind: "project"; entry: ProjectItem }
  | { kind: "education"; entry: EducationItem }
  | { kind: "publication"; entry: PublicationItem }
  | { kind: "reference"; entry: ReferenceItem }
  | { kind: "photo"; entry: ProfilePhoto }
);

/** A removal, with when and on which connection (connectorEnabledAt) it was made. */
type Kept = { removed: Removed; removedAt: number; connection: string | null };

const globalForRemoved = globalThis as unknown as { connectorRemovedEntries?: Map<string, Kept> };
const kept: Map<string, Kept> = (globalForRemoved.connectorRemovedEntries ??= new Map());

/** Drops the removals past their hour, and those made on an earlier connection. */
function dropStale(connection: string | null, now: number): void {
  for (const [key, removal] of kept) {
    if (now - removal.removedAt >= KEEP_REMOVED_MS || removal.connection !== connection) kept.delete(key);
  }
}

/** Keeps what was removed under `key`, e.g. "reference:<id>", in place of an earlier one there. */
export function keepRemoved(key: string, removed: Removed, connection: string | null, now = Date.now()): void {
  dropStale(connection, now);
  kept.delete(key);
  kept.set(key, { removed, removedAt: now, connection });
  for (const oldest of kept.keys()) {
    if (kept.size <= MAX_KEPT) break;
    kept.delete(oldest);
  }
}

/** What was removed under `key` within the hour, on this connection; null when there's nothing. */
export function keptRemoved(key: string, connection: string | null, now = Date.now()): Removed | null {
  dropStale(connection, now);
  return kept.get(key)?.removed ?? null;
}

/** Forgets one removal, e.g. once it's back. */
export function forgetRemoved(key: string): void {
  kept.delete(key);
}

/** Forgets every removal, for when all the data is deleted or replaced. */
export function forgetRemovedProfileEntries(): void {
  kept.clear();
}
