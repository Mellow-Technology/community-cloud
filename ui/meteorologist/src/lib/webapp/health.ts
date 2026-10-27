/**
 * @file
 * How an application is doing, in one word, from what Cirrus says.
 *
 * Cirrus reports four conditions rather than one state, which is right
 * for an operator and too much for a list of applications. This boils
 * them down to the handful of states a person scanning the list cares
 * about, and keeps the message that explains the state, so the detail
 * is one click away rather than lost.
 *
 * The reasons it looks at are the ones Cirrus sets, in
 * operators/cirrus/src/reconcile/mod.rs.
 */
import {
  CONDITION_PROVISIONED,
  CONDITION_READY,
  CONDITION_ROLLED_OUT,
  CONDITION_WEBHOOK,
  type WebApplication,
} from "./types";
import type { Condition } from "../kube/types";

/**
 * - healthy: running the image it should, with everything it asked for
 * - degraded: running, but something around it isn't right, such as
 *   the forge's webhook
 * - progressing: on its way, such as mid-rollout or migrating
 * - failing: stuck until someone does something
 * - pending: Cirrus hasn't looked at this version of it yet
 */
export type HealthState = "healthy" | "degraded" | "progressing" | "failing" | "pending";

/**
 * GUI Mellow's tones, which badges and dots are coloured by.
 */
export type HealthTone = "success" | "warning" | "primary" | "danger" | "neutral";

export interface Health {
  state: HealthState;
  tone: HealthTone;
  label: string;
  // Why, when there's more to say than the label
  message?: string;
}

// The colour and the word for each state
const PRESENTATION: Record<HealthState, { tone: HealthTone; label: string }> = {
  healthy: { tone: "success", label: "Healthy" },
  degraded: { tone: "warning", label: "Degraded" },
  progressing: { tone: "primary", label: "Progressing" },
  failing: { tone: "danger", label: "Failing" },
  pending: { tone: "neutral", label: "Pending" },
};

// Reasons that mean waiting won't help
const FAILING_REASONS = new Set(["Blocked", "MigrationFailed"]);

/**
 * One of an object's conditions, by type.
 *
 * @param conditions
 * @param type
 * @returns
 */
export function findCondition(conditions: Condition[] | undefined, type: string): Condition | undefined {
  return conditions?.find((condition) => condition.type === type);
}

/**
 * A health, from a state and why.
 *
 * @param state
 * @param message
 * @returns
 */
function health(state: HealthState, message?: string): Health {
  return { state, ...PRESENTATION[state], ...(message ? { message } : {}) };
}

/**
 * How an application is doing.
 *
 * @param app
 * @returns
 */
export function appHealth(app: WebApplication): Health {
  const status = app.status;
  const conditions = status?.conditions ?? [];
  const generation = app.metadata.generation;

  if (conditions.length === 0) {
    return health("pending", "Cirrus hasn't reported on this application yet.");
  }
  if (generation !== undefined && status?.observedGeneration !== undefined && status.observedGeneration < generation) {
    return health("pending", "Cirrus hasn't caught up with the latest change yet.");
  }

  const ready = findCondition(conditions, CONDITION_READY);
  const webhook = findCondition(conditions, CONDITION_WEBHOOK);

  if (ready?.status === "True") {
    return webhook?.status === "False"
      ? health("degraded", webhook.message || "The forge's webhook isn't registered, so new releases won't arrive.")
      : health("healthy");
  }

  // What's holding it up, in the order Cirrus works through them
  for (const type of [CONDITION_PROVISIONED, CONDITION_ROLLED_OUT]) {
    const condition = findCondition(conditions, type);
    if (condition?.status === "False") {
      const message = condition.message || condition.reason;
      return FAILING_REASONS.has(condition.reason ?? "") ? health("failing", message) : health("progressing", message);
    }
  }

  return health("progressing", ready?.message || undefined);
}

/**
 * How many applications are in each state, for the overview.
 *
 * @param apps
 * @returns
 */
export function countHealth(apps: WebApplication[]): Record<HealthState, number> {
  const counts: Record<HealthState, number> = { healthy: 0, degraded: 0, progressing: 0, failing: 0, pending: 0 };
  for (const app of apps) {
    counts[appHealth(app).state] += 1;
  }
  return counts;
}

/**
 * The order states are listed in, worst first.
 */
export const HEALTH_ORDER: HealthState[] = ["failing", "degraded", "progressing", "pending", "healthy"];

/**
 * The word and colour for a state.
 *
 * @param state
 * @returns
 */
export function presentHealth(state: HealthState): { tone: HealthTone; label: string } {
  return PRESENTATION[state];
}
