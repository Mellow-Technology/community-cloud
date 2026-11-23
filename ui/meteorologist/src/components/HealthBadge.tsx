/**
 * @file
 * A state as a coloured dot and a word, with the reason on hover: an
 * application's health, or its forge status.
 */
import { StatusDot } from "gui-mellow/StatusDot";

import type { HealthTone } from "@/lib/webapp/health";

/**
 * What a badge shows. Both an application's health and its forge
 * status have this shape.
 */
export interface BadgeState {
  state: string;
  tone: HealthTone;
  label: string;
  message?: string;
}

/**
 * @param props
 * @param props.health
 * @param props.showMessage whether to print the reason beside the word
 *   rather than only on hover
 * @returns
 */
export function HealthBadge({ health, showMessage = false }: { health: BadgeState; showMessage?: boolean }) {
  return (
    <StatusDot tone={health.tone} pulse={health.state === "progressing"} title={health.message}>
      {health.label}
      {showMessage && health.message ? ` — ${health.message}` : ""}
    </StatusDot>
  );
}
