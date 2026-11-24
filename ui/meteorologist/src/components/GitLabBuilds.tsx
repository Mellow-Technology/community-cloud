"use client";

/**
 * @file
 * A namespace's GitLab CI builds, on its Forges tab: where projects
 * keep their Dockerfile, bake file and bake target unless they say
 * otherwise, the projects that do, and the key in every include URL.
 * See src/lib/gitlab/builds.ts.
 *
 * Each application's own lines to include, and its own paths, are on
 * its page (ProjectBuild), since that's where its project is.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { Table } from "gui-mellow/Table";

import { changeGitLabBuildKey, saveGitLabBuildDefault } from "@/lib/actions";
import { buildProblems, describeBuild, type Build, type Builder } from "@/lib/gitlab/builds";
import { BuildTabs } from "./BuildTabs";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.configured whether the namespace has settings, and so a key
 * @param props.build where its projects' builds find things unless they say otherwise
 * @param props.projects projects with something of their own
 * @param props.exampleUrls each build's include URL, for a project called group/project
 * @returns
 */
export function GitLabBuilds({
  namespace,
  configured,
  build,
  projects,
  exampleUrls,
}: {
  namespace: string;
  configured: boolean;
  build: Build;
  projects: Array<{ project: string; build: Build }>;
  exampleUrls?: Record<Builder, string>;
}) {
  const router = useRouter();
  const [edited, setEdited] = useState(build);
  const [saving, startSaving] = useTransition();
  const [changing, startChanging] = useTransition();
  const [confirmingKey, setConfirmingKey] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const problem = Object.values(buildProblems(edited))[0];

  const save = () =>
    startSaving(async () => {
      setResult(undefined);
      const saved = await saveGitLabBuildDefault(namespace, edited);
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
          Meteorologist serves two GitLab CI builds, one with a Dockerfile and one with <code>docker buildx bake</code>,
          and a project includes whichever it uses with one line in its <code>.gitlab-ci.yml</code>. On every push to
          the default branch it builds the image, tags it with the commit&apos;s short SHA, which Cirrus looks for, and
          pushes it to the project&apos;s registry. These are where projects keep what they build from, unless one says
          otherwise on its application&apos;s page, which also has its lines to copy.
        </p>
        <BuildTabs
          build={edited}
          onChange={setEdited}
          saved={build}
          urls={exampleUrls}
          includeTitle=".gitlab-ci.yml, for a project called group/project"
        />
        <div>
          <Button loading={saving} disabled={problem !== undefined} onClick={save}>
            {configured ? "Save" : "Turn on builds"}
          </Button>
        </div>

        {projects.length > 0 && (
          <Table
            columns={["Project", "Its own"]}
            rows={projects.map((each) => [
              <code key="project">{each.project}</code>,
              <code key="build">{describeBuild(each.build)}</code>,
            ])}
          />
        )}

        {configured && (
          <div className={styles.fields}>
            <p className={styles.note}>
              GitLab fetches the builds without signing in, so their addresses carry a key. Anyone with an address can
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
