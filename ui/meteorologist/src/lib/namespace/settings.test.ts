import { describe, expect, test } from "bun:test";

import {
  PLACEMENT_ANNOTATION,
  defaultPullSecrets,
  dockerConfigJson,
  emptyNamespaceForm,
  initialLabels,
  placementPatch,
  pullSecretName,
  toLimitRange,
  toNamespaceForm,
  toResourceQuota,
  validateNamespaceForm,
  type NamespaceForm,
} from "./settings";

/**
 * @param changes
 * @returns
 */
function form(changes: Partial<NamespaceForm> = {}): NamespaceForm {
  return { ...emptyNamespaceForm(), name: "team-shop", ...changes };
}

describe("the quota", () => {
  test("isn't made when nothing is limited", () => {
    expect(toResourceQuota(form())).toBeUndefined();
  });

  test("reserves CPU, caps memory and counts storage", () => {
    const quota = toResourceQuota(form({ quotaCpu: "4", quotaMemory: "8Gi", quotaStorage: " 100Gi " }));
    expect(quota?.metadata).toMatchObject({ name: "community-cloud", namespace: "team-shop" });
    expect(quota?.spec?.hard).toEqual({ "requests.cpu": "4", "limits.memory": "8Gi", "requests.storage": "100Gi" });
  });
});

describe("the container defaults", () => {
  test("leave out what's empty", () => {
    const limits = toLimitRange(form())?.spec.limits[0];
    expect(limits).toEqual({
      type: "Container",
      default: { memory: "512Mi" },
      defaultRequest: { cpu: "100m", memory: "128Mi" },
    });
  });

  test("aren't made when there are none", () => {
    expect(
      toLimitRange(form({ defaultCpuRequest: "", defaultMemoryRequest: "", defaultMemoryLimit: "" })),
    ).toBeUndefined();
  });
});

describe("reading back", () => {
  test("gives the form that wrote it", () => {
    const written = form({ quotaCpu: "2", quotaStorage: "50Gi", region: "sea", pullSecrets: ["pull-ghcr-io"] });
    const read = toNamespaceForm(
      "team-shop",
      { [PLACEMENT_ANNOTATION]: "topology.kubernetes.io/region=sea" },
      toResourceQuota(written),
      toLimitRange(written),
      { metadata: { name: "default" }, imagePullSecrets: [{ name: "pull-ghcr-io" }] },
    );
    expect(read).toEqual(written);
  });

  test("doesn't take a hand-written selector on other labels for a region", () => {
    const read = toNamespaceForm("x", { [PLACEMENT_ANNOTATION]: "disk=ssd" }, undefined, undefined, undefined);
    expect(read.region).toBe("");
  });
});

describe("placement", () => {
  test("sets the region", () => {
    expect(placementPatch(form({ region: "sea" }), undefined)).toEqual({
      [PLACEMENT_ANNOTATION]: "topology.kubernetes.io/region=sea",
    });
  });

  test("removes only a region it could have set", () => {
    expect(placementPatch(form(), { [PLACEMENT_ANNOTATION]: "topology.kubernetes.io/region=sea" })).toEqual({
      [PLACEMENT_ANNOTATION]: null,
    });
    expect(placementPatch(form(), { [PLACEMENT_ANNOTATION]: "disk=ssd" })).toEqual({});
  });
});

describe("registries", () => {
  test("are named for their host", () => {
    expect(pullSecretName("https://registry.gitlab.com/acme")).toBe("pull-registry-gitlab-com");
    expect(pullSecretName("ghcr.io")).toBe("pull-ghcr-io");
  });

  test("become a dockerconfigjson", () => {
    const config = JSON.parse(dockerConfigJson({ server: "ghcr.io/", username: "bot", password: "pä55" }));
    const entry = config.auths["ghcr.io"];
    expect(entry.username).toBe("bot");
    expect(new TextDecoder().decode(Uint8Array.from(atob(entry.auth), (c) => c.charCodeAt(0)))).toBe("bot:pä55");
  });

  test("are added to the defaults kept", () => {
    expect(
      defaultPullSecrets(
        form({ pullSecrets: ["pull-ghcr-io"], registries: [{ server: "quay.io", username: "u", password: "p" }] }),
      ),
    ).toEqual(["pull-ghcr-io", "pull-quay-io"]);
  });
});

describe("validation", () => {
  test("a typical new namespace passes", () => {
    expect(validateNamespaceForm(form({ quotaCpu: "4", quotaMemory: "8Gi" }), true)).toEqual({});
  });

  test("names", () => {
    expect(validateNamespaceForm(form({ name: "" }), true).name).toBeDefined();
    expect(validateNamespaceForm(form({ name: "Team" }), true).name).toBeDefined();
    expect(validateNamespaceForm(form({ name: "kube-public" }), true).name).toBeDefined();
    expect(validateNamespaceForm(form({ name: "cc-office" }), true).name).toBeDefined();
    // An existing namespace's name isn't for changing
    expect(validateNamespaceForm(form({ name: "cc-office" }), false).name).toBeUndefined();
  });

  test("a quota needs the defaults that let pods state it", () => {
    const errors = validateNamespaceForm(
      form({ quotaCpu: "4", quotaMemory: "8Gi", defaultCpuRequest: "", defaultMemoryLimit: "" }),
      true,
    );
    expect(errors.defaultCpuRequest).toBeDefined();
    expect(errors.defaultMemoryLimit).toBeDefined();
  });

  test("a limit under its request", () => {
    expect(validateNamespaceForm(form({ defaultMemoryLimit: "64Mi" }), true).defaultMemoryLimit).toBeDefined();
  });

  test("quantities", () => {
    expect(validateNamespaceForm(form({ quotaStorage: "lots" }), true).quotaStorage).toBeDefined();
  });

  test("registries need every field, and a new name", () => {
    expect(
      validateNamespaceForm(form({ registries: [{ server: "ghcr.io", username: "", password: "p" }] }), true)
        .registries,
    ).toBeDefined();
    expect(
      validateNamespaceForm(
        form({ pullSecrets: ["pull-ghcr-io"], registries: [{ server: "ghcr.io", username: "u", password: "p" }] }),
        true,
      ).registries,
    ).toContain("pull-ghcr-io");
  });
});

test("capabilities become labels", () => {
  const labels = initialLabels(form({ capabilities: { gateway: true, buckets: false } }));
  expect(labels).toEqual({ "app.kubernetes.io/created-by": "meteorologist", whereWereGoing: "weDontNeedRoads" });
});
