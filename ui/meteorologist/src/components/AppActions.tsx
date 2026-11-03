"use client";

/**
 * @file
 * What can be done with an application from its page: open it, edit it,
 * or delete it.
 *
 * Deleting asks first, in a dialog that says what goes and what stays,
 * and only goes ahead once the application's name is typed. A delete
 * can't be undone, and the wrong application is one tab away from the
 * right one, so pressing a button twice isn't enough.
 */
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { Dialog } from "gui-mellow/Dialog";
import { TextField } from "gui-mellow/Field";

import { ButtonGroup, type ButtonGroupItem } from "@/components/ButtonGroup";
import { deleteWebApplication } from "@/lib/actions";
import { confirmsDeletion, type DeletionSummary } from "@/lib/webapp/deletion";
import styles from "./AppActions.module.scss";

export interface AppActionsProps {
  namespace: string;
  name: string;
  // Where it answers, once Cirrus has said
  url?: string;
  editHref: string;
  summary: DeletionSummary;
  // Already being deleted, so there's nothing more to do with it
  deleting: boolean;
}

/**
 * @param props
 * @returns
 */
export function AppActions({ namespace, name, url, editHref, summary, deleting }: AppActionsProps) {
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
      const result = await deleteWebApplication(namespace, name, typed);
      if (result.ok) {
        setOpen(false);
        router.push("/apps");
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };

  const items: ButtonGroupItem[] = [
    ...(url ? [{ id: "open", label: "Open ↗", href: url, target: "_blank", rel: "noreferrer" }] : []),
    { id: "edit", label: "Edit", href: editHref, disabled: deleting },
    { id: "delete", label: "Delete", tone: "danger", onClick: () => setOpen(true), disabled: deleting },
  ];

  return (
    <>
      <ButtonGroup label={`${name} actions`} items={items} />
      <Dialog
        open={open}
        onClose={busy ? () => {} : close}
        title={`Delete ${name}?`}
        description={`It's taken out of ${namespace}, along with what Cirrus made for it. This can't be undone.`}
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
