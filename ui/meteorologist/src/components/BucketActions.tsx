"use client";

/**
 * @file
 * What can be done with a bucket from its page: edit it, or delete it.
 *
 * Deleting asks first, saying whether the contents go too, and only goes
 * ahead once the Bucket's name is typed, as for applications.
 */
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { Dialog } from "gui-mellow/Dialog";
import { TextField } from "gui-mellow/Field";

import { ButtonGroup, type ButtonGroupItem } from "@/components/ButtonGroup";
import { deleteBucket } from "@/lib/actions";
import { confirmsDeletion } from "@/lib/webapp/deletion";
import styles from "./AppActions.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.name the Bucket resource's
 * @param props.editHref
 * @param props.summary what deleting it removes and keeps
 * @param props.deleting already being deleted
 * @param props.canEdit
 * @param props.canDelete
 * @returns
 */
export function BucketActions({
  namespace,
  name,
  editHref,
  summary,
  deleting,
  canEdit,
  canDelete,
}: {
  namespace: string;
  name: string;
  editHref: string;
  summary: { removed: string[]; kept: string[] };
  deleting: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, startDeleting] = useTransition();
  const confirmed = confirmsDeletion(typed, name);

  const close = () => {
    setOpen(false);
    setTyped("");
    setError(undefined);
  };

  const remove = () => {
    if (!confirmed) {
      return;
    }
    setError(undefined);
    startDeleting(async () => {
      const result = await deleteBucket(namespace, name, typed);
      if (result.ok) {
        setOpen(false);
        router.push("/storage");
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const items: ButtonGroupItem[] = [
    ...(canEdit ? [{ id: "edit", label: "Edit", href: editHref, disabled: deleting }] : []),
    ...(canDelete
      ? [{ id: "delete", label: "Delete", tone: "danger" as const, onClick: () => setOpen(true), disabled: deleting }]
      : []),
  ];
  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <ButtonGroup label={`${name} actions`} items={items} />
      <Dialog
        open={open}
        onClose={busy ? () => {} : close}
        title={`Delete ${name}?`}
        description={`It's taken out of ${namespace}. This can't be undone.`}
        role="alertdialog"
        actions={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" form={formId} disabled={!confirmed} loading={busy}>
              Delete {name}
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          <div>
            <h3 className={styles.heading}>Removed</h3>
            <ul className={styles.list}>
              {summary.removed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
          {summary.kept.length > 0 && (
            <div>
              <h3 className={styles.heading}>Kept</h3>
              <ul className={styles.list}>
                {summary.kept.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
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
                  Type <code>{name}</code> to confirm
                </>
              }
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </form>
          {error && (
            <Alert tone="danger" title="Couldn't delete it">
              {error}
            </Alert>
          )}
        </div>
      </Dialog>
    </>
  );
}
