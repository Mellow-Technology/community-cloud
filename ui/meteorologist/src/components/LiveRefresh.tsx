"use client";

/**
 * @file
 * Keeps a page up to date with its WebApplications.
 *
 * The server says when something changed (/apps/live) and the page is
 * redrawn the usual way, so there's only one idea of how to show an
 * application. Redrawing keeps what's open and typed, such as a dialog.
 *
 * Nothing runs while the tab is hidden, since each open page holds a
 * watch on the API server. Starting again catches up by itself: a
 * watch begins with everything already there.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusDot } from "gui-mellow/StatusDot";

import styles from "@/components/page.module.scss";

// Cirrus changes several things at once during a rollout, and a redraw
// makes several requests, so changes are gathered up for this long
const REDRAW_MS = 1000;

// How long to wait after being turned away. EventSource only retries
// by itself after a dropped connection, not an error from the Gateway
// or a 204 from someone who can't watch.
const RETRY_MS = 30_000;

/**
 * @param props
 * @param props.namespace only this namespace's applications
 * @param props.name only this application
 * @returns
 */
export function LiveRefresh({ namespace, name }: { namespace?: string; name?: string }) {
  const router = useRouter();
  const [live, setLive] = useState<boolean>();

  useEffect(() => {
    const query = new URLSearchParams();
    if (namespace !== undefined) {
      query.set("namespace", namespace);
    }
    if (name !== undefined) {
      query.set("name", name);
    }

    let source: EventSource | undefined;
    let redraw: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const changed = () => {
      redraw ??= setTimeout(() => {
        redraw = undefined;
        router.refresh();
      }, REDRAW_MS);
    };
    const close = () => {
      clearTimeout(retry);
      source?.close();
      source = undefined;
    };
    const open = () => {
      close();
      const opened = new EventSource(`/apps/live?${query}`);
      source = opened;
      opened.onopen = () => setLive(true);
      opened.addEventListener("changed", changed);
      opened.onerror = () => {
        setLive(false);
        if (opened.readyState === EventSource.CLOSED) {
          retry = setTimeout(open, RETRY_MS);
        }
      };
    };
    const visibility = () => (document.hidden ? close() : open());

    if (!document.hidden) {
      open();
    }
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      clearTimeout(redraw);
      close();
    };
  }, [router, namespace, name]);

  if (live === undefined) {
    return null;
  }
  return (
    <p className={styles.live}>
      <StatusDot tone={live ? "success" : "neutral"}>
        {live ? "Updating live" : "Not updating. Reload for the latest."}
      </StatusDot>
    </p>
  );
}
