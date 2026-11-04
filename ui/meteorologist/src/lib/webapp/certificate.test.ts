import { describe, expect, test } from "bun:test";

import type { Certificate, Condition } from "../kube/types";
import { certificateStatus, findCertificate } from "./certificate";
import type { WebApplication } from "./types";

const NOW = Date.parse("2026-10-28T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const app = (hostnames?: string[]): WebApplication =>
  ({
    metadata: { name: "shop", namespace: "team" },
    spec: { image: { repository: "registry.example.test/shop" }, hostnames },
  }) as WebApplication;

/**
 * A Certificate with some conditions, and an expiry some days from NOW.
 *
 * @param conditions
 * @param days
 * @returns
 */
function certificate(conditions: Condition[], days?: number): Certificate {
  return {
    metadata: { name: "shop-tls", namespace: "team" },
    status: { conditions, ...(days === undefined ? {} : { notAfter: new Date(NOW + days * DAY).toISOString() }) },
  };
}

describe("an application's certificate", () => {
  test("is found by cert-manager's name for it, in its own namespace", () => {
    const ours = certificate([]);
    const elsewhere = { ...ours, metadata: { ...ours.metadata, namespace: "other" } };
    expect(findCertificate(app(["shop.example.test"]), [elsewhere, ours])).toBe(ours);
    expect(findCertificate(app(["shop.example.test"]), [elsewhere])).toBeUndefined();
  });

  test("isn't needed without a hostname", () => {
    expect(certificateStatus(app(), undefined, NOW)).toBeUndefined();
    expect(certificateStatus(app([]), undefined, NOW)).toBeUndefined();
  });

  const shop = app(["shop.example.test"]);
  const state = (cert: Certificate | undefined) => certificateStatus(shop, cert, NOW)?.state;

  test("is waited for until cert-manager makes it", () => {
    expect(state(undefined)).toBe("waiting");
  });

  test("is issued once Ready, until it nears running out", () => {
    const ready = { type: "Ready", status: "True" } as const;
    expect(state(certificate([ready], 60))).toBe("issued");
    expect(certificateStatus(shop, certificate([ready], 60), NOW)?.message).toContain("Valid until Dec 27, 2026");
    expect(state(certificate([ready], 5))).toBe("expiring");
    expect(state(certificate([ready], -1))).toBe("expired");
  });

  test("is issuing while cert-manager works on it, and failing once it gives up for now", () => {
    const missing = { type: "Ready", status: "False", reason: "DoesNotExist" } as const;
    expect(state(certificate([missing, { type: "Issuing", status: "True" }]))).toBe("issuing");
    const failed = certificateStatus(
      shop,
      certificate([missing, { type: "Issuing", status: "False", reason: "Failed", message: "order is invalid" }]),
      NOW,
    );
    expect(failed?.state).toBe("failing");
    expect(failed?.message).toBe("order is invalid");
  });
});
