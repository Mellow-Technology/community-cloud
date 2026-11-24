"use client";

/**
 * @file
 * One application's GitLab CI builds, on its page: the line its
 * project's .gitlab-ci.yml includes for each, ready to copy, and where
 * that project keeps its Dockerfile, bake file and bake target when
 * they aren't where the namespace says. See src/lib/gitlab/builds.ts.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";

import { saveProjectBuild } from "@/lib/actions";
import { buildProblems, normaliseBuild, type Build, type Builder } from "@/lib/gitlab/builds";
import { BuildTabs } from "./BuildTabs";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.project its path, as group/name
 * @param props.own what the project has of its own
 * @param props.namespaceBuild the namespace's, for whatever it hasn't
 * @param props.urls where GitLab fetches each build, once builds are on
 * @param props.imageTag the application's own image tag template, if it has one
 * @returns
 */
export function ProjectBuild({
  namespace,
  project,
  own,
  namespaceBuild,
  urls,
  imageTag,
}: {
  namespace: string;
  project: string;
  own: Build;
  namespaceBuild: Build;
  urls?: Record<Builder, string>;
  imageTag?: string;
}) {
  const router = useRouter();
  const [edited, setEdited] = useState<Build>(own);
  const [saving, startSaving] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const problem = Object.values(buildProblems(edited))[0];
  const changed = JSON.stringify(normaliseBuild(edited)) !== JSON.stringify(normaliseBuild(own));

  const save = () =>
    startSaving(async () => {
      setResult(undefined);
      const saved = await saveProjectBuild(namespace, project, edited);
      setResult(
        saved.ok
          ? { ok: true, message: urls ? "Saved. It counts from the project's next pipeline." : "Builds are on." }
          : { ok: false, message: saved.error },
      );
      router.refresh();
    });

  return (
    <section className={`${pageStyles.section} ${styles.narrow}`}>
      <h2 className={pageStyles.heading}>Building on GitLab CI</h2>
      <div className={styles.fields}>
        <p className={styles.note}>
          {urls ? (
            <>
              Add one of these to the top of <code>{project}</code>&apos;s <code>.gitlab-ci.yml</code>, or make it the
              whole file. Every push to the default branch then builds the image, with its Dockerfile or with bake, and
              pushes it to the project&apos;s registry, tagged with the commit&apos;s short SHA, where Cirrus finds it.
            </>
          ) : (
            <>
              Meteorologist can serve GitLab CI builds for <code>{project}</code> that build its image, with a
              Dockerfile or with bake, and push it where Cirrus finds it. Turning them on gives {namespace} a key for
              the addresses GitLab fetches them from.
            </>
          )}
        </p>
        {imageTag !== undefined && !imageTag.includes("{short_sha}") && (
          <Alert tone="warning">
            This application looks for images tagged <code>{imageTag}</code>, and these builds tag them with the
            commit&apos;s short SHA. Clear its image tag (Edit) so Cirrus finds them from the commit.
          </Alert>
        )}
        <p className={styles.note}>Blank fields are {namespace}&apos;s, set on its Forges tab.</p>
        <BuildTabs
          build={edited}
          onChange={setEdited}
          saved={{ ...namespaceBuild, ...own }}
          inherited={namespaceBuild}
          urls={urls}
          defaultTab={own.bakeFile || own.bakeTarget ? "bake" : "dockerfile"}
        />
        <div>
          <Button loading={saving} disabled={problem !== undefined || (urls !== undefined && !changed)} onClick={save}>
            {urls ? "Save" : "Turn on builds"}
          </Button>
        </div>
        {result && (
          <Alert tone={result.ok ? "success" : "danger"} role="status">
            {result.message}
          </Alert>
        )}
      </div>
    </section>
  );
}
