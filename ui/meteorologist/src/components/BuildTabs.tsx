"use client";

/**
 * @file
 * The two GitLab CI builds as tabs, Docker Build and Docker Bake, each
 * with its line to include, where it finds what it builds from, and the
 * file it serves. For the namespace's settings and for a project's own.
 * See src/lib/gitlab/builds.ts.
 *
 * The fields of both tabs are one build, saved together by whatever
 * holds them.
 */
import { useState } from "react";
import { Disclosure } from "gui-mellow/Accordion";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { TextField } from "gui-mellow/Field";
import { ListField } from "gui-mellow/RepeatingField";
import { Tabs } from "gui-mellow/Tabs";

import {
  DEFAULT_BAKE_TARGET,
  DEFAULT_DOCKERFILE,
  bakeTargets,
  buildProblems,
  ciFile,
  includeSnippet,
  type Build,
  type Builder,
} from "@/lib/gitlab/builds";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.build what's being edited
 * @param props.onChange
 * @param props.saved what's served now, for the files shown
 * @param props.inherited what a blank field means, when it's someone
 *   else's rather than the builds' own defaults
 * @param props.urls each build's include URL, once builds are on
 * @param props.includeTitle what the include lines are titled
 * @param props.defaultTab
 * @returns
 */
export function BuildTabs({
  build,
  onChange,
  saved,
  inherited,
  urls,
  includeTitle = ".gitlab-ci.yml",
  defaultTab = "dockerfile",
}: {
  build: Build;
  onChange: (build: Build) => void;
  saved: Build;
  inherited?: Build;
  urls?: Record<Builder, string>;
  includeTitle?: string;
  defaultTab?: Builder;
}) {
  const problems = buildProblems(build);
  // The rows as typed, blank ones included, which the build itself,
  // a list of names, can't hold while one is being added
  const [targets, setTargets] = useState(() => bakeTargets(build));
  const include = (builder: Builder) =>
    urls && <CodeBlock code={includeSnippet(urls[builder])} language="yaml" title={includeTitle} />;
  const file = (builder: Builder) => (
    <Disclosure title="The build it serves">
      <CodeBlock code={ciFile(builder, saved)} language="yaml" title="Included build" />
    </Disclosure>
  );

  return (
    <Tabs<Builder>
      label="GitLab CI builds"
      defaultValue={defaultTab}
      tabs={[
        {
          value: "dockerfile",
          label: "Docker Build",
          content: (
            <div className={styles.fields}>
              <p className={styles.note}>
                <code>docker build</code> with a Dockerfile, in the repository&apos;s top directory.
              </p>
              {include("dockerfile")}
              <div className={styles.row}>
                <TextField
                  label="Dockerfile"
                  placeholder={inherited?.dockerfile ?? DEFAULT_DOCKERFILE}
                  hint="From the top of the repository."
                  error={problems.dockerfile}
                  value={build.dockerfile ?? ""}
                  onChange={(event) => onChange({ ...build, dockerfile: event.target.value })}
                />
              </div>
              {file("dockerfile")}
            </div>
          ),
        },
        {
          value: "bake",
          label: "Docker Bake",
          content: (
            <div className={styles.fields}>
              <p className={styles.note}>
                <code>docker buildx bake</code> with a target from a bake file, or a group of targets, each its own
                image. Their tags are replaced with the commit&apos;s short SHA and latest. One target is pushed to the
                project&apos;s own registry repository; a group&apos;s each go to one of their own under it, target{" "}
                <code>api</code> to <code>&lt;project&gt;/api</code>, so each can be an application of its own.
              </p>
              {include("bake")}
              <div className={styles.row}>
                <TextField
                  label="Bake file"
                  placeholder={inherited?.bakeFile ?? "docker-bake.hcl"}
                  hint="From the top of the repository. Blank is bake's own search: docker-bake.hcl, then compose files."
                  error={problems.bakeFile}
                  value={build.bakeFile ?? ""}
                  onChange={(event) => onChange({ ...build, bakeFile: event.target.value })}
                />
                <TextField
                  label="Main target"
                  placeholder={inherited?.bakeMainTarget ?? "None"}
                  hint="For a group: the target pushed to the project's own repository rather than one of its own, such as the application its other images go with."
                  error={problems.bakeMainTarget}
                  value={build.bakeMainTarget ?? ""}
                  onChange={(event) => onChange({ ...build, bakeMainTarget: event.target.value })}
                />
              </div>
              <ListField
                label="Targets"
                values={targets}
                onChange={(rows) => {
                  setTargets(rows);
                  onChange({ ...build, bakeTarget: rows.join(" ") });
                }}
                placeholder="web"
                addLabel="Add a target"
                empty={`None: ${inherited?.bakeTarget ? `the namespace's, ${inherited.bakeTarget.split(" ").join(", ")}` : `bake's ${DEFAULT_BAKE_TARGET} target`}.`}
                hint="Each target, or group of targets, to build. Several images are each pushed to a repository of their own."
                error={problems.bakeTarget}
              />
              {file("bake")}
            </div>
          ),
        },
      ]}
    />
  );
}
