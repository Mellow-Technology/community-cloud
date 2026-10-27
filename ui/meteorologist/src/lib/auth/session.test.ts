import { beforeAll, describe, expect, test } from "bun:test";

import { safeReturnTo } from "./oidc";
import { needsRefresh, sealLogin, sealSession, unsealLogin, unsealSession } from "./session";

beforeAll(() => {
  process.env.SESSION_SECRET = "a test secret that is comfortably over thirty-two characters";
});

describe("session cookies", () => {
  const session = { idToken: "header.payload.signature", refreshToken: "refresh", expiresAt: 2_000_000_000 };

  test("come back as they went in", async () => {
    expect(await unsealSession(await sealSession(session))).toEqual(session);
  });

  test("can't be read or changed by the browser", async () => {
    const sealed = await sealSession(session);
    expect(sealed).not.toContain("refresh");
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(await unsealSession(tampered)).toBeUndefined();
    expect(await unsealSession(undefined)).toBeUndefined();
    expect(await unsealSession("not a cookie")).toBeUndefined();
  });

  test("aren't mistaken for a sign-in in progress", async () => {
    expect(await unsealLogin(await sealSession(session))).toBeUndefined();
    const login = { codeVerifier: "v", state: "s", nonce: "n", returnTo: "/apps" };
    expect(await unsealLogin(await sealLogin(login))).toMatchObject(login);
  });

  test("ask for a refresh a minute early", () => {
    expect(needsRefresh({ ...session, expiresAt: 1000 }, 900)).toBe(false);
    expect(needsRefresh({ ...session, expiresAt: 1000 }, 950)).toBe(true);
  });
});

test("sign-in only ever returns to this site", () => {
  expect(safeReturnTo("/apps?namespace=team")).toBe("/apps?namespace=team");
  expect(safeReturnTo("https://evil.example")).toBe("/");
  expect(safeReturnTo("//evil.example")).toBe("/");
  expect(safeReturnTo("/\\evil.example")).toBe("/");
  expect(safeReturnTo(null)).toBe("/");
});
