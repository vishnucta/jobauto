import { beforeEach, describe, expect, it } from "vitest";

import { forgetRemoved, forgetRemovedProfileEntries, keepRemoved, KEEP_REMOVED_MS, keptRemoved, type Removed } from "./removed-entries";

const CONNECTION = "2026-10-23T09:00:00.000Z";
const photo: Removed = { kind: "photo", entry: { src: "data:image/png;base64,iVBORw0KGgo", onResumes: true }, position: 0, title: "The photo" };

beforeEach(() => forgetRemovedProfileEntries());

describe("removals kept for restore", () => {
  it("keeps a removal for an hour, then forgets it", () => {
    const now = Date.now();
    keepRemoved("photo", photo, CONNECTION, now);
    expect(keptRemoved("photo", CONNECTION, now + KEEP_REMOVED_MS - 1)).toEqual(photo);
    expect(keptRemoved("photo", CONNECTION, now + KEEP_REMOVED_MS)).toBeNull();
  });

  it("forgets what was removed on an earlier connection", () => {
    const now = Date.now();
    keepRemoved("photo", photo, CONNECTION, now);
    expect(keptRemoved("photo", "2026-10-23T10:00:00.000Z", now)).toBeNull();
    // For good: going back to the old connection doesn't bring it back.
    expect(keptRemoved("photo", CONNECTION, now)).toBeNull();
  });

  it("keeps the latest 50, and forgets one or all when told to", () => {
    const now = Date.now();
    for (let index = 0; index <= 50; index++) keepRemoved(`reference:${index}`, { ...photo, title: `Reference ${index}` }, CONNECTION, now);
    expect(keptRemoved("reference:0", CONNECTION, now)).toBeNull();
    expect(keptRemoved("reference:50", CONNECTION, now)).toMatchObject({ title: "Reference 50" });
    forgetRemoved("reference:50");
    expect(keptRemoved("reference:50", CONNECTION, now)).toBeNull();
    expect(keptRemoved("reference:1", CONNECTION, now)).not.toBeNull();
    forgetRemovedProfileEntries();
    expect(keptRemoved("reference:1", CONNECTION, now)).toBeNull();
  });
});
