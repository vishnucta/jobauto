import { describe, expect, it } from "vitest";

import { newTopic, ntfyTarget } from "./alert-address";

describe("ntfyTarget", () => {
  it("splits a topic's address into its server and topic", () => {
    expect(ntfyTarget("https://ntfy.sh/jobauto-abc")).toEqual({ server: "https://ntfy.sh/", topic: "jobauto-abc" });
    expect(ntfyTarget(" http://nas.local:8080/ntfy/alerts ")).toEqual({ server: "http://nas.local:8080/ntfy/", topic: "alerts" });
  });

  it("refuses what isn't a topic, or carries a login or a query", () => {
    for (const address of ["", "ntfy.sh/topic", "https://ntfy.sh/", "https://ntfy.sh/a b", "ftp://ntfy.sh/topic", "https://user:pw@ntfy.sh/topic", "https://ntfy.sh/topic?x=1"]) {
      expect(ntfyTarget(address)).toBeNull();
    }
  });
});

describe("newTopic", () => {
  it("makes a long topic from unambiguous letters", () => {
    expect(newTopic((bytes) => bytes.fill(0))).toBe(`jobauto-${"a".repeat(16)}`);
    expect(newTopic()).toMatch(/^jobauto-[a-z2-9]{16}$/);
  });
});
