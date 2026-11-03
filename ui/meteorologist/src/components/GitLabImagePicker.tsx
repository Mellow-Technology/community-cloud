"use client";

/**
 * @file
 * Choosing an application's image from GitLab: a connection, one of
 * the projects its token can see, and one of that project's registry
 * repositories.
 *
 * Choosing fills in the form's image, and the project, instance and
 * connection Cirrus needs to update it, so none of them is typed. The
 * image stays editable, since a pipeline may push somewhere the
 * registry doesn't list yet.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { ComboboxField, type ComboboxOption } from "gui-mellow/Combobox";
import { SelectField } from "gui-mellow/Field";

import { findGitLabImages, findGitLabProjects } from "@/lib/actions";
import type { GitLabConnection, GitLabProject } from "@/lib/gitlab/connections";
import styles from "./WebApplicationForm.module.scss";

// How long typing has to pause before GitLab is searched
const SEARCH_DELAY_MS = 250;

export interface GitLabChoice {
  connection: string;
  url: string;
  project: GitLabProject;
  image?: string;
}

/**
 * @param props
 * @param props.namespace
 * @param props.connections the namespace's GitLab connections
 * @param props.connection the one chosen
 * @param props.project the chosen project's path, if one is
 * @param props.image the image the form has now
 * @param props.error
 * @param props.onConnection
 * @param props.onChoose given the project, and the image to run when
 *   the registry suggests one
 * @param props.onImage given an image picked from the registry
 * @returns
 */
export function GitLabImagePicker({
  namespace,
  connections,
  connection,
  project,
  image,
  error,
  onConnection,
  onChoose,
  onImage,
}: {
  namespace: string;
  connections: GitLabConnection[];
  connection: string;
  project: string;
  image: string;
  error?: string;
  onConnection: (connection: GitLabConnection) => void;
  onChoose: (choice: GitLabChoice) => void;
  onImage: (image: string) => void;
}) {
  const [projects, setProjects] = useState<GitLabProject[]>();
  const [images, setImages] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();
  const [searching, setSearching] = useState(false);
  // What the shown projects were searched for
  const [query, setQuery] = useState("");
  const [looking, startLooking] = useTransition();
  const chosen = connections.find((each) => each.name === connection);
  // Only the newest search's answer is shown, however the answers arrive
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const find = async (text: string) => {
    const asked = (latest.current += 1);
    setSearching(true);
    const found = await findGitLabProjects(namespace, connection, text);
    if (asked !== latest.current) {
      return;
    }
    setSearching(false);
    setQuery(text);
    setProblem(found.ok ? undefined : found.error);
    setProjects(found.ok ? found.value : undefined);
  };

  // Typing searches GitLab once it pauses, rather than on every key
  const search = (text: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void find(text), SEARCH_DELAY_MS);
  };

  // The newest projects, as soon as there's a connection to ask with.
  // The form keys this by namespace and connection, so a change of
  // either starts afresh rather than showing the last one's projects.
  useEffect(() => {
    if (namespace !== "" && connection !== "") {
      search("");
    }
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, connection]);

  const choose = (path: string) => {
    const picked = projects?.find((each) => each.path === path);
    if (picked === undefined || chosen === undefined) {
      return;
    }
    startLooking(async () => {
      setProblem(undefined);
      const found = await findGitLabImages(namespace, connection, picked);
      if (found.ok) {
        setImages(found.value.images);
        onChoose({ connection, url: chosen.url, project: picked, image: found.value.suggested });
      } else {
        setImages([]);
        onChoose({ connection, url: chosen.url, project: picked });
        setProblem(found.error);
      }
    });
  };

  // The chosen project stays listed, unless a search has left it out
  const listed = projects ?? [];
  const options: ComboboxOption[] = [
    ...(project !== "" && query === "" && !listed.some((each) => each.path === project)
      ? [{ value: project, label: project }]
      : []),
    ...listed.map((each) => ({ value: each.path, label: each.path, description: each.name })),
  ];

  return (
    <div className={styles.fields}>
      <SelectField
        label="GitLab connection"
        required
        value={connection}
        error={connection === "" ? error : undefined}
        hint={
          <>
            A token kept in {namespace || "the namespace"}.{" "}
            {namespace !== "" && (
              <a href={`/namespaces/${encodeURIComponent(namespace)}?tab=integration`}>Manage connections</a>
            )}
          </>
        }
        onChange={(event) => {
          const next = connections.find((each) => each.name === event.target.value);
          if (next !== undefined) {
            onConnection(next);
          }
        }}
        options={[
          { value: "", label: "Choose a connection", disabled: true },
          ...connections.map((each) => ({
            value: each.name,
            label: `${each.name} (${each.url.replace(/^https?:\/\//, "")})`,
          })),
        ]}
      />
      {connection !== "" && (
        <>
          <ComboboxField
            label="Project"
            required
            placeholder="Search by name or path"
            value={project}
            options={options}
            filter={false}
            loading={searching}
            onInputChange={search}
            onChange={choose}
            emptyMessage="The token can't see a project matching that. Is it a member of the project?"
            error={error}
            hint={looking ? "Looking in its container registry…" : "The most recently active first. Type to search."}
          />
          {images.length > 1 && (
            <SelectField
              label="Registry repository"
              hint="The project's registry has several. Choose the one this application runs."
              value={images.includes(image) ? image : ""}
              onChange={(event) => onImage(event.target.value)}
              options={[
                { value: "", label: "Choose one", disabled: true },
                ...images.map((each) => ({ value: each, label: each })),
              ]}
            />
          )}
        </>
      )}
      {problem && (
        <Alert tone="danger" role="alert">
          {problem}
        </Alert>
      )}
    </div>
  );
}
