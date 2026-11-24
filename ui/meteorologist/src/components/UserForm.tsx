"use client";

/**
 * @file
 * Changing an S3Identity, SeaweedFS's S3 user. See
 * src/lib/storage/userForm.ts for what can change.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { TextField } from "gui-mellow/Field";
import { SegmentedControl } from "gui-mellow/SegmentedControl";
import { Switch } from "gui-mellow/Switch";

import { saveS3Identity } from "@/lib/actions";
import { storageTabHref } from "@/lib/storage/tabs";
import { validateUserForm, type UserForm as Form } from "@/lib/storage/userForm";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.initial
 * @param props.resourceVersion the version the form was opened with
 * @param props.userName its name in SeaweedFS, for what's said about it
 * @returns
 */
export function UserForm({
  initial,
  resourceVersion,
  userName,
}: {
  initial: Form;
  resourceVersion: string;
  userName: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string>();
  const errors = validateUserForm(form);
  const shown = attempted ? errors : {};
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));

  const submit = () => {
    setAttempted(true);
    setError(undefined);
    if (Object.keys(errors).length > 0) {
      return;
    }
    startSaving(async () => {
      const saved = await saveS3Identity(form, resourceVersion);
      if (saved.ok) {
        router.push(storageTabHref("users", form.namespace));
        router.refresh();
      } else {
        setError(saved.error);
      }
    });
  };

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      noValidate
    >
      <section>
        <h2 className={pageStyles.heading}>Who it&apos;s for</h2>
        <div className={styles.fields}>
          <div className={styles.row}>
            <TextField
              label="Display name"
              placeholder="None"
              error={shown.displayName}
              value={form.displayName}
              onChange={(event) => set({ displayName: event.target.value })}
            />
            <TextField
              label="Email"
              type="email"
              placeholder="None"
              error={shown.email}
              value={form.email}
              onChange={(event) => set({ email: event.target.value })}
            />
          </div>
          <p className={styles.note}>For people to tell users apart; SeaweedFS doesn&apos;t send anything to it.</p>
        </div>
      </section>

      <section>
        <h2 className={pageStyles.heading}>Access</h2>
        <div className={styles.fields}>
          <Switch
            label="Disabled"
            description={`Refuses every request made with ${userName}'s keys, without taking away its keys or its access to buckets, so turning it back on restores both.`}
            checked={form.disabled}
            onChange={(event) => set({ disabled: event.target.checked })}
          />
        </div>
      </section>

      <section>
        <h2 className={pageStyles.heading}>When it&apos;s deleted</h2>
        <div className={styles.fields}>
          <SegmentedControl
            label="Reclaim policy"
            options={[
              { value: "Delete", label: "Delete the user" },
              { value: "Retain", label: "Keep the user" },
            ]}
            value={form.reclaimPolicy}
            onChange={(reclaimPolicy) => set({ reclaimPolicy })}
          />
          <p className={styles.note}>
            {form.reclaimPolicy === "Delete"
              ? `Deleting the S3Identity takes ${userName} out of SeaweedFS, and its keys stop working.`
              : `Deleting the S3Identity leaves ${userName} in SeaweedFS, with keys that still work, until someone removes it there.`}
          </p>
        </div>
      </section>

      <div className={styles.footer}>
        {attempted && Object.keys(errors).length > 0 && (
          <Alert tone="danger" title="Some fields need another look" role="alert">
            {Object.values(errors)[0]}
          </Alert>
        )}
        {error && (
          <Alert tone="danger" title="Couldn't save it" role="alert">
            {error}
          </Alert>
        )}
        <div className={styles.buttons}>
          <Button type="submit" loading={saving}>
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}
