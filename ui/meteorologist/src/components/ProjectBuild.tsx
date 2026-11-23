"use client";

/**
 * @file
 * One application's GitLab CI build, on its page: the line its
 * project's .gitlab-ci.yml includes, ready to copy, and where that
 * project keeps its Dockerfile when it isn't the namespace's default.
 * See src/lib/gitlab/builds.ts.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { TextField } from "gui-mellow/Field";

import { saveProjectDockerfile } from "@/lib/actions";
import { ciFile, dockerfileProblem, includeSnippet, normaliseDockerfile } from "@/lib/gitlab/builds";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.project its path, as group/name
 * @param props.own the project's own Dockerfile path, if it has one
 * @param props.defaultDockerfile the namespace's
 * @param props.url where GitLab fetches the build, once builds are on
 * @param props.imageTag the application's own image tag template, if it has one
 * @returns
 */
export function ProjectBuild({
  namespace,
  project,
  own,
  defaultDockerfile,
  url,
  imageTag,
}: {
  namespace: string;
  project: string;
  own?: string;
  defaultDockerfile: string;
  url?: string;
  imageTag?: string;
}) {
  const router = useRouter();
  const [path, setPath] = useState(own ?? "");
  const [saving, startSaving] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const problem = dockerfileProblem(path);
  const changed = normaliseDockerfile(path) !== (own ?? "");

  const save = () =>
    startSaving(async () => {
      setResult(undefined);
      const saved = await saveProjectDockerfile(namespace, project, path);
      setResult(
        saved.ok
          ? { ok: true, message: url ? "Saved. It counts from the project's next pipeline." : "Builds are on." }
          : { ok: false, message: saved.error },
      );
      router.refresh();
    });

  return (
    <section className={`${pageStyles.section} ${styles.narrow}`}>
      <h2 className={pageStyles.heading}>Building on GitLab CI</h2>
      <div className={styles.fields}>
        <p className={styles.note}>
          {url ? (
            <>
              Add this to the top of <code>{project}</code>&apos;s <code>.gitlab-ci.yml</code>, or make it the whole
              file. Every push to the default branch then builds the image and pushes it to the project&apos;s registry,
              tagged with the commit&apos;s short SHA, where Cirrus finds it.
            </>
          ) : (
            <>
              Meteorologist can serve a GitLab CI build for <code>{project}</code> that builds its image and pushes it
              where Cirrus finds it. Turning it on gives {namespace} a key for the address GitLab fetches it from.
            </>
          )}
        </p>
        {imageTag !== undefined && !imageTag.includes("{short_sha}") && (
          <Alert tone="warning">
            This application looks for images tagged <code>{imageTag}</code>, and this build tags them with the
            commit&apos;s short SHA. Clear its image tag (Edit) so Cirrus finds them from the commit.
          </Alert>
        )}
        {url && <CodeBlock code={includeSnippet(url)} language="yaml" title=".gitlab-ci.yml" />}
        <div className={styles.row}>
          <TextField
            label="Dockerfile"
            placeholder={defaultDockerfile}
            hint={`From the top of the repository. Blank is ${namespace}'s default, set on its Forges tab.`}
            error={problem}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
        </div>
        <div>
          <Button loading={saving} disabled={problem !== undefined || (url !== undefined && !changed)} onClick={save}>
            {url ? "Save" : "Turn on builds"}
          </Button>
        </div>
        {result && (
          <Alert tone={result.ok ? "success" : "danger"} role="status">
            {result.message}
          </Alert>
        )}
        {url && (
          <Disclosure title="The build it includes">
            <CodeBlock
              code={ciFile(normaliseDockerfile(own ?? "") || defaultDockerfile)}
              language="yaml"
              title="Included build"
            />
          </Disclosure>
        )}
      </div>
    </section>
  );
}
