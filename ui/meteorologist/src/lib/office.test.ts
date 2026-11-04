import { describe, expect, test } from "bun:test";

import type { ConfigMap, Workload } from "./kube/types";
import {
  RECORD_KEY,
  RECORD_LABEL,
  findAdminSecret,
  officeApps,
  officeHealth,
  parseRecord,
  type PackageRecord,
} from "./office";

/**
 * A record's ConfigMap, as the installer writes it, with anything
 * given replacing what it would say.
 *
 * @param overrides
 * @param label
 * @returns
 */
function configMap(overrides: Record<string, unknown> = {}, label = "projectsend"): ConfigMap {
  return {
    metadata: { name: "cc-package-projectsend", labels: { [RECORD_LABEL]: label } },
    data: {
      [RECORD_KEY]: JSON.stringify({
        version: 1,
        name: "projectsend",
        description: "File sharing",
        namespace: "cc-office",
        rollout: ["statefulset/redis", "deployment/projectsend"],
        updated: "2026-10-30T00:00:00Z",
        app: {
          title: "ProjectSend",
          url: "https://files.example.test/",
          signIn: "authentik",
          admin: {
            secret: { namespace: "cc-office", name: "projectsend-admin", key: "password" },
            login: "admin@example.test",
          },
        },
        ...overrides,
      }),
    },
  };
}

/**
 * @param kind
 * @param name
 * @param ready
 * @param desired
 * @returns
 */
function workload(kind: Workload["kind"], name: string, ready: number, desired = 1): Workload {
  return { kind, name, namespace: "cc-office", ready, desired };
}

describe("reading a record", () => {
  test("as the installer writes it", () => {
    const record = parseRecord(configMap());
    expect(record?.app?.title).toBe("ProjectSend");
    expect(record?.app?.admin).toEqual({
      secret: { namespace: "cc-office", name: "projectsend-admin", key: "password" },
      login: "admin@example.test",
    });
    expect(record?.rollout).toEqual(["statefulset/redis", "deployment/projectsend"]);
  });

  test("leaving out what it can't read", () => {
    expect(parseRecord({ metadata: { name: "x" } })).toBeUndefined();
    expect(parseRecord({ metadata: { name: "x" }, data: { [RECORD_KEY]: "{not json" } })).toBeUndefined();
    expect(parseRecord(configMap({ version: 2 }))).toBeUndefined();
    // The label and the record have to agree on whose it is
    expect(parseRecord(configMap({}, "plane"))).toBeUndefined();
  });

  test("never linking anywhere but http or https", () => {
    const app = { title: "Bad", url: "javascript:alert(1)", signIn: "own" };
    expect(parseRecord(configMap({ app }))?.app).toBeUndefined();
  });

  test("dropping a credential outside the package's own namespace", () => {
    const app = {
      title: "ProjectSend",
      url: "https://files.example.test/",
      signIn: "authentik",
      admin: { secret: { namespace: "kube-system", name: "anything", key: "token" } },
    };
    const record = parseRecord(configMap({ app }));
    expect(record?.app?.title).toBe("ProjectSend");
    expect(record?.app?.admin).toBeUndefined();
  });

  test("with instructions instead of a credential", () => {
    const app = { title: "Twenty", url: "https://crm.example.test/", signIn: "own", admin: { how: "Sign up first." } };
    expect(parseRecord(configMap({ app }))?.app?.admin).toEqual({ how: "Sign up first." });
  });
});

describe("the office applications", () => {
  const records: PackageRecord[] = [
    {
      name: "plane",
      description: "",
      namespace: "cc-office",
      rollout: [],
      app: { title: "Plane", url: "https://p/", signIn: "own" },
    },
    { name: "cert-manager", description: "", namespace: "cert-manager", rollout: [] },
    parseRecord(configMap())!,
  ];

  test("are the records with an application, by title", () => {
    expect(officeApps(records).map((each) => each.name)).toEqual(["plane", "projectsend"]);
  });

  test("give up only the credential their record names", () => {
    expect(findAdminSecret(records, "projectsend")?.name).toBe("projectsend-admin");
    expect(findAdminSecret(records, "plane")).toBeUndefined();
    expect(findAdminSecret(records, "nothing")).toBeUndefined();
  });
});

describe("an office application's health", () => {
  const record = parseRecord(configMap())!;

  test("healthy with everything ready", () => {
    const health = officeHealth(record, [
      workload("statefulset", "redis", 1),
      workload("deployment", "projectsend", 1),
    ]);
    expect(health?.state).toBe("healthy");
  });

  test("failing when something's missing, or has nothing ready", () => {
    expect(officeHealth(record, [workload("statefulset", "redis", 1)])?.state).toBe("failing");
    expect(
      officeHealth(record, [workload("statefulset", "redis", 1), workload("deployment", "projectsend", 0)])?.message,
    ).toContain("deployment/projectsend has nothing ready");
  });

  test("degraded when short of what was asked for", () => {
    const health = officeHealth(record, [
      workload("statefulset", "redis", 1),
      workload("deployment", "projectsend", 1, 2),
    ]);
    expect(health?.state).toBe("degraded");
    expect(health?.message).toContain("1 of 2");
  });

  test("unknown when the record names nothing to look at", () => {
    expect(officeHealth({ ...record, rollout: [] }, [])).toBeUndefined();
  });
});
