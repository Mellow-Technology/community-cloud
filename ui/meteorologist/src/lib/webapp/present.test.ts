import { describe, expect, test } from "bun:test";

import { portLabel } from "./present";
import type { WebApplication } from "./types";

const app = (port?: number, statusPort?: number): WebApplication => ({
  apiVersion: "community-cloud.technology/v1alpha1",
  kind: "WebApplication",
  metadata: { name: "shop", namespace: "acme" },
  spec: { image: { repository: "registry.gitlab.com/acme/shop" }, ...(port !== undefined ? { port } : {}) },
  ...(statusPort !== undefined ? { status: { port: statusPort } } : {}),
});

describe("the port, as the page shows it", () => {
  test("is the spec's when it sets one", () => {
    expect(portLabel(app(3000, 3000))).toBe("3000");
  });

  test("says it came from the image when the spec leaves it out", () => {
    expect(portLabel(app(undefined, 8000))).toBe("8000, from the image");
  });

  test("says it's still to be read before Cirrus has", () => {
    expect(portLabel(app())).toBe("From the image, once Cirrus has read it");
  });
});
