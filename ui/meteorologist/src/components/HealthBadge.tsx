/**
 * @file
 * An application's health as a coloured dot and a word, with the
 * reason on hover.
 */
import { StatusDot } from "gui-mellow/StatusDot";

import type { Health } from "@/lib/webapp/health";

/**
 * @param props
 * @param props.health
 * @param props.showMessage whether to print the reason beside the word
 *   rather than only on hover
 * @returns
 */
export function HealthBadge({ health, showMessage = false }: { health: Health; showMessage?: boolean }) {
  return (
    <StatusDot tone={health.tone} pulse={health.state === "progressing"} title={health.message}>
      {health.label}
      {showMessage && health.message ? ` — ${health.message}` : ""}
    </StatusDot>
  );
}
