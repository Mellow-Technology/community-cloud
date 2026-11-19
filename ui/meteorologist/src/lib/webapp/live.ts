/**
 * @file
 * WebApplication changes, as server-sent events.
 *
 * The browser can't watch the API server itself, so this holds the
 * watches and tells it when something changed. It says only that, not
 * what: the page redraws from the cluster as the person, so the stream
 * has nothing to get wrong or to keep in step with the pages.
 *
 * Someone who can't watch across the cluster gets a watch per namespace
 * they can, all in one stream, so a page costs one connection either
 * way.
 *
 * A stream ends when its watches do, which is on purpose
 * (see WATCH_SECONDS in kube/apiServer.ts). The browser reconnects.
 */
import type { KubeClient, WatchScope } from "../kube/client";
import { namespacesAllowing, reachableNamespaces } from "../namespace/access";
import { GROUP, PLURAL } from "./types";

// Often enough that the Gateway and anything else in the way doesn't
// take a quiet stream for a dead one
const KEEPALIVE_MS = 20_000;

// How soon the browser reconnects after a stream ends
const RECONNECT_MS = 2000;

/**
 * What to watch for someone, given what they asked for.
 *
 * @param kube
 * @param scope a namespace, or one application in it, or nothing for
 *   everything they can see
 * @returns nothing when they can't watch any of it
 */
export async function watchScopes(kube: KubeClient, scope: WatchScope): Promise<WatchScope[]> {
  const watching = { verb: "watch", resource: PLURAL, group: GROUP };
  if (scope.namespace !== undefined) {
    const allowed = await namespacesAllowing(kube, watching, [scope.namespace]);
    return allowed.size > 0 ? [scope] : [];
  }
  if (await kube.canI(watching).catch(() => false)) {
    return [{}];
  }
  const names = (await reachableNamespaces(kube)).map((each) => each.metadata.name);
  return [...(await namespacesAllowing(kube, watching, names))].map((namespace) => ({ namespace }));
}

/**
 * The stream for some watches.
 *
 * @param kube
 * @param scopes
 * @param signal aborted when the browser goes away
 * @returns
 */
export function liveStream(
  kube: Pick<KubeClient, "watchWebApplications">,
  scopes: WatchScope[],
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const stops: Array<() => void> = [];
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let finished = false;

  const finish = () => {
    finished = true;
    clearInterval(keepalive);
    stops.forEach((stop) => stop());
  };

  return new ReadableStream({
    async start(controller) {
      const send = (text: string) => {
        if (!finished) {
          controller.enqueue(encoder.encode(text));
        }
      };
      const end = () => {
        if (!finished) {
          finish();
          controller.close();
        }
      };

      signal.addEventListener("abort", end);
      send(`retry: ${RECONNECT_MS}\n\n`);
      keepalive = setInterval(() => send(": still here\n\n"), KEEPALIVE_MS);

      let running = scopes.length;
      const ended = () => {
        running -= 1;
        if (running === 0) {
          end();
        }
      };
      await Promise.all(
        scopes.map(async (scope) => {
          const stop = await kube.watchWebApplications(scope, () => send("event: changed\ndata: {}\n\n"), ended);
          if (finished) {
            stop();
          } else {
            stops.push(stop);
          }
        }),
      );
    },
    cancel: finish,
  });
}
