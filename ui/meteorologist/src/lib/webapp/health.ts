/**
 * @file
 * How an application is doing, in one word, from what Cirrus says.
 *
 * Cirrus reports several conditions rather than one state, which is right
 * for an operator and too much for a list of applications. This boils
 * them down to the handful of states a person scanning the list cares
 * about, and keeps the message that explains the state, so the detail
 * is one click away rather than lost.
 *
 * It's about the application itself: whether it's running what it
 * should, and whether its pods are well. `Ready` only says Cirrus
 * finished rolling out, so the pods come from `Healthy`, which Cirrus
 * keeps from watching them (operators/cirrus/src/reconcile/pods.rs). Whether Cirrus can hear about new releases — the forge's
 * webhook, and checking GitLab for the newest pipeline — is apart, in
 * ./forge.ts. An application running fine with a broken webhook is
 * healthy, and its forge status says what's wrong with the webhook.
 *
 * The reasons it looks at are the ones Cirrus sets, in
 * operators/cirrus/src/reconcile/mod.rs and pods.rs. A Cirrus from
 * before `Healthy` existed doesn't set it, and then `Ready` alone
 * decides, as it used to.
 */
import {
  CONDITION_HEALTHY,
  CONDITION_PROVISIONED,
  CONDITION_READY,
  CONDITION_ROLLED_OUT,
  type WebApplication,
} from "./types";
import type { Condition } from "../kube/types";

/**
 * - healthy: running the image it should, with everything it asked for
 * - degraded: serving, but a pod is stuck or has restarted recently.
 *   For a cc-office service, short of what it asked for (../office.ts)
 * - progressing: on its way, such as mid-rollout or migrating
 * - failing: stuck until someone does something, such as nothing
 *   serving because every pod is crash looping
 * - pending: Cirrus hasn't looked at this version of it yet
 * - deleting: asked to be deleted, and waiting on Cirrus to clean up
 *   what it made outside the namespace
 */
export type HealthState = "healthy" | "degraded" | "progressing" | "failing" | "pending" | "deleting";

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
  deleting: { tone: "neutral", label: "Deleting" },
};

// Reasons that mean waiting won't help
const FAILING_REASONS = new Set(["Blocked", "MigrationFailed"]);

// Healthy's reasons for pods that are well enough to serve, and not
const PODS_DEGRADED = "PodsDegraded";
const PODS_FAILING = "PodsFailing";

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

  // Whatever it said before, it's on its way out
  if (app.metadata.deletionTimestamp !== undefined) {
    return health("deleting", "Cirrus is removing what it made for this application.");
  }
  if (conditions.length === 0) {
    return health("pending", "Cirrus hasn't reported on this application yet.");
  }
  if (generation !== undefined && status?.observedGeneration !== undefined && status.observedGeneration < generation) {
    return health("pending", "Cirrus hasn't caught up with the latest change yet.");
  }

  const ready = findCondition(conditions, CONDITION_READY);
  const pods = findCondition(conditions, CONDITION_HEALTHY);
  const steps = [CONDITION_PROVISIONED, CONDITION_ROLLED_OUT].map((type) => findCondition(conditions, type));

  // What Cirrus is stuck on that waiting won't fix
  const blocked = steps.find((step) => step?.status === "False" && FAILING_REASONS.has(step.reason ?? ""));
  if (blocked) {
    return health("failing", blocked.message || blocked.reason);
  }

  // The pods, whatever the rollout is doing: a new image crash looping
  // is worth saying while the old pods still serve
  if (pods?.status === "False" && pods.reason === PODS_FAILING) {
    return health("failing", pods.message || "No pod is serving.");
  }
  if (pods?.status === "False" && pods.reason === PODS_DEGRADED) {
    return health("degraded", pods.message || "A pod isn't well.");
  }

  if (ready?.status === "True" && pods?.status !== "False") {
    return health("healthy");
  }

  // What's still on its way, in the order Cirrus works through it
  const waiting = [...steps, pods].find((condition) => condition?.status === "False");
  return health("progressing", waiting?.message || waiting?.reason || ready?.message || undefined);
}

/**
 * How many applications are in each state, for the overview.
 *
 * @param apps
 * @returns
 */
export function countHealth(apps: WebApplication[]): Record<HealthState, number> {
  const counts: Record<HealthState, number> = {
    healthy: 0,
    degraded: 0,
    progressing: 0,
    failing: 0,
    pending: 0,
    deleting: 0,
  };
  for (const app of apps) {
    counts[appHealth(app).state] += 1;
  }
  return counts;
}

/**
 * The order states are listed in, worst first.
 */
export const HEALTH_ORDER: HealthState[] = ["failing", "degraded", "progressing", "pending", "healthy", "deleting"];

/**
 * The word and colour for a state.
 *
 * @param state
 * @returns
 */
export function presentHealth(state: HealthState): { tone: HealthTone; label: string } {
  return PRESENTATION[state];
}
