/**
 * @file
 * Whether an application's HTTPS certificate is there, in one word.
 *
 * Cirrus asks for it rather than making it: the ListenerSet it writes
 * carries cert-manager's cluster-issuer annotation, and cert-manager
 * makes a Certificate named after the listener's Secret, <app>-tls
 * (operators/cirrus/src/reconcile/network.rs), then gets it from
 * Let's Encrypt. So the Certificate is found by that name, and its
 * Ready condition says how it went.
 */
import type { Certificate, Condition } from "../kube/types";
import type { HealthTone } from "./health";
import type { WebApplication } from "./types";

// Soon enough that a renewal cert-manager should already have done
// has evidently gone wrong
const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * - issued: valid, and not close to running out
 * - issuing: cert-manager is getting one, which takes a minute or two
 * - waiting: asked for, but cert-manager hasn't started on it
 * - expiring: valid for now, but past when it should have renewed
 * - failing: cert-manager tried and couldn't
 * - expired: browsers will refuse it
 */
export type CertificateState = "issued" | "issuing" | "waiting" | "expiring" | "failing" | "expired";

export interface CertificateStatus {
  state: CertificateState;
  tone: HealthTone;
  label: string;
  message?: string;
  expires?: string;
}

// The colour and the word for each state
const PRESENTATION: Record<CertificateState, { tone: HealthTone; label: string }> = {
  issued: { tone: "success", label: "Issued" },
  issuing: { tone: "primary", label: "Issuing" },
  waiting: { tone: "neutral", label: "Waiting" },
  expiring: { tone: "warning", label: "Expiring soon" },
  failing: { tone: "danger", label: "Failing" },
  expired: { tone: "danger", label: "Expired" },
};

/**
 * The name cert-manager gives an application's Certificate.
 *
 * @param app
 * @returns
 */
export function certificateName(app: WebApplication): string {
  return `${app.metadata.name}-tls`;
}

/**
 * An application's Certificate, from those in its namespace or more.
 *
 * @param app
 * @param certificates
 * @returns
 */
export function findCertificate(app: WebApplication, certificates: Certificate[]): Certificate | undefined {
  return certificates.find(
    (each) => each.metadata.namespace === app.metadata.namespace && each.metadata.name === certificateName(app),
  );
}

/**
 * A date as a person reads it.
 *
 * @param iso
 * @returns
 */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * How an application's certificate is doing.
 *
 * @param app
 * @param certificate its Certificate, if there is one
 * @param now
 * @returns nothing when the application has no hostname to need one
 */
export function certificateStatus(
  app: WebApplication,
  certificate: Certificate | undefined,
  now: number = Date.now(),
): CertificateStatus | undefined {
  if (!app.spec.hostnames?.length) {
    return undefined;
  }
  const status = (state: CertificateState, message?: string): CertificateStatus => ({
    state,
    ...PRESENTATION[state],
    message,
    expires: certificate?.status?.notAfter,
  });
  if (certificate === undefined) {
    return status("waiting", "cert-manager hasn't made a certificate for it yet.");
  }

  const conditions: Condition[] = certificate.status?.conditions ?? [];
  const ready = conditions.find((each) => each.type === "Ready");
  const issuing = conditions.find((each) => each.type === "Issuing");
  const notAfter = certificate.status?.notAfter;

  if (notAfter !== undefined && Date.parse(notAfter) <= now) {
    return status("expired", `It ran out on ${day(notAfter)}. ${ready?.message ?? ""}`.trim());
  }
  if (ready?.status === "True") {
    if (notAfter !== undefined && Date.parse(notAfter) - now < EXPIRING_SOON_MS) {
      return status("expiring", `It runs out on ${day(notAfter)}, and hasn't been renewed.`);
    }
    const renews = certificate.status?.renewalTime;
    return status(
      "issued",
      notAfter ? `Valid until ${day(notAfter)}${renews ? `, renewed from ${day(renews)}` : ""}.` : undefined,
    );
  }
  if (issuing?.status === "True") {
    return status("issuing", issuing.message ?? ready?.message);
  }
  // cert-manager sets Issuing False with a reason when an attempt fails,
  // and backs off before the next
  if (issuing?.status === "False" || (ready?.status === "False" && ready.reason !== "DoesNotExist")) {
    return status("failing", issuing?.message ?? ready?.message);
  }
  return status("waiting", ready?.message);
}

/**
 * Worst first, for sorting: what needs someone, then what's on its
 * way, then what's fine.
 */
export const CERTIFICATE_ORDER: CertificateState[] = ["expired", "failing", "expiring", "waiting", "issuing", "issued"];
