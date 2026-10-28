import { expect, test } from "bun:test";

import { KubeError } from "../kube/client";
import { refusedByApiServer } from "./access";

/**
 * A client whose whoAmI answers as given.
 *
 * @param answer
 * @returns
 */
function answering(answer: () => Promise<{ username: string; groups: string[] }>) {
  return { whoAmI: answer };
}

test("someone the API server accepts is let in", async () => {
  expect(await refusedByApiServer(answering(async () => ({ username: "authentik:sam", groups: [] })))).toBe(false);
});

test("someone it doesn't accept is refused", async () => {
  const unauthorized = answering(async () => {
    throw new KubeError(401, "Unauthorized");
  });
  expect(await refusedByApiServer(unauthorized)).toBe(true);
});

// Those say nothing about the person, and the pages show them
test("an API server that's down, or says something else, doesn't refuse anyone", async () => {
  for (const status of [0, 403, 500]) {
    const failing = answering(async () => {
      throw new KubeError(status, "no");
    });
    expect(await refusedByApiServer(failing)).toBe(false);
  }
});
