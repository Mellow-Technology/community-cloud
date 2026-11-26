import { describe, expect, test } from "bun:test";

import { agentNameProblem, bearerToken, clientSetup, serviceAccountNamespace } from "./tokens";

describe("whose token it is", () => {
  test("is a ServiceAccount's namespace", () => {
    expect(serviceAccountNamespace("system:serviceaccount:team-shop:claude")).toBe("team-shop");
  });

  test("is no namespace for a person", () => {
    expect(serviceAccountNamespace("oidc:someone@example.org")).toBeUndefined();
    expect(serviceAccountNamespace("system:serviceaccount:team-shop")).toBeUndefined();
  });
});

describe("the bearer token", () => {
  test("is read from the header", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("bearer abc")).toBe("abc");
  });

  test("is nothing without one", () => {
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken("Basic dXNlcg==")).toBeUndefined();
  });
});

describe("an agent's name", () => {
  test("is a DNS label, and not the namespace's own account", () => {
    expect(agentNameProblem("claude")).toBeUndefined();
    expect(agentNameProblem("Claude")).toBeDefined();
    expect(agentNameProblem("default")).toBeDefined();
  });
});

test("the client setup points at /mcp with the token", () => {
  const setup = clientSetup("https://meteorologist.example.org", "tok");
  expect(setup.command).toBe(
    'claude mcp add --transport http community-cloud https://meteorologist.example.org/mcp --header "Authorization: Bearer tok"',
  );
  expect(JSON.parse(setup.json).mcpServers["community-cloud"].headers.Authorization).toBe("Bearer tok");
});
