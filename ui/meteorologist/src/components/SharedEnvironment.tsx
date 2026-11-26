"use client";

/**
 * @file
 * A namespace's shared environment values: what several of its
 * applications use, kept once (see src/lib/environment.ts). Plain
 * values are shown; secret ones only by name, with Show reading one on
 * request for whoever may read Secrets. Each says which applications
 * read it, and one still read can't be removed.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { TextField } from "gui-mellow/Field";
import { Switch } from "gui-mellow/Switch";
import { Table } from "gui-mellow/Table";

import { removeSharedValue, revealEnvironmentValue, setSharedValue } from "@/lib/actions";
import { SHARED_ENV, type SharedKind } from "@/lib/environment";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

export interface SharedValue {
  key: string;
  kind: SharedKind;
  // Only for plain ones
  value?: string;
  usedBy: string[];
}

/**
 * @param props
 * @param props.namespace
 * @param props.values
 * @param props.canEdit whether the person may change ConfigMaps and
 *   Secrets here
 * @returns
 */
export function SharedEnvironment({
  namespace,
  values,
  canEdit,
}: {
  namespace: string;
  values: SharedValue[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(false);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, startWork] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();

  const act = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    startWork(async () => {
      setResult(undefined);
      const outcome = await work();
      setResult(outcome.ok ? { ok: true, message: done } : { ok: false, message: outcome.error });
      router.refresh();
    });

  const add = () =>
    act(async () => {
      const saved = await setSharedValue(namespace, name, value, secret ? "secret" : "config");
      if (saved.ok) {
        setName("");
        setValue("");
      }
      return saved;
    }, `Saved ${name.trim()}. Applications reading it restart to pick it up.`);

  const show = (key: string) =>
    startWork(async () => {
      const read = await revealEnvironmentValue(namespace, SHARED_ENV, key);
      if (read.ok) setShown((current) => ({ ...current, [key]: read.value }));
      else setResult({ ok: false, message: read.error });
    });

  return (
    <div className={styles.form}>
      <section className={pageStyles.section}>
        <h2 className={pageStyles.heading}>Shared environment</h2>
        <p className={pageStyles.empty}>
          Values several applications here use, kept once: plain ones in the ConfigMap <code>{SHARED_ENV}</code>, and
          secrets, such as API keys, in the Secret of the same name. An application reads the ones chosen in its form,
          each as a variable of the same name. Changing one restarts the applications reading it.
        </p>
        {values.length === 0 ? (
          <p className={pageStyles.empty}>None yet.</p>
        ) : (
          <Table
            columns={["Name", "Value", "Read by", ""]}
            rows={values.map((each) => [
              <code key="name">{each.key}</code>,
              each.kind === "config" ? (
                <code key="value">{each.value}</code>
              ) : shown[each.key] !== undefined ? (
                <code key="value">{shown[each.key]}</code>
              ) : (
                <span key="value">
                  Secret{" "}
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => show(each.key)}>
                    Show
                  </Button>
                </span>
              ),
              each.usedBy.join(", ") || "Nothing yet",
              canEdit ? (
                <Button
                  key="remove"
                  size="sm"
                  variant="ghost"
                  loading={busy}
                  disabled={each.usedBy.length > 0}
                  title={each.usedBy.length > 0 ? "Applications still read it" : undefined}
                  onClick={() => act(() => removeSharedValue(namespace, each.key, each.kind), `Removed ${each.key}.`)}
                >
                  Remove
                </Button>
              ) : (
                ""
              ),
            ])}
          />
        )}
        {result && (
          <Alert tone={result.ok ? "success" : "danger"} role="status">
            {result.message}
          </Alert>
        )}
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.heading}>Add or change a value</h2>
        {canEdit ? (
          <div className={styles.fields}>
            <div className={styles.row}>
              <TextField
                label="Name"
                placeholder="STRIPE_KEY"
                hint="As an environment variable is named. An existing one is replaced."
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
              <TextField
                label="Value"
                type={secret ? "password" : "text"}
                autoComplete="off"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            <Switch
              label="Secret"
              description="Kept in a Secret, shown only to those who may read Secrets here."
              checked={secret}
              onChange={(event) => setSecret(event.target.checked)}
            />
            <div>
              <Button loading={busy} disabled={name.trim() === ""} onClick={add}>
                Save value
              </Button>
            </div>
          </div>
        ) : (
          <p className={pageStyles.empty}>Changing these takes the namespace&apos;s edit role.</p>
        )}
      </section>
    </div>
  );
}
