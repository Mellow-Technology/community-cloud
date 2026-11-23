"use client";

/**
 * @file
 * A namespace's GitLab CI builds, on its Forges tab: where projects keep
 * their Dockerfile unless they say otherwise, the projects that do, and
 * the key in every include URL. See src/lib/gitlab/builds.ts.
 *
 * Each application's own line to include, and its own Dockerfile path,
 * are on its page (ProjectBuild), since that's where its project is.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { TextField } from "gui-mellow/Field";
import { Table } from "gui-mellow/Table";

import { changeGitLabBuildKey, saveGitLabBuildDefault } from "@/lib/actions";
import { DEFAULT_DOCKERFILE, ciFile, dockerfileProblem, includeSnippet } from "@/lib/gitlab/builds";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.configured whether the namespace has settings, and so a key
 * @param props.dockerfile its default, when it has one
 * @param props.projects projects with a path of their own
 * @param props.exampleUrl an include URL, for a project called group/project
 * @returns
 */
export function GitLabBuilds({
  namespace,
  configured,
  dockerfile,
  projects,
  exampleUrl,
}: {
  namespace: string;
  configured: boolean;
  dockerfile?: string;
  projects: Array<{ project: string; dockerfile: string }>;
  exampleUrl?: string;
}) {
  const router = useRouter();
  const [path, setPath] = useState(dockerfile ?? "");
  const [saving, startSaving] = useTransition();
  const [changing, startChanging] = useTransition();
  const [confirmingKey, setConfirmingKey] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const problem = dockerfileProblem(path);

  const save = () =>
    startSaving(async () => {
      setResult(undefined);
      const saved = await saveGitLabBuildDefault(namespace, path);
      setResult(
        saved.ok
          ? { ok: true, message: configured ? "Saved. It counts from each project's next pipeline." : "Builds are on." }
          : { ok: false, message: saved.error },
      );
      router.refresh();
    });

  const changeKey = () =>
    startChanging(async () => {
      setResult(undefined);
      setConfirmingKey(false);
      const changed = await changeGitLabBuildKey(namespace);
      setResult(
        changed.ok
          ? { ok: true, message: "The key is changed. Copy each application's new include line into its project." }
          : { ok: false, message: changed.error },
      );
      router.refresh();
    });

  return (
    <section className={`${pageStyles.section} ${styles.narrow}`}>
      <h2 className={pageStyles.heading}>GitLab CI builds</h2>
      <div className={styles.fields}>
        <p className={styles.note}>
          Meteorologist serves a GitLab CI build that a project includes with one line in its{" "}
          <code>.gitlab-ci.yml</code>. On every push to the default branch it builds the image with Docker, tags it with
          the commit&apos;s short SHA, which Cirrus looks for, and pushes it to the project&apos;s registry. Each
          application&apos;s page has its line to copy.
        </p>
        <div className={styles.row}>
          <TextField
            label="Dockerfile"
            placeholder={DEFAULT_DOCKERFILE}
            hint="Where projects keep it, from the top of the repository, unless one says otherwise on its application's page."
            error={problem}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </div>
        <div>
          <Button loading={saving} disabled={problem !== undefined} onClick={save}>
            {configured ? "Save" : "Turn on builds"}
          </Button>
        </div>

        {projects.length > 0 && (
          <Table
            columns={["Project", "Its Dockerfile"]}
            rows={projects.map((each) => [
              <code key="project">{each.project}</code>,
              <code key="path">{each.dockerfile}</code>,
            ])}
          />
        )}

        {exampleUrl && (
          <CodeBlock code={includeSnippet(exampleUrl)} language="yaml" title=".gitlab-ci.yml, for group/project" />
        )}

        <Disclosure title="The build it serves">
          <CodeBlock code={ciFile(dockerfile ?? DEFAULT_DOCKERFILE)} language="yaml" title="Included build" />
        </Disclosure>

        {configured && (
          <div className={styles.fields}>
            <p className={styles.note}>
              GitLab fetches the build without signing in, so its address carries a key. Anyone with the address can
              read the build, and nothing else. Changing the key stops every project&apos;s pipelines from starting
              until its include line is replaced.
            </p>
            <div>
              {confirmingKey ? (
                <>
                  <Button variant="danger" loading={changing} onClick={changeKey}>
                    Change it, breaking every include
                  </Button>{" "}
                  <Button variant="ghost" onClick={() => setConfirmingKey(false)}>
                    Keep it
                  </Button>
                </>
              ) : (
                <Button variant="secondary" onClick={() => setConfirmingKey(true)}>
                  Change the key
                </Button>
              )}
            </div>
          </div>
        )}

        {result && (
          <Alert tone={result.ok ? "success" : "danger"} role="status">
            {result.message}
          </Alert>
        )}
      </div>
    </section>
  );
}
