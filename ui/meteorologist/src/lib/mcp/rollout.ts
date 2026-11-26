/**
 * @file
 * Waiting for an application to roll out, for an agent that has just
 * created or changed it.
 *
 * It watches the application, as the live pages do, and reads it again
 * on every change, saying what Cirrus is doing whenever that changes:
 * provisioning, migrating, rolling out. It stops at the first of:
 *
 * - finished: Cirrus has caught up with the change and the application
 *   is healthy, or rolled out with a pod that isn't well (degraded,
 *   which waiting may not fix)
 * - failed: stuck until someone does something, such as a failed
 *   migration or every pod crash looping, or being deleted
 * - the time running out, which isn't an answer either way: the agent
 *   asks again
 *
 * The watch is what makes it prompt; a slow poll beside it is what
 * makes it certain, should a watch end early or miss its moment.
 * Ending the watch is the API server's to decide (a few minutes), and
 * it's started again until the time is up.
 */
import { KubeError, type KubeClient } from "../kube/client";
import { appHealth, findCondition, type Health } from "../webapp/health";
import { CONDITION_READY, type WebApplication } from "../webapp/types";

export const DEFAULT_WAIT_SECONDS = 300;
export const MAX_WAIT_SECONDS = 600;

// How often it reads the application regardless of the watch
const POLL_MS = 15_000;

/**
 * Where a rollout has got to.
 *
 * - finished: nothing more will happen without another change
 * - ok: finished well; false when it failed or is still going
 */
export interface RolloutState {
  finished: boolean;
  ok: boolean;
  health: Health;
}

/**
 * Where an application's rollout has got to.
 *
 * @param app
 * @param generation the change being waited for; Cirrus has to have
 *   seen at least this one
 * @returns
 */
export function rolloutState(app: WebApplication, generation?: number): RolloutState {
  const health = appHealth(app);
  const observed = app.status?.observedGeneration;
  if (generation !== undefined && (observed === undefined || observed < generation)) {
    return { finished: false, ok: false, health: { ...health, state: "pending", label: "Pending" } };
  }
  switch (health.state) {
    case "healthy":
      return { finished: true, ok: true, health };
    case "failing":
    case "deleting":
      return { finished: true, ok: false, health };
    case "degraded":
      // Serving what it should, with a pod that isn't well: done, and
      // worth saying, but not a failure of the rollout
      return {
        finished: findCondition(app.status?.conditions, CONDITION_READY)?.status === "True",
        ok: false,
        health,
      };
    default:
      return { finished: false, ok: false, health };
  }
}

/**
 * How a wait ended.
 */
export interface RolloutOutcome extends RolloutState {
  app: WebApplication;
  timedOut: boolean;
  waitedSeconds: number;
}

export interface WaitOptions {
  // Cirrus must have seen at least this generation
  generation?: number;
  timeoutSeconds: number;
  // Called with each new thing Cirrus is doing
  onProgress?: (message: string) => void;
  // The caller going away
  signal?: AbortSignal;
}

/**
 * A sentence for where it's got to.
 *
 * @param state
 * @returns
 */
export function describeState(state: RolloutState): string {
  return state.health.message ? `${state.health.label}: ${state.health.message}` : state.health.label;
}

/**
 * Waits for an application to finish rolling out, or fail, or for the
 * time to run out.
 *
 * @param kube
 * @param namespace
 * @param name
 * @param options
 * @returns
 * @throws KubeError when it can't be read, such as when it's gone
 */
export async function waitForRollout(
  kube: Pick<KubeClient, "getWebApplication" | "watchWebApplications">,
  namespace: string,
  name: string,
  options: WaitOptions,
): Promise<RolloutOutcome> {
  const started = Date.now();
  const seconds = Math.min(Math.max(options.timeoutSeconds, 1), MAX_WAIT_SECONDS);

  return new Promise<RolloutOutcome>((resolve, reject) => {
    let settled = false;
    let latest: WebApplication | undefined;
    let said: string | undefined;
    let stopWatch: (() => void) | undefined;
    let reading = false;
    let again = false;

    const waited = () => Math.round((Date.now() - started) / 1000);
    const cleanUp = () => {
      settled = true;
      clearTimeout(deadline);
      clearInterval(poll);
      stopWatch?.();
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (outcome: RolloutOutcome) => {
      if (settled) return;
      cleanUp();
      resolve(outcome);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      cleanUp();
      reject(error);
    };
    const giveUp = () => {
      if (latest === undefined) {
        fail(new KubeError(504, `${name} couldn't be read before the time ran out.`));
        return;
      }
      finish({ ...rolloutState(latest, options.generation), app: latest, timedOut: true, waitedSeconds: waited() });
    };

    // One read at a time; a change while reading means reading again
    const check = async (): Promise<void> => {
      if (settled) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      try {
        const app = await kube.getWebApplication(namespace, name);
        latest = app;
        const state = rolloutState(app, options.generation);
        const sentence = describeState(state);
        if (sentence !== said) {
          said = sentence;
          options.onProgress?.(sentence);
        }
        if (state.finished) {
          finish({ ...state, app, timedOut: false, waitedSeconds: waited() });
        }
      } catch (error) {
        fail(error);
      } finally {
        reading = false;
      }
      if (again) {
        again = false;
        await check();
      }
    };

    const watch = async (): Promise<void> => {
      if (settled) return;
      try {
        const stop = await kube.watchWebApplications(
          { namespace, name },
          () => void check(),
          // The API server ends watches after a while; start another.
          // One that failed leaves the poll to carry on alone.
          (error) => {
            stopWatch = undefined;
            if (error === undefined) void watch();
          },
        );
        if (settled) stop();
        else stopWatch = stop;
      } catch {
        // The poll carries on
      }
    };

    const onAbort = () => giveUp();
    const deadline = setTimeout(giveUp, seconds * 1000);
    const poll = setInterval(() => void check(), POLL_MS);
    options.signal?.addEventListener("abort", onAbort);

    void check();
    void watch();
  });
}
