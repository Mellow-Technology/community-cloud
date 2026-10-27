import { afterEach, describe, expect, test } from "bun:test";

import { ConfigError, assertConfigured, configProblems, getKubeMode, getPublicUrl } from "./config";

// Every setting these tests touch, so each starts from nothing
const SETTINGS = [
  "NODE_ENV",
  "PORT",
  "METEOROLOGIST_KUBE_MODE",
  "METEOROLOGIST_KUBECONFIG",
  "METEOROLOGIST_URL",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "SESSION_SECRET",
];
const saved = Object.fromEntries(SETTINGS.map((name) => [name, process.env[name]]));

function use(settings: Record<string, string>) {
  for (const name of SETTINGS) {
    delete process.env[name];
  }
  Object.assign(process.env, settings);
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("the mode, when nothing names one", () => {
  test("is the pretend cluster with nothing set up", () => {
    use({ NODE_ENV: "development" });
    expect(getKubeMode()).toBe("fixtures");
    expect(configProblems()).toEqual([]);
  });

  test("acts as a named kubeconfig's user", () => {
    use({ NODE_ENV: "development", METEOROLOGIST_KUBECONFIG: "/no/such/kubeconfig" });
    expect(getKubeMode()).toBe("kubeconfig");
  });

  test("signs people in once there's an issuer, kubeconfig or not", () => {
    use({ NODE_ENV: "development", OIDC_ISSUER: "https://auth.example/", METEOROLOGIST_KUBECONFIG: "/k" });
    expect(getKubeMode()).toBe("user");
  });

  test("always signs people in when deployed", () => {
    use({ NODE_ENV: "production", METEOROLOGIST_KUBECONFIG: "/k" });
    expect(getKubeMode()).toBe("user");
  });

  test("is whatever METEOROLOGIST_KUBE_MODE says, when it says", () => {
    use({ NODE_ENV: "development", METEOROLOGIST_KUBE_MODE: "user" });
    expect(getKubeMode()).toBe("user");
  });
});

describe("what's missing", () => {
  test("is listed all at once", () => {
    use({ NODE_ENV: "production" });
    const problems = configProblems();
    for (const name of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "SESSION_SECRET", "METEOROLOGIST_URL"]) {
      expect(problems.some((problem) => problem.startsWith(name))).toBe(true);
    }
    expect(() => assertConfigured()).toThrow(ConfigError);
  });

  test("doesn't include a public address when working locally", () => {
    use({
      NODE_ENV: "development",
      OIDC_ISSUER: "http://localhost:9000/application/o/m/",
      OIDC_CLIENT_ID: "m",
      SESSION_SECRET: "x".repeat(32),
    });
    expect(configProblems()).toEqual([]);
    expect(getPublicUrl()).toBe("http://localhost:3000");
  });

  test("includes a short session secret and a kubeconfig that isn't there", () => {
    use({ NODE_ENV: "development", METEOROLOGIST_KUBECONFIG: "/no/such/kubeconfig" });
    expect(configProblems()).toEqual(["METEOROLOGIST_KUBECONFIG names /no/such/kubeconfig, which doesn't exist"]);
    use({ NODE_ENV: "development", OIDC_ISSUER: "https://a/", OIDC_CLIENT_ID: "m", SESSION_SECRET: "short" });
    expect(configProblems()).toEqual(["SESSION_SECRET is shorter than 32 characters"]);
  });
});
