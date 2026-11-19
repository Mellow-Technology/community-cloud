import { describe, expect, test } from "bun:test";

import { KubeError, type KubeClient } from "../kube/client";
import { fixtureClient, limitedToNamespaces } from "../kube/fixtures";
import type { Namespace } from "../kube/types";
import { acrossNamespaces, namespacesAllowing, reachableNamespaces } from "./access";

const forbidden = () => new KubeError(403, "forbidden", "Forbidden");

/**
 * @param name
 * @returns
 */
function ns(name: string): Namespace {
  return { metadata: { name } };
}

const names = (namespaces: Namespace[]) => namespaces.map((each) => each.metadata.name).toSorted();

describe("the namespaces someone can reach", () => {
  test("are all of them for someone who may list them, without using Meteorologist's account", async () => {
    const kube = {
      listNamespaces: async () => [ns("a"), ns("b")],
      listNamespaceNames: async () => {
        throw new Error("shouldn't be needed");
      },
    } as unknown as KubeClient;
    expect(names(await reachableNamespaces(kube))).toEqual(["a", "b"]);
  });

  test("are only the ones they can get, however many exist", async () => {
    const kube = limitedToNamespaces(fixtureClient(), ["team-shop", "sandbox"]);
    expect(names(await reachableNamespaces(kube))).toEqual(["sandbox", "team-shop"]);
  });

  test("leave out one deleted while looking", async () => {
    const kube = {
      listNamespaces: async () => {
        throw forbidden();
      },
      listNamespaceNames: async () => ["gone", "here"],
      getNamespace: async (name: string) => {
        if (name === "gone") {
          throw new KubeError(404, "not found", "NotFound");
        }
        return ns(name);
      },
    } as unknown as KubeClient;
    expect(names(await reachableNamespaces(kube))).toEqual(["here"]);
  });

  test("stay an error when the API server is down, rather than looking like none", async () => {
    const kube = {
      listNamespaces: async () => {
        throw new KubeError(0, "connection refused");
      },
    } as unknown as KubeClient;
    await expect(reachableNamespaces(kube)).rejects.toThrow("connection refused");
  });

  test("stay refused when there's no account to list them with", async () => {
    const kube = {
      listNamespaces: async () => {
        throw forbidden();
      },
      listNamespaceNames: async () => {
        throw forbidden();
      },
    } as unknown as KubeClient;
    await expect(reachableNamespaces(kube)).rejects.toThrow("forbidden");
  });
});

describe("reading across namespaces", () => {
  test("is one request when that's allowed", async () => {
    const asked: Array<string | undefined> = [];
    const found = await acrossNamespaces([ns("a")], async (namespace) => {
      asked.push(namespace);
      return ["everything"];
    });
    expect(found).toEqual(["everything"]);
    expect(asked).toEqual([undefined]);
  });

  test("falls back to each namespace, leaving out one that refuses", async () => {
    const found = await acrossNamespaces([ns("a"), ns("b")], async (namespace) => {
      if (namespace !== "a") {
        throw forbidden();
      }
      return ["from a"];
    });
    expect(found).toEqual(["from a"]);
  });

  test("is refused when every namespace refuses, so a page can tell", async () => {
    const read = acrossNamespaces([ns("a")], async () => {
      throw forbidden();
    });
    await expect(read).rejects.toThrow("forbidden");
  });

  test("finds nothing, without an error, for someone with no namespaces", async () => {
    const read = async (): Promise<string[]> => {
      throw forbidden();
    };
    expect(await acrossNamespaces([], read)).toEqual([]);
  });

  test("doesn't hide a failure in one namespace", async () => {
    const read = acrossNamespaces([ns("a"), ns("b")], async (namespace) => {
      if (namespace === undefined) {
        throw forbidden();
      }
      throw new KubeError(500, "etcd is unwell");
    });
    await expect(read).rejects.toThrow("etcd is unwell");
  });
});

describe("where someone may do something", () => {
  const webapps = { verb: "create", resource: "webapplications", group: "community-cloud.technology" };

  test("takes one question for a cluster admin", async () => {
    let questions = 0;
    const allowed = await namespacesAllowing(
      {
        canI: async () => {
          questions += 1;
          return true;
        },
      },
      webapps,
      ["a", "b", "c"],
    );
    expect([...allowed]).toEqual(["a", "b", "c"]);
    expect(questions).toBe(1);
  });

  test("is asked of each namespace otherwise", async () => {
    const allowed = await namespacesAllowing({ canI: async ({ namespace }) => namespace === "b" }, webapps, ["a", "b"]);
    expect([...allowed]).toEqual(["b"]);
  });

  test("names the namespace when it's the namespace being changed", async () => {
    const asked: Array<string | undefined> = [];
    await namespacesAllowing(
      {
        canI: async ({ name }) => {
          asked.push(name);
          return false;
        },
      },
      { verb: "patch", resource: "namespaces" },
      ["a"],
    );
    expect(asked).toEqual([undefined, "a"]);
  });

  test("counts a question that can't be answered as no", async () => {
    const allowed = await namespacesAllowing(
      {
        canI: async () => {
          throw new KubeError(0, "connection refused");
        },
      },
      webapps,
      ["a"],
    );
    expect(allowed.size).toBe(0);
  });
});
