import { describe, expect, test } from "bun:test";

import { connectionsProblem, envPrefix } from "../webapp/form";
import { connectionEnv, mayConnect, usableOfferings, type OfferingChoice } from "./present";

const choice = (namespace: string, name: string, extra: Partial<OfferingChoice> = {}): OfferingChoice => ({
  namespace,
  name,
  title: name,
  description: "",
  protocol: "http",
  shareWith: [],
  ready: true,
  hasSecret: false,
  values: [],
  ...extra,
});

describe("which offerings an application may use", () => {
  const choices = [
    choice("cc-office", "cache", { title: "Shared Redis", shareWith: ["team-shop"] }),
    choice("cc-office", "mariadb", { title: "Shared MariaDB" }),
    choice("team-shop", "search", { title: "Search" }),
  ];

  test("its own namespace's and those shared with it, its own first", () => {
    expect(usableOfferings(choices, "team-shop").map((each) => each.name)).toEqual(["search", "cache"]);
    expect(usableOfferings(choices, "cc-office").map((each) => each.name)).toEqual(["mariadb", "cache"]);
    expect(mayConnect(choices[1]!, "team-shop")).toBe(false);
  });
});

describe("what a connection sets", () => {
  test("variables named for the connection, or the offering", () => {
    const search = choice("catalogue", "search", { values: ["region"] });
    expect(connectionEnv(search, "", "shop").variables).toEqual([
      "SEARCH_HOST",
      "SEARCH_PORT",
      "SEARCH_URL",
      "SEARCH_TYPE",
      "SEARCH_REGION",
    ]);
    expect(connectionEnv(search, "product-search", "shop").variables[0]).toBe("PRODUCT_SEARCH_HOST");
  });

  test("credentials only within the offering's namespace", () => {
    const cache = choice("cc-office", "cache", { hasSecret: true });
    expect(connectionEnv(cache, "", "cc-office").credentials).toBe("given");
    expect(connectionEnv(cache, "", "team-shop").credentials).toBe("withheld");
    expect(connectionEnv(choice("a", "b"), "", "a").credentials).toBe("none");
  });

  test("names become prefixes as Cirrus makes them, and can't collide", () => {
    expect(envPrefix("product-search.v2")).toBe("PRODUCT_SEARCH_V2");
    expect(envPrefix("3d")).toBe("_3D");
    expect(
      connectionsProblem([
        { offering: "search", namespace: "", name: "" },
        { offering: "other", namespace: "", name: "search" },
      ]),
    ).toContain("both set SEARCH_*");
    expect(
      connectionsProblem([
        { offering: "search", namespace: "", name: "" },
        { offering: "", namespace: "", name: "" },
      ]),
    ).toBeUndefined();
  });
});
