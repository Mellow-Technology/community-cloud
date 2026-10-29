import { describe, expect, test } from "bun:test";

import {
  credentialsData,
  credentialsFor,
  dnsState,
  domainConflicts,
  emptyDnsForm,
  fromDnsForm,
  providersFor,
  publisherOf,
  validateDnsForm,
  withNamespace,
  type DnsProviderForm,
} from "./providers";
import { DNS_API_VERSION, DNS_KIND, type DnsProvider } from "./types";

/**
 * A provider, as the API would hand it over.
 *
 * @param name
 * @param domains
 * @param namespaces
 * @param excludeDomains
 * @returns
 */
function provider(name: string, domains: string[], namespaces: string[], excludeDomains?: string[]): DnsProvider {
  return {
    apiVersion: DNS_API_VERSION,
    kind: DNS_KIND,
    metadata: { name },
    spec: { provider: "cloudflare", domains, namespaces, ...(excludeDomains ? { excludeDomains } : {}) },
  };
}

/**
 * A filled-in form for the team namespace.
 *
 * @param changes
 * @returns
 */
function form(changes: Partial<DnsProviderForm> = {}): DnsProviderForm {
  return {
    ...emptyDnsForm("team"),
    domains: "team.example",
    credentials: [{ name: "CF_API_TOKEN", value: "secret" }],
    ...changes,
  };
}

describe("which provider publishes what", () => {
  const office = provider("office", ["example.org"], ["cc-office", "team"], ["client.example.org"]);

  test("a namespace is published by the providers that list it", () => {
    expect(providersFor([office], "team")).toEqual([office]);
    expect(providersFor([office], "sandbox")).toEqual([]);
  });

  test("a hostname by the one whose domain it's in, unless excluded", () => {
    expect(publisherOf([office], "shop.example.org")).toBe(office);
    expect(publisherOf([office], "example.org")).toBe(office);
    expect(publisherOf([office], "*.apps.example.org")).toBe(office);
    expect(publisherOf([office], "a.client.example.org")).toBeUndefined();
    expect(publisherOf([office], "notexample.org")).toBeUndefined();
  });
});

describe("domains shared between namespaces", () => {
  test("are fine among providers publishing the same namespaces", () => {
    expect(domainConflicts([provider("a", ["example.org"], ["x"]), provider("b", ["example.org"], ["x"])])).toEqual([]);
  });

  test("are reported once when given to two", () => {
    const problems = domainConflicts([provider("a", ["example.org"], ["x"]), provider("b", ["example.org"], ["y"])]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("both a and b");
  });

  test("need excluding from the broader one", () => {
    const narrow = provider("client", ["client.example.org"], ["client"]);
    expect(domainConflicts([provider("office", ["example.org"], ["cc-office"]), narrow])).toHaveLength(1);
    expect(
      domainConflicts([provider("office", ["example.org"], ["cc-office"], ["client.example.org"]), narrow]),
    ).toEqual([]);
  });

  test("can be limited to one provider's problems", () => {
    const providers = [
      provider("a", ["example.org"], ["x"]),
      provider("b", ["example.org"], ["y"]),
      provider("c", ["other.example"], ["z"]),
    ];
    expect(domainConflicts(providers, "c")).toEqual([]);
    expect(domainConflicts(providers, "b")).toHaveLength(1);
  });
});

describe("the form for a new provider", () => {
  test("becomes a provider publishing the namespace, with its credentials apart", () => {
    const made = fromDnsForm(
      form({ domains: "Team.Example., other.example team.example", target: " 203.0.113.7 " }),
      "team",
    );
    expect(made.metadata.name).toBe("team");
    expect(made.spec).toEqual({
      provider: "cloudflare",
      domains: ["team.example", "other.example"],
      namespaces: ["team"],
      credentialsSecret: "cirrus-dns-team",
      target: "203.0.113.7",
      policy: "sync",
    });
    expect(credentialsData(form())).toEqual({ CF_API_TOKEN: "secret" });
  });

  test("takes any ExternalDNS provider by name", () => {
    expect(fromDnsForm(form({ provider: "other", customProvider: "gandi" }), "team").spec.provider).toBe("gandi");
    expect(validateDnsForm(form({ provider: "other", customProvider: "" }), [], "team").customProvider).toBeDefined();
  });

  test("keeps credentials already typed when the provider changes back", () => {
    const typed = form({ credentials: [{ name: "CF_API_TOKEN", value: "kept" }] });
    expect(credentialsFor(typed, "aws").map((row) => row.name)).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]);
    expect(credentialsFor(typed, "cloudflare")).toEqual([{ name: "CF_API_TOKEN", value: "kept" }]);
  });

  test("is valid filled in, and says what's missing", () => {
    expect(validateDnsForm(form(), [], "team")).toEqual({});
    const errors = validateDnsForm(form({ name: "Team!", domains: "", credentials: [] }), [], "team");
    expect(errors.name).toBeDefined();
    expect(errors.domains).toBeDefined();
    expect(errors.credentials).toBeDefined();
    expect(validateDnsForm(form({ credentials: [{ name: "CF_API_TOKEN", value: " " }] }), [], "team").credentials).toBe(
      "Every credential needs a value.",
    );
  });

  test("refuses a name or domain already taken", () => {
    const existing = [provider("team", ["elsewhere.example"], ["other"])];
    expect(validateDnsForm(form(), existing, "team").name).toContain("already");
    const office = [provider("office", ["example"], ["cc-office"])];
    expect(validateDnsForm(form({ domains: "team.example" }), office, "team").domains).toContain("Exclude");
  });
});

test("a namespace is added to a provider, or taken off, without repeats", () => {
  const office = provider("office", ["example.org"], ["cc-office"]);
  expect(withNamespace(office, "team", true).spec.namespaces).toEqual(["cc-office", "team"]);
  expect(withNamespace(withNamespace(office, "team", true), "team", true).spec.namespaces).toEqual([
    "cc-office",
    "team",
  ]);
  expect(withNamespace(office, "cc-office", false).spec.namespaces).toEqual([]);
  expect(office.spec.namespaces).toEqual(["cc-office"]);
});

describe("how a provider is doing", () => {
  const ready = { type: "Ready", status: "True" as const, reason: "Ready" };

  test("comes from Cirrus's Ready condition", () => {
    expect(dnsState(provider("a", ["x.example"], [])).tone).toBe("neutral");
    const conflicted = {
      ...provider("a", ["x.example"], []),
      status: {
        conditions: [{ type: "Ready", status: "False" as const, reason: "DomainConflict", message: "shared" }],
      },
    };
    expect(dnsState(conflicted)).toEqual({ tone: "danger", label: "Not publishing", message: "shared" });
  });

  test("and, for a namespace, from its instance", () => {
    const starting = {
      ...provider("a", ["x.example"], ["team"]),
      status: {
        conditions: [ready],
        instances: [{ namespace: "team", deployment: "cirrus-dns-a-team", ready: false }],
      },
    };
    expect(dnsState(starting, "team").tone).toBe("warning");
    expect(dnsState(starting).tone).toBe("success");
  });
});
