"use client";

/**
 * @file
 * Making or changing a SeaweedFS Bucket. See src/lib/storage/form.ts
 * for what it turns into, and what can only be chosen when a bucket is
 * made.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { ComboboxField } from "gui-mellow/Combobox";
import { SelectField, TextField } from "gui-mellow/Field";
import { SegmentedControl } from "gui-mellow/SegmentedControl";
import { Switch } from "gui-mellow/Switch";

import { saveBucket } from "@/lib/actions";
import { defaultBucketName, validateBucketForm, type BucketForm as Form } from "@/lib/storage/form";
import { BUCKET_ACTIONS, type Bucket, type BucketAction } from "@/lib/storage/types";
import { accessOptions, type UserChoice } from "@/lib/storage/users";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * A namespace a bucket could go in, and what the form needs to know
 * about it.
 */
export interface BucketNamespaceChoice {
  name: string;
  // Whether SeaweedFS takes buckets from it: the Buckets capability
  allowsBuckets: boolean;
}

// What each action lets a user do, in a few words
const ACTION_HINTS: Record<BucketAction, string> = {
  Read: "get objects",
  Write: "put and delete objects",
  List: "list what's there",
  Tagging: "tag objects",
  Admin: "everything, including the bucket's settings",
};

/**
 * @param props
 * @param props.initial
 * @param props.existing the bucket being edited, if it is
 * @param props.namespaces where it could go, or, editing, where it is
 * @param props.users every S3 user the person can see, to give access to
 * @returns
 */
export function BucketForm({
  initial,
  existing,
  namespaces,
  users,
}: {
  initial: Form;
  existing?: Bucket;
  namespaces: BucketNamespaceChoice[];
  users: UserChoice[];
}) {
  const router = useRouter();
  const editing = existing !== undefined;
  const [form, setForm] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [saving, startSaving] = useTransition();
  const [error, setError] = useState<string>();
  const errors = validateBucketForm(form, existing);
  const shown = attempted ? errors : {};
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));
  const chosen = namespaces.find((each) => each.name === form.namespace);
  const wasVersioned = (existing?.status?.versioning ?? existing?.spec.versioning ?? "Off") !== "Off";

  const submit = () => {
    setAttempted(true);
    setError(undefined);
    if (Object.keys(errors).length > 0) {
      return;
    }
    startSaving(async () => {
      const saved = await saveBucket(form, existing?.metadata.resourceVersion);
      if (saved.ok) {
        router.push(`/storage/${encodeURIComponent(saved.value.namespace)}/${encodeURIComponent(saved.value.name)}`);
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
      {!editing && (
        <section>
          <h2 className={pageStyles.heading}>The bucket</h2>
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
                hint="The Bucket resource's name in the namespace."
                error={shown.name}
                value={form.name}
                onChange={(event) => set({ name: event.target.value })}
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            {chosen && !chosen.allowsBuckets && (
              <Alert tone="warning">
                SeaweedFS only makes buckets for namespaces with the Buckets capability, which {chosen.name}{" "}
                doesn&apos;t have. The Bucket would be saved, but stay Pending until it does.
              </Alert>
            )}
            <TextField
              label="Name in SeaweedFS"
              hint="What S3 clients call it. Every namespace's buckets share one list, so it starts with the namespace's name unless another is typed. It can't be changed later."
              placeholder={
                form.namespace && form.name ? defaultBucketName(form.namespace, form.name.trim()) : undefined
              }
              error={shown.bucketName}
              value={form.bucketName}
              onChange={(event) => set({ bucketName: event.target.value })}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </section>
      )}

      <section>
        <h2 className={pageStyles.heading}>Size</h2>
        <div className={styles.fields}>
          <div className={styles.row}>
            <TextField
              label="Quota"
              placeholder="No limit"
              hint="Such as 20Gi. Blank is no limit, beyond SeaweedFS's own space."
              error={shown.quota}
              value={form.quota}
              onChange={(event) => set({ quota: event.target.value })}
            />
          </div>
          {form.quota.trim() !== "" && (
            <Switch
              label="Enforce it"
              description="Refuse writes once the bucket is full. Off, the quota is only reported."
              checked={form.enforceQuota}
              onChange={(event) => set({ enforceQuota: event.target.checked })}
            />
          )}
        </div>
      </section>

      <section>
        <h2 className={pageStyles.heading}>Versions and locking</h2>
        <div className={styles.fields}>
          <SegmentedControl
            label="Versioning"
            options={[
              { value: "Off", label: "Off" },
              { value: "Enabled", label: "On" },
              { value: "Suspended", label: "Suspended" },
            ]}
            value={form.versioning}
            onChange={(versioning) => set({ versioning })}
          />
          <p className={styles.note}>
            Keeps every version of an object, so an overwrite or delete can be undone.
            {wasVersioned
              ? " It's been on for this bucket, so it can be suspended but not turned off."
              : " Once on, it can be suspended but never turned off again."}
          </p>
          {shown.versioning && <p className={styles.error}>{shown.versioning}</p>}
          {editing ? (
            existing.spec.objectLock && (
              <p className={styles.note}>Object lock is on, which can&apos;t be changed after a bucket is made.</p>
            )
          ) : (
            <>
              <Switch
                label="Object lock"
                description="Lets objects be locked against deletion for a time. Needs versioning on, and can only be chosen now."
                checked={form.objectLock}
                onChange={(event) =>
                  set({ objectLock: event.target.checked, ...(event.target.checked ? { versioning: "Enabled" } : {}) })
                }
              />
              {shown.objectLock && <p className={styles.error}>{shown.objectLock}</p>}
            </>
          )}
        </div>
      </section>

      <section>
        <h2 className={pageStyles.heading}>Access</h2>
        <div className={styles.fields}>
          <p className={styles.note}>
            The S3 users that may use it, and what each may do. User names are one list across SeaweedFS, so a user from
            any namespace can be given access; those in the bucket&apos;s own namespace are listed first. Users are
            added on the Storage page&apos;s Users tab.
          </p>
          <fieldset className={styles.list}>
            <legend className={styles.legend}>Users</legend>
            {form.access.length === 0 && <p className={styles.note}>No one yet, beyond SeaweedFS&apos;s admins.</p>}
            {form.access.map((row, index) => (
              <div key={index} className={styles.fields}>
                <div className={styles.listRow}>
                  <ComboboxField
                    label="User"
                    className={styles.grow}
                    placeholder="Search users"
                    emptyMessage="No user by that name. Add one on the Users tab."
                    options={accessOptions(
                      users,
                      form.namespace,
                      row.user,
                      form.access.filter((_, at) => at !== index).map((each) => each.user),
                    )}
                    value={row.user}
                    onChange={(user) =>
                      set({
                        access: form.access.map((old, at) => (at === index ? { ...old, user } : old)),
                      })
                    }
                  />
                  <Button variant="ghost" onClick={() => set({ access: form.access.filter((_, at) => at !== index) })}>
                    Remove
                  </Button>
                </div>
                <div className={styles.buttons} role="group" aria-label={`What ${row.user || "this user"} may do`}>
                  {BUCKET_ACTIONS.map((action) => (
                    <Switch
                      key={action}
                      label={action}
                      description={ACTION_HINTS[action]}
                      checked={row.actions.includes(action)}
                      onChange={(event) =>
                        set({
                          access: form.access.map((old, at) =>
                            at === index
                              ? {
                                  ...old,
                                  actions: event.target.checked
                                    ? [...old.actions, action]
                                    : old.actions.filter((each) => each !== action),
                                }
                              : old,
                          ),
                        })
                      }
                    />
                  ))}
                </div>
                {shown[`access.${index}`] && <p className={styles.error}>{shown[`access.${index}`]}</p>}
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => set({ access: [...form.access, { user: "", actions: ["Read", "Write", "List"] }] })}
              >
                Add a user
              </Button>
            </div>
          </fieldset>
          <Switch
            label="Anyone may read it"
            description="Objects can be fetched by name without keys, by anyone who can reach SeaweedFS. Listing still needs keys."
            checked={form.anonymousRead}
            onChange={(event) => set({ anonymousRead: event.target.checked })}
          />
        </div>
      </section>

      <section>
        <h2 className={pageStyles.heading}>When it&apos;s deleted</h2>
        <div className={styles.fields}>
          <SegmentedControl
            label="Reclaim policy"
            options={[
              { value: "Retain", label: "Keep the contents" },
              { value: "Delete", label: "Delete the contents" },
            ]}
            value={form.reclaimPolicy}
            onChange={(reclaimPolicy) => set({ reclaimPolicy })}
          />
          <p className={styles.note}>
            {form.reclaimPolicy === "Retain"
              ? "Deleting the Bucket resource leaves the bucket and everything in it in SeaweedFS."
              : "Deleting the Bucket resource deletes the bucket in SeaweedFS and everything in it. That can't be undone."}
          </p>
        </div>
      </section>

      <Disclosure title="Placement and more">
        <div className={styles.fields}>
          <div className={styles.row}>
            <TextField
              label="Replication"
              placeholder="SeaweedFS's default"
              hint="Three digits: copies in other data centers, other racks, and the same rack. 001 keeps two copies."
              error={shown.replication}
              value={form.replication}
              onChange={(event) => set({ replication: event.target.value })}
            />
            <TextField
              label="Time to live"
              placeholder="Forever"
              hint="Objects expire after this, such as 30d: m, h, d, w, M or y."
              error={shown.ttl}
              value={form.ttl}
              onChange={(event) => set({ ttl: event.target.value })}
            />
            <TextField
              label="Disk type"
              placeholder="Any"
              hint="Only volume servers' disks of this type, such as ssd."
              value={form.diskType}
              onChange={(event) => set({ diskType: event.target.value })}
            />
          </div>
          {!editing && (
            <Switch
              label="Take over an existing bucket"
              description="If SeaweedFS already has a bucket by this name, manage it rather than failing. For one made before, or kept when its Bucket was deleted."
              checked={form.adoptExisting}
              onChange={(event) => set({ adoptExisting: event.target.checked })}
            />
          )}
        </div>
      </Disclosure>

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
            {editing ? "Save changes" : "Create bucket"}
          </Button>
        </div>
      </div>
    </form>
  );
}
