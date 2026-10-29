"use client";

/**
 * @file
 * A namespace's GitLab connections: the list, removing one, and
 * adding one from a token pasted in.
 *
 * Adding checks the token with GitLab before anything is saved, by
 * listing the projects it can see, so a mistyped or under-scoped token
 * is found here rather than as an empty project list in the
 * application form.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { TextField } from "gui-mellow/Field";
import { Table } from "gui-mellow/Table";

import { createGitLabConnection, deleteGitLabConnection } from "@/lib/actions";
import { suggestedName, tokenPages, type GitLabConnection } from "@/lib/gitlab/connections";
import { DEFAULT_GITLAB_URL } from "@/lib/webapp/types";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.connections
 * @param props.usedBy the applications updating through each, by connection
 * @returns
 */
export function GitLabConnections({
  namespace,
  connections,
  usedBy,
}: {
  namespace: string;
  connections: GitLabConnection[];
  usedBy: Record<string, string[]>;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(DEFAULT_GITLAB_URL);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [adding, startAdding] = useTransition();
  const [removing, startRemoving] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const connectionName = name.trim() || suggestedName(url);
  const pages = tokenPages(url);

  const add = () =>
    startAdding(async () => {
      setResult(undefined);
      const created = await createGitLabConnection(namespace, connectionName, url, token);
      if (created.ok) {
        setToken("");
        setName("");
        setResult({
          ok: true,
          message:
            created.value.projects === 0
              ? `Added ${connectionName}, but the token can't see any projects yet. Add its user to the projects, or give it a wider scope.`
              : `Added ${connectionName}. Its token can see ${created.value.projects === 50 ? "50 or more" : created.value.projects} project${created.value.projects === 1 ? "" : "s"}.`,
        });
        router.refresh();
      } else {
        setResult({ ok: false, message: created.error });
      }
    });

  const remove = (connection: string) =>
    startRemoving(async () => {
      setResult(undefined);
      const removed = await deleteGitLabConnection(namespace, connection);
      setResult(removed.ok ? { ok: true, message: `Removed ${connection}.` } : { ok: false, message: removed.error });
      router.refresh();
    });

  return (
    <div className={styles.form}>
      <section className={pageStyles.section}>
        <h2 className={pageStyles.heading}>GitLab connections</h2>
        {connections.length === 0 ? (
          <p className={pageStyles.empty}>None yet. Add one below, and applications here can choose their project.</p>
        ) : (
          <Table
            columns={["Connection", "GitLab", "Used by", ""]}
            rows={connections.map((connection) => [
              <code key="name">{connection.name}</code>,
              connection.url,
              (usedBy[connection.name] ?? []).join(", ") || "Nothing yet",
              <Button
                key="remove"
                size="sm"
                variant="ghost"
                loading={removing}
                disabled={(usedBy[connection.name] ?? []).length > 0}
                title={(usedBy[connection.name] ?? []).length > 0 ? "Applications still update through it" : undefined}
                onClick={() => remove(connection.name)}
              >
                Remove
              </Button>,
            ])}
          />
        )}
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.heading}>Add a GitLab connection</h2>
        <div className={styles.fields}>
          <div className={`${styles.note} ${styles.noteBlock}`}>
            <p>
              Meteorologist uses the token to list projects and their images, and Cirrus uses it to keep a webhook on
              each application&apos;s project and to look up pipelines and image digests. Any of these kinds works:
            </p>
            <ul>
              <li>
                A <strong>group access token</strong>, from the group&apos;s Settings → Access tokens (
                <a href={pages.groups} target="_blank" rel="noreferrer">
                  your groups
                </a>
                ), with the <code>api</code> scope and the Maintainer role. It reaches every project in the group and
                belongs to the group, so it keeps working whoever leaves. Usually the best choice.
              </li>
              <li>
                A <strong>project access token</strong>, from the project&apos;s Settings → Access tokens, with the same
                scope and role. Only that one project is listed.
              </li>
              <li>
                A{" "}
                <a href={pages.personal} target="_blank" rel="noreferrer">
                  fine-grained personal token
                </a>
                , with these permissions:
                <ul>
                  <li>
                    Under <em>User</em>: Project: Read, which is what lists projects
                  </li>
                  <li>
                    Under <em>Group and project</em>, for the groups or projects it&apos;s for:
                    <ul>
                      <li>Project: Read</li>
                      <li>Webhook: Read, Create, Update and Delete</li>
                      <li>Pipeline: Read</li>
                      <li>Container Repository: Read</li>
                    </ul>
                  </li>
                </ul>
                Whoever makes it has to be a Maintainer of those projects, since GitLab also checks what they may do,
                and it stops working if they lose that.
              </li>
            </ul>
            <p>
              A token with only <code>read_api</code> lists projects, but Cirrus can&apos;t register its webhook with
              it, so images are only found by checking every few minutes. Pulling images is separate: that uses the
              namespace&apos;s registry credentials, which only need <code>read_registry</code>.
            </p>
          </div>
          <div className={styles.row}>
            <TextField
              label="GitLab"
              placeholder={DEFAULT_GITLAB_URL}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <TextField
              label="Name"
              placeholder={connectionName}
              hint="The Secret it's kept in."
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <TextField
            label="Access token"
            type="password"
            autoComplete="off"
            hint={`Checked with GitLab, then kept in a Secret in ${namespace} and nowhere else.`}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <div>
            <Button loading={adding} disabled={token.trim() === ""} onClick={add}>
              Add connection
            </Button>
          </div>
          {result && (
            <Alert tone={result.ok ? "success" : "danger"} role="status">
              {result.message}
            </Alert>
          )}
        </div>
      </section>
    </div>
  );
}
