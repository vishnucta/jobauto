import type { Page } from "playwright-core";

// The apply runs waiting on the user (Phase A), each with the page a timer
// watches for the confirmation. On globalThis so the dev server's hot
// reloads keep them.

type Watch = { page: Page; timer: ReturnType<typeof setInterval> };

const globalForWatch = globalThis as unknown as { applyWatches?: Map<string, Watch> };
const watches: Map<string, Watch> = (globalForWatch.applyWatches ??= new Map());

/** Starts tracking a run's watcher, replacing one it had. */
export function addWatch(attemptId: string, watch: Watch): void {
  stopWatching(attemptId);
  watches.set(attemptId, watch);
}

/** Stops watching a run's page; the page stays open. */
export function stopWatching(attemptId: string): void {
  const watch = watches.get(attemptId);
  if (!watch) return;
  clearInterval(watch.timer);
  watches.delete(attemptId);
}

/** Stops every watcher (Delete everything). */
export function stopWatchingAll(): void {
  for (const attemptId of [...watches.keys()]) stopWatching(attemptId);
}

/** Whether the server is still watching a run's page. */
export function isWatching(attemptId: string): boolean {
  return watches.has(attemptId);
}
