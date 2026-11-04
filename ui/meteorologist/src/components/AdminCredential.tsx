"use client";

/**
 * @file
 * An office application's administrator password, shown on request.
 *
 * Nothing secret is in the page as it arrives. The password is read
 * only when someone asks, through a server action, as them; so only
 * someone allowed to read the Secret ever sees it, and it's gone again
 * when they hide it or leave.
 */
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { CopyButton } from "gui-mellow/CodeBlock";

import { revealAdminCredential } from "@/lib/actions";
import styles from "./AdminCredential.module.scss";

/**
 * @param props
 * @param props.packageName the package whose record names the Secret
 * @param props.label what the credential is, such as "password"
 * @returns
 */
export function AdminCredential({ packageName, label = "password" }: { packageName: string; label?: string }) {
  const [value, setValue] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, startLoading] = useTransition();

  const show = () =>
    startLoading(async () => {
      setError(undefined);
      const result = await revealAdminCredential(packageName);
      if (result.ok) {
        setValue(result.value);
      } else {
        setError(result.error);
      }
    });

  if (value !== undefined) {
    return (
      <span className={styles.shown}>
        <code className={styles.value}>{value}</code>
        <CopyButton text={value} />
        <Button variant="ghost" size="sm" onClick={() => setValue(undefined)}>
          Hide
        </Button>
      </span>
    );
  }

  return (
    <span className={styles.hidden}>
      <Button variant="secondary" size="sm" loading={loading} onClick={show}>
        Show {label}
      </Button>
      {error !== undefined && (
        <Alert tone="warning" role="status">
          {error}
        </Alert>
      )}
    </span>
  );
}
