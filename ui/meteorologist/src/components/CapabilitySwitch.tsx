"use client";

/**
 * @file
 * One capability on one namespace, as a switch.
 *
 * Turning one on is harmless and happens straight away. Turning one off
 * can cut running applications off — from the outside world, or from
 * their buckets — so it asks first, saying what will break.
 */
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { ConfirmDialog } from "gui-mellow/Dialog";
import { Switch } from "gui-mellow/Switch";

import { setNamespaceCapability } from "@/lib/actions";
import { getCapability, type CapabilityId } from "@/lib/capabilities";
import styles from "./CapabilitySwitch.module.scss";

export interface CapabilitySwitchProps {
  namespace: string;
  capability: CapabilityId;
  enabled: boolean;
  // Called once the change has been made, before the page refreshes
  onChanged?: (enabled: boolean) => void;
  // Words beside the switch; "On" and "Off" by default
  label?: string;
}

/**
 * @param props
 * @returns
 */
export function CapabilitySwitch({ namespace, capability: id, enabled, onChanged, label }: CapabilitySwitchProps) {
  const capability = getCapability(id);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(enabled);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const apply = (next: boolean) => {
    setConfirming(false);
    setError(undefined);
    startTransition(async () => {
      setShown(next);
      const result = await setNamespaceCapability(namespace, id, next);
      if (result.ok) {
        onChanged?.(next);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className={styles.wrapper}>
      <Switch
        label={label ?? (shown ? "On" : "Off")}
        checked={shown}
        disabled={pending}
        aria-label={`${capability.title} for ${namespace}`}
        onChange={(event) => (event.target.checked ? apply(true) : setConfirming(true))}
      />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Turn off ${capability.title.toLowerCase()} for ${namespace}?`}
        confirmLabel="Turn off"
        destructive
        onConfirm={() => apply(false)}
        onCancel={() => setConfirming(false)}
      >
        {capability.explanation}
      </ConfirmDialog>
    </div>
  );
}
