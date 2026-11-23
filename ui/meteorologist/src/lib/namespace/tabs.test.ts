import { describe, expect, test } from "bun:test";

import { namespaceTab, namespaceTabHref } from "./tabs";

describe("namespace tabs", () => {
  test("reads the tab from ?tab=, General for anything else", () => {
    expect(namespaceTab("dns")).toBe("dns");
    expect(namespaceTab("forges")).toBe("forges");
    expect(namespaceTab(undefined)).toBe("general");
    expect(namespaceTab("nonsense")).toBe("general");
    // Applications has its own address, not a ?tab=
    expect(namespaceTab("applications")).toBe("general");
  });

  test("lands links to the old Integration tab on Forges", () => {
    expect(namespaceTab("integration")).toBe("forges");
  });

  test("knows where each tab is", () => {
    expect(namespaceTabHref("team a", "general")).toBe("/namespaces/team%20a");
    expect(namespaceTabHref("team", "applications")).toBe("/namespaces/team/applications");
    expect(namespaceTabHref("team", "forges")).toBe("/namespaces/team?tab=forges");
  });
});
