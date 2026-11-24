"use client";

/**
 * @file
 * A user's access keys: each one's ID, the Secret it's in and how it's
 * doing, its secret half shown on request, and new keys made or old
 * ones deleted. See src/lib/storage/keys.ts.
 *
 * Nothing secret is in the page as it arrives. The secret key is read
 * only when someone asks, through a server action, as them, so only
 * someone allowed to read the Secret ever sees it.
 */
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { CopyButton } from "gui-mellow/CodeBlock";
import { Dialog } from "gui-mellow/Dialog";
import { TextField } from "gui-mellow/Field";
import { SegmentedControl } from "gui-mellow/SegmentedControl";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";

import { createAccessKey, deleteAccessKey, revealSecretKey } from "@/lib/actions";
import { keyDeletion, secretNameProblem } from "@/lib/storage/keys";
import { secretLabel, type ReclaimPolicy, type S3CredentialsSummary } from "@/lib/storage/types";
import { confirmsDeletion } from "@/lib/webapp/deletion";
import actionStyles from "./AppActions.module.scss";
import credentialStyles from "./AdminCredential.module.scss";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * A timestamp, readably, or nothing.
 *
 * @param iso
 * @returns
 */
function when(iso: string | undefined): string {
  return iso
    ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
    : "";
}

/**
 * A key's secret half, shown on request.
 *
 * @param props
 * @param props.namespace
 * @param props.name the S3Credentials'
 * @returns
 */
function SecretKey({ namespace, name }: { namespace: string; name: string }) {
  const [value, setValue] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, startLoading] = useTransition();

  if (value !== undefined) {
    return (
      <span className={credentialStyles.shown}>
        <code className={credentialStyles.value}>{value}</code>
        <CopyButton text={value} />
        <Button variant="ghost" size="sm" onClick={() => setValue(undefined)}>
          Hide
        </Button>
      </span>
    );
  }
  return (
    <span className={credentialStyles.hidden}>
      <Button
        variant="secondary"
        size="sm"
        loading={loading}
        onClick={() =>
          startLoading(async () => {
            setError(undefined);
            const result = await revealSecretKey(namespace, name);
            if (result.ok) {
              setValue(result.value);
            } else {
              setError(result.error);
            }
          })
        }
      >
        Show secret key
      </Button>
      {error !== undefined && (
        <Alert tone="warning" role="status">
          {error}
        </Alert>
      )}
    </span>
  );
}

/**
 * @param props
 * @param props.namespace
 * @param props.identity the S3Identity's resource name
 * @param props.userName its name in SeaweedFS
 * @param props.keys its key pairs
 * @param props.suggestedSecret what a new key's Secret is called unless
 *   another name is typed
 * @returns
 */
export function AccessKeys({
  namespace,
  identity,
  userName,
  keys,
  suggestedSecret,
}: {
  namespace: string;
  identity: string;
  userName: string;
  keys: S3CredentialsSummary[];
  suggestedSecret: string;
}) {
  const router = useRouter();
  const formId = useId();
  const [secretName, setSecretName] = useState("");
  const [reclaimPolicy, setReclaimPolicy] = useState<ReclaimPolicy>("Delete");
  const [creating, startCreating] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [deleting, setDeleting] = useState<S3CredentialsSummary>();
  const [typed, setTyped] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [removing, startRemoving] = useTransition();
  const problem = secretNameProblem(secretName);

  const create = () =>
    startCreating(async () => {
      setResult(undefined);
      const created = await createAccessKey(namespace, identity, secretName, reclaimPolicy);
      if (created.ok) {
        setResult({
          ok: true,
          message: `Asked for a new key. SeaweedFS's operator writes it into ${secretName.trim() || suggestedSecret} in a moment.`,
        });
        setSecretName("");
        router.refresh();
      } else {
        setResult({ ok: false, message: created.error });
      }
    });

  const close = () => {
    setDeleting(undefined);
    setTyped("");
    setDeleteError(undefined);
  };

  const remove = () => {
    if (deleting === undefined || !confirmsDeletion(typed, deleting.name)) {
      return;
    }
    startRemoving(async () => {
      setDeleteError(undefined);
      const removed = await deleteAccessKey(namespace, deleting.name, typed);
      if (removed.ok) {
        close();
        router.refresh();
      } else {
        setDeleteError(removed.error);
      }
    });
  };

  return (
    <>
      <section>
        <h2 className={pageStyles.heading}>Keys</h2>
        {keys.length === 0 ? (
          <p className={pageStyles.empty}>{userName} has no keys, so nothing can sign in as it yet. Make one below.</p>
        ) : (
          <Table
            columns={["Access key", "Secret", "Status", "Made", "Secret key", ""]}
            rows={keys.map((each) => [
              each.accessKey ? <code key="id">{each.accessKey}</code> : <span key="id">Not made yet</span>,
              <code key="secret">{secretLabel(each)}</code>,
              <StatusDot
                key="status"
                tone={each.phase === "Ready" ? "success" : each.phase === "Failed" ? "danger" : "warning"}
                title={each.message}
              >
                {each.phase ?? "Pending"}
              </StatusDot>,
              when(each.createdAt),
              each.phase === "Ready" ? <SecretKey key="reveal" namespace={namespace} name={each.name} /> : "",
              <Button key="delete" variant="ghost" size="sm" onClick={() => setDeleting(each)}>
                Delete
              </Button>,
            ])}
          />
        )}
      </section>

      <section className={`${pageStyles.section} ${styles.narrow}`}>
        <h2 className={pageStyles.heading}>New key</h2>
        <div className={styles.fields}>
          <p className={styles.note}>
            A user can have several keys, so one can be replaced without a gap: make a new one, move whatever uses the
            old one over, then delete the old one.
          </p>
          <div className={styles.row}>
            <TextField
              label="Secret"
              placeholder={suggestedSecret}
              hint={`Where the key pair goes, in ${namespace}, under accessKey and secretKey.`}
              error={problem}
              value={secretName}
              onChange={(event) => setSecretName(event.target.value)}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <p className={styles.note}>When the key is deleted:</p>
          <SegmentedControl
            label="When it's deleted"
            options={[
              { value: "Delete", label: "Take the key out of SeaweedFS" },
              { value: "Retain", label: "Leave it working" },
            ]}
            value={reclaimPolicy}
            onChange={setReclaimPolicy}
          />
          <div>
            <Button loading={creating} disabled={problem !== undefined} onClick={create}>
              Make a key
            </Button>
          </div>
          {result && (
            <Alert tone={result.ok ? "success" : "danger"} role="status">
              {result.message}
            </Alert>
          )}
        </div>
      </section>

      <Dialog
        open={deleting !== undefined}
        onClose={removing ? () => {} : close}
        title={`Delete ${deleting?.name ?? "this key"}?`}
        description={deleting ? keyDeletion(deleting) : ""}
        role="alertdialog"
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="danger"
              type="submit"
              form={formId}
              disabled={deleting === undefined || !confirmsDeletion(typed, deleting.name)}
              loading={removing}
            >
              Delete it
            </Button>
          </>
        }
      >
        <div className={actionStyles.body}>
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              remove();
            }}
          >
            <TextField
              label={
                <>
                  Type <code>{deleting?.name}</code> to confirm
                </>
              }
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={removing}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </form>
          {deleteError && (
            <Alert tone="danger" title="Couldn't delete it">
              {deleteError}
            </Alert>
          )}
        </div>
      </Dialog>
    </>
  );
}
