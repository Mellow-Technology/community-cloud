/**
 * @file
 * Whether Cirrus can hear about an application's new releases, apart
 * from how the application itself is doing (./health.ts).
 *
 * Two of Cirrus's conditions are about the forge rather than the
 * application: `WebhookRegistered`, for the fast path, and
 * `ReleaseChecked`, for the poll that finds what the webhook missed.
 * Either can be false while the application runs perfectly well, on
 * the last release Cirrus found. Folding them into its health would
 * call a running application degraded, so they're shown on their own.
 *
 * The reasons are the ones Cirrus sets, in
 * operators/cirrus/src/reconcile/mod.rs.
 */
import { findCondition, type HealthTone } from "./health";
import { CONDITION_RELEASE_CHECKED, CONDITION_WEBHOOK, type WebApplication } from "./types";

/**
 * - connected: the webhook is registered and the last check worked
 * - polling: the webhook isn't registered, so new releases are only
 *   found by the poll, every ten minutes
 * - no-image: the newest successful pipeline published no image under
 *   the tag Cirrus expects, so it isn't rolled out
 * - failing: Cirrus couldn't ask GitLab, so new releases aren't found
 *   at all until it can
 * - pending: Cirrus hasn't reported on the forge yet
 */
export type ForgeState = "connected" | "polling" | "no-image" | "failing" | "pending";

export interface ForgeStatus {
  state: ForgeState;
  tone: HealthTone;
  label: string;
  message?: string;
}

const PRESENTATION: Record<ForgeState, { tone: HealthTone; label: string }> = {
  connected: { tone: "success", label: "Connected" },
  polling: { tone: "warning", label: "Polling only" },
  "no-image": { tone: "warning", label: "No image" },
  failing: { tone: "danger", label: "Can't check" },
  pending: { tone: "neutral", label: "Pending" },
};

/**
 * The order states are listed in, worst first.
 */
export const FORGE_ORDER: ForgeState[] = ["failing", "no-image", "polling", "pending", "connected"];

// What ReleaseChecked's reason says, when it's false
const NO_IMAGE_REASON = "NoImage";

/**
 * A forge status, from a state and why.
 *
 * @param state
 * @param messages every problem there is, worst first; the state is
 *   the worst's, but a webhook that's also missing is still worth
 *   saying
 * @returns
 */
function forge(state: ForgeState, ...messages: Array<string | undefined>): ForgeStatus {
  const message = messages.filter(Boolean).join(" ");
  return { state, ...PRESENTATION[state], ...(message ? { message } : {}) };
}

/**
 * Whether Cirrus can hear about the application's new releases. None
 * for an application with no forge to hear from.
 *
 * @param app
 * @returns
 */
export function forgeStatus(app: WebApplication): ForgeStatus | undefined {
  if (app.spec.source?.gitlab === undefined) {
    return undefined;
  }
  const conditions = app.status?.conditions;
  const webhook = findCondition(conditions, CONDITION_WEBHOOK);
  const checked = findCondition(conditions, CONDITION_RELEASE_CHECKED);
  if (webhook === undefined && checked === undefined) {
    return forge("pending", "Cirrus hasn't reported on the forge yet.");
  }

  const webhookProblem =
    webhook?.status === "False"
      ? webhook.message || "The webhook isn't registered, so new releases are only found by checking."
      : undefined;

  if (checked?.status === "False") {
    return checked.reason === NO_IMAGE_REASON
      ? forge("no-image", checked.message, webhookProblem)
      : forge("failing", checked.message || "Cirrus couldn't ask GitLab for the newest release.", webhookProblem);
  }
  if (webhookProblem !== undefined) {
    return forge("polling", webhookProblem);
  }
  return forge("connected");
}
