/**
 * @file
 * For the kubelet's probes. Says the server is up and nothing more:
 * reaching Authentik or the API server is per person, and a pod
 * restarted because Authentik was down wouldn't help anyone.
 */

/**
 * @returns
 */
export function GET(): Response {
  return new Response("ok", { headers: { "content-type": "text/plain" } });
}
