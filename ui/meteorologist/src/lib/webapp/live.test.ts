import { describe, expect, test } from "bun:test";

import type { KubeClient, WatchScope } from "../kube/client";
import { fixtureClient, limitedToNamespaces } from "../kube/fixtures";
import { liveStream, watchScopes } from "./live";

interface FakeWatch {
  scope: WatchScope;
  change: () => void;
  end: () => void;
  stopped: boolean;
}

/**
 * A client whose watches are driven by the test.
 *
 * @returns
 */
function fakeKube() {
  const watches: FakeWatch[] = [];
  const kube: Pick<KubeClient, "watchWebApplications"> = {
    watchWebApplications: async (scope, onChange, onEnd) => {
      const watch: FakeWatch = { scope, change: onChange, end: onEnd, stopped: false };
      watches.push(watch);
      return () => {
        watch.stopped = true;
      };
    },
  };
  return { kube, watches };
}

/**
 * Everything a stream sends until it ends.
 *
 * @param stream
 * @returns
 */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("the stream", () => {
  test("says something changed, and ends with its watch so the browser starts another", async () => {
    const { kube, watches } = fakeKube();
    const text = readAll(liveStream(kube, [{ namespace: "a" }], new AbortController().signal));
    await Bun.sleep(0);
    watches[0]?.change();
    watches[0]?.end();
    expect(await text).toBe("retry: 2000\n\nevent: changed\ndata: {}\n\n");
  });

  test("stays open until every namespace's watch has ended", async () => {
    const { kube, watches } = fakeKube();
    const text = readAll(liveStream(kube, [{ namespace: "a" }, { namespace: "b" }], new AbortController().signal));
    await Bun.sleep(0);
    watches[0]?.end();
    watches[1]?.change();
    watches[1]?.end();
    expect(await text).toContain("event: changed");
  });

  test("stops its watches when the browser goes away", async () => {
    const { kube, watches } = fakeKube();
    const leaving = new AbortController();
    const text = readAll(liveStream(kube, [{ namespace: "a" }], leaving.signal));
    await Bun.sleep(0);
    leaving.abort();
    await text;
    expect(watches[0]?.stopped).toBe(true);
  });
});

describe("what's watched", () => {
  test("is the whole cluster for someone who can", async () => {
    expect(await watchScopes(fixtureClient(), {})).toEqual([{}]);
  });

  test("is each of their namespaces for someone who can't", async () => {
    const kube = limitedToNamespaces(fixtureClient(), ["team-shop", "sandbox"]);
    const scopes = await watchScopes(kube, {});
    expect(scopes.map((each) => each.namespace).toSorted()).toEqual(["sandbox", "team-shop"]);
  });

  test("is nothing in a namespace they can't watch", async () => {
    const kube = limitedToNamespaces(fixtureClient(), ["sandbox"]);
    expect(await watchScopes(kube, { namespace: "team-shop", name: "shop" })).toEqual([]);
  });
});
