"use client";

/**
 * @file
 * Making one of SeaweedFS's S3 users, an S3Identity, with its first key
 * if asked. See src/lib/storage/userForm.ts.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { SelectField, TextField } from "gui-mellow/Field";
import { SegmentedControl } from "gui-mellow/SegmentedControl";
import { Switch } from "gui-mellow/Switch";

import type { BucketNamespaceChoice } from "@/components/BucketForm";
import { createS3User } from "@/lib/actions";
import { defaultUserName, validateNewUserForm, type NewUserForm as Form } from "@/lib/storage/userForm";
import { userTabHref } from "@/lib/storage/userTabs";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.initial
 * @param props.namespaces where it could go
 * @returns
 */
export function NewUserForm({ initial, namespaces }: { initial: Form; namespaces: BucketNamespaceChoice[] }) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string>();
  const errors = validateNewUserForm(form);
  const shown = attempted ? errors : {};
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));
  const chosen = namespaces.find((each) => each.name === form.namespace);
  const name = form.name.trim();

  const submit = () => {
    setAttempted(true);
    setError(undefined);
    if (Object.keys(errors).length > 0) {
      return;
    }
    startSaving(async () => {
      const created = await createS3User(form);
      if (!created.ok) {
        setError(created.error);
        return;
      }
      const { namespace, name, keyError } = created.value;
      if (keyError !== undefined) {
        // The user's there; say why the key isn't, where one can be made
        router.push(`${userTabHref(namespace, name, "keys")}?keyError=${encodeURIComponent(keyError)}`);
      } else {
        // With a key, straight to where its secret half can be seen
        router.push(userTabHref(namespace, name, form.createKey ? "keys" : "edit"));
      }
      router.refresh();
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
        <h2 className={pageStyles.heading}>The user</h2>
        <div className={styles.fields}>
          <div className={styles.row}>
            <SelectField
              label="Namespace"
              value={form.namespace}
              error={shown.namespace}
              onChange={(event) => set({ namespace: event.target.value })}
              options={[
                { value: "", label: "Choose one" },
                ...namespaces.map((each) => ({ value: each.name, label: each.name })),
              ]}
            />
            <TextField
              label="Name"
              hint="The S3Identity resource's name in the namespace."
              error={shown.name}
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          {chosen && !chosen.allowsBuckets && (
            <Alert tone="warning">
              SeaweedFS only takes users from namespaces with the Buckets capability, which {chosen.name} doesn&apos;t
              have. The user would be saved, but stay Pending until it does.
            </Alert>
          )}
          <TextField
            label="Name in SeaweedFS"
            hint="What its access is given to on a bucket. Every namespace's users share one list, so it starts with the namespace's name unless another is typed. It can't be changed later."
            placeholder={form.namespace && name ? defaultUserName(form.namespace, name) : undefined}
            error={shown.userName}
            value={form.userName}
            onChange={(event) => set({ userName: event.target.value })}
            autoCapitalize="none"
            spellCheck={false}
          />
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
        </div>
      </section>

      <section>
        <h2 className={pageStyles.heading}>Its first key</h2>
        <div className={styles.fields}>
          <Switch
            label="Make a key with it"
            description="Nothing can use a user until it has a key. Its secret half can be seen on the user's Access Keys tab."
            checked={form.createKey}
            onChange={(event) => set({ createKey: event.target.checked })}
          />
          {form.createKey && (
            <div className={`${styles.indented} ${styles.fields}`}>
              <div className={styles.row}>
                <TextField
                  label="Secret"
                  placeholder={name ? `${name}-s3` : undefined}
                  hint={`Where the key pair goes, in ${form.namespace || "the namespace"}, under accessKey and secretKey.`}
                  error={shown.secretName}
                  value={form.secretName}
                  onChange={(event) => set({ secretName: event.target.value })}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
              <p className={styles.note}>When the key is deleted:</p>
              <SegmentedControl
                label="When the key is deleted"
                options={[
                  { value: "Delete", label: "Take the key out of SeaweedFS" },
                  { value: "Retain", label: "Leave it working" },
                ]}
                value={form.keyReclaimPolicy}
                onChange={(keyReclaimPolicy) => set({ keyReclaimPolicy })}
              />
            </div>
          )}
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
              ? "Deleting the S3Identity takes the user out of SeaweedFS, and its keys stop working."
              : "Deleting the S3Identity leaves the user in SeaweedFS, with keys that still work, until someone removes it there."}
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
          <Alert tone="danger" title="Couldn't make it" role="alert">
            {error}
          </Alert>
        )}
        <div className={styles.buttons}>
          <Button type="submit" loading={saving}>
            {form.createKey ? "Add user and key" : "Add user"}
          </Button>
        </div>
      </div>
    </form>
  );
}
