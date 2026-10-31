import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyDir, applyProfileDir, deleteAllApplyData, deleteApplyRuns } from "./files";
import { addWatch, isWatching, stopWatchingAll } from "./watches";

const { dataDir, closeApplyBrowser } = vi.hoisted(() => ({
  dataDir: { path: "" },
  closeApplyBrowser: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/lib/env", () => ({ env: { get DOSSIER_DATA_DIR() { return dataDir.path; } } }));
vi.mock("./browser", () => ({ closeApplyBrowser }));

async function put(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "x");
}

/** A watcher as the apply run starts one, on a page the test never touches. */
const watch = () => {
  const timer = setInterval(() => {}, 60_000);
  timer.unref();
  return { page: {} as Page, timer };
};

beforeEach(async () => {
  dataDir.path = await mkdtemp(path.join(tmpdir(), "dossier-apply-"));
  closeApplyBrowser.mockReset().mockResolvedValue(undefined);
  await put(path.join(applyDir("run-1"), "filled.png"));
  await put(path.join(applyDir("run-1"), "Lebenslauf.pdf"));
  await put(path.join(applyDir("run-2"), "filled.png"));
  await put(path.join(applyProfileDir(), "Default", "Cookies"));
  await put(path.join(dataDir.path, "backups", "dossier-backup-nightly.json"));
});
afterEach(async () => {
  stopWatchingAll();
  await rm(dataDir.path, { recursive: true, force: true });
});

describe("deleteApplyRuns (Phase A)", () => {
  it("removes only the given runs' folders, and stops watching their pages", async () => {
    addWatch("run-1", watch());
    addWatch("run-2", watch());
    await deleteApplyRuns(["run-1", "never-had-a-folder"]);
    expect(await readdir(path.join(dataDir.path, "apply"))).toEqual(["run-2"]);
    expect(isWatching("run-1")).toBe(false);
    expect(isWatching("run-2")).toBe(true);
    expect(await readdir(applyProfileDir())).toEqual(["Default"]);
    expect(closeApplyBrowser).not.toHaveBeenCalled();
  });

  it("does nothing for an application that never ran", async () => {
    await deleteApplyRuns([]);
    expect((await readdir(path.join(dataDir.path, "apply"))).sort()).toEqual(["run-1", "run-2"]);
  });
});

describe("deleteAllApplyData (Phase A)", () => {
  it("closes the browser window first, then removes every run and the profile with its sign-ins, and nothing else", async () => {
    addWatch("run-2", watch());
    closeApplyBrowser.mockImplementation(async () => {
      // The window closes before its profile goes.
      expect(await readdir(applyProfileDir())).toEqual(["Default"]);
    });
    await deleteAllApplyData();
    expect(closeApplyBrowser).toHaveBeenCalledOnce();
    expect(await readdir(dataDir.path)).toEqual(["backups"]);
    expect(isWatching("run-2")).toBe(false);
  });

  it("is fine when there's nothing to delete", async () => {
    await rm(path.join(dataDir.path, "apply"), { recursive: true });
    await rm(applyProfileDir(), { recursive: true });
    await expect(deleteAllApplyData()).resolves.toBeUndefined();
    expect(await readdir(dataDir.path)).toEqual(["backups"]);
  });
});
