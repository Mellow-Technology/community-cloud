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
import { PROJECT_PAGE, type GitLabConnection, type GitLabProject } from "@/lib/gitlab/connections";
import { projectsFor } from "@/lib/gitlab/projects";
import { matchProjects, mergeProjects } from "@/lib/gitlab/search";
import styles from "./WebApplicationForm.module.scss";

// How long typing has to pause before GitLab is searched, for a
// listing too long to have every project in it
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
  // Every project the connection can see, or GitLab's first page of them
  const [all, setAll] = useState<GitLabProject[]>();
  // What GitLab found for the newest search, when the listing may be
  // missing a match
  const [searched, setSearched] = useState<{ text: string; projects: GitLabProject[] }>();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [problem, setProblem] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [looking, startLooking] = useTransition();
  const chosen = connections.find((each) => each.name === connection);
  // Only the newest search's answer is shown, however the answers arrive
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const truncated = all !== undefined && all.length >= PROJECT_PAGE;

  // The listing the form asked for when it opened, or asked for now.
  // The form keys this by namespace and connection, so a change of
  // either starts afresh rather than showing the last one's projects.
  useEffect(() => {
    if (namespace === "" || connection === "") {
      return;
    }
    let current = true;
    void projectsFor(namespace, connection).then((found) => {
      if (!current) return;
      setProblem(found.ok ? undefined : found.error);
      setAll(found.ok ? found.value : []);
    });
    return () => {
      current = false;
      clearTimeout(timer.current);
    };
  }, [namespace, connection]);

  const find = async (query: string) => {
    const asked = (latest.current += 1);
    setSearching(true);
    const found = await findGitLabProjects(namespace, connection, query);
    if (asked !== latest.current) {
      return;
    }
    setSearching(false);
    if (found.ok) {
      setSearched({ text: query, projects: found.value });
    } else {
      setProblem(found.error);
    }
  };

  // Typing filters the listing straight away. GitLab is only asked,
  // once typing pauses, when the listing was cut short.
  const search = (next: string) => {
    setText(next);
    clearTimeout(timer.current);
    latest.current += 1;
    setSearching(false);
    if (truncated && next.trim() !== "") {
      timer.current = setTimeout(() => void find(next), SEARCH_DELAY_MS);
    }
  };

  const listed =
    all === undefined ? [] : mergeProjects(matchProjects(all, text), searched?.text === text ? searched.projects : []);

  const choose = (path: string) => {
    const picked = listed.find((each) => each.path === path);
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
  const options: ComboboxOption[] = [
    ...(project !== "" && text.trim() === "" && !listed.some((each) => each.path === project)
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
              <a href={`/namespaces/${encodeURIComponent(namespace)}?tab=forges`}>Manage connections</a>
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
            loading={all === undefined || searching}
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
