"use client";

/**
 * @file
 * The application form's connections: services it connects to, chosen
 * from the ServiceOfferings it may use, with what each will set; and
 * whether it offers itself, and how. See src/lib/offerings.
 */
import { Button } from "gui-mellow/Button";
import { ComboboxField } from "gui-mellow/Combobox";
import { SelectField, TextField } from "gui-mellow/Field";
import { Switch } from "gui-mellow/Switch";

import { connectionEnv, offeringKey, usableOfferings, type OfferingChoice } from "@/lib/offerings/present";
import { PROTOCOLS } from "@/lib/offerings/types";
import type { ConnectionRow, WebApplicationForm as FormModel } from "@/lib/webapp/form";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.form
 * @param props.offerings every offering the person can see
 * @param props.errors the form's, as shown
 * @param props.set
 * @returns
 */
export function ServiceConnections({
  form,
  offerings,
  errors,
  set,
}: {
  form: FormModel;
  offerings: OfferingChoice[];
  errors: Partial<Record<keyof FormModel, string>>;
  set: <K extends keyof FormModel>(key: K, value: FormModel[K]) => void;
}) {
  const usable = usableOfferings(offerings, form.namespace);
  const rows = form.serviceConnections;
  const update = (index: number, change: Partial<ConnectionRow>) =>
    set(
      "serviceConnections",
      rows.map((row, at) => (at === index ? { ...row, ...change } : row)),
    );
  const appName = form.name || "<app>";

  return (
    <div className={styles.fields}>
      <fieldset className={styles.list}>
        <legend className={styles.legend}>Connects to</legend>
        <p className={styles.note}>
          Services other applications offer. Each connection sets environment variables named for it, such as{" "}
          <code>SEARCH_URL</code>, so nothing is copied by hand. {form.namespace || "This namespace"}&apos;s own come
          first, then those other namespaces share with it.
        </p>
        {rows.map((row, index) => {
          const key = row.offering ? `${row.namespace || form.namespace}/${row.offering}` : "";
          const choice = offerings.find((each) => offeringKey(each) === key);
          const env = choice && connectionEnv(choice, row.name, form.namespace);
          const taken = rows
            .filter((_, at) => at !== index)
            .map((each) => `${each.namespace || form.namespace}/${each.offering}`);
          return (
            <div key={index} className={styles.fields}>
              <div className={styles.listRow}>
                <ComboboxField
                  label="Service"
                  className={styles.grow}
                  placeholder="Search services"
                  emptyMessage={
                    form.namespace
                      ? `Nothing offered to ${form.namespace} matches.`
                      : "Choose the namespace first, under Where it lives."
                  }
                  options={[
                    ...usable.map((each) => ({
                      value: offeringKey(each),
                      label: each.title,
                      description: [
                        `${each.namespace}/${each.name}`,
                        each.protocol,
                        each.ready ? undefined : "not ready",
                        each.description,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      disabled: taken.includes(offeringKey(each)),
                    })),
                    // One it already names that isn't usable or visible
                    ...(key && !usable.some((each) => offeringKey(each) === key)
                      ? [
                          {
                            value: key,
                            label: key,
                            description: "Not offered to this namespace, or not visible to you",
                          },
                        ]
                      : []),
                  ]}
                  value={key}
                  onChange={(value) => {
                    const [namespace = "", offering = ""] = value.split("/");
                    update(index, { namespace: namespace === form.namespace ? "" : namespace, offering });
                  }}
                />
                <TextField
                  label="Named"
                  placeholder={row.offering || "search"}
                  hint="What its variables start with."
                  value={row.name}
                  onChange={(event) => update(index, { name: event.target.value })}
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${row.name || row.offering || `connection ${index + 1}`}`}
                  onClick={() =>
                    set(
                      "serviceConnections",
                      rows.filter((_, at) => at !== index),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
              {choice && env && (
                <p className={styles.note}>
                  {choice.description && <>{choice.description} </>}
                  Sets{" "}
                  {env.variables.map((variable, at) => (
                    <span key={variable}>
                      {at > 0 && ", "}
                      <code>{variable}</code>
                    </span>
                  ))}
                  {env.credentials === "given" && " and its credentials, from its Secret"}.
                  {env.credentials === "withheld" &&
                    ` Its credentials stay in ${choice.namespace}: a pod can't read another namespace's Secrets.`}
                  {!choice.ready && " It isn't ready yet, so the application waits for it."}
                </p>
              )}
            </div>
          );
        })}
        {errors.serviceConnections && <p className={styles.error}>{errors.serviceConnections}</p>}
        <div>
          <Button
            variant="secondary"
            size="sm"
            disabled={usable.length === 0}
            onClick={() => set("serviceConnections", [...rows, { offering: "", namespace: "", name: "" }])}
          >
            Add a connection
          </Button>
        </div>
        {usable.length === 0 && (
          <p className={styles.note}>
            Nothing is offered to {form.namespace || "this namespace"} yet. An application offers itself below; anything
            else, with a ServiceOffering.
          </p>
        )}
      </fieldset>

      <Switch
        label="Offer it to other applications"
        checked={form.offers}
        onChange={(event) => set("offers", event.target.checked)}
        description={
          <>
            Cirrus makes a ServiceOffering for its Service, <code>{appName}</code>, so others can pick it here and get
            its address as environment variables.
          </>
        }
      />
      {form.offers && (
        <div className={`${styles.indented} ${styles.fields}`}>
          <div className={styles.row}>
            <TextField
              label="Title"
              placeholder={form.name || "Product search"}
              value={form.offerTitle}
              onChange={(event) => set("offerTitle", event.target.value)}
            />
            <SelectField
              label="Protocol"
              value={form.offerProtocol}
              options={PROTOCOLS.map((protocol) => ({ value: protocol, label: protocol }))}
              onChange={(event) => set("offerProtocol", event.target.value)}
            />
          </div>
          <TextField
            label="What it does"
            placeholder="Full-text search over the catalogue. POST /query with a JSON body."
            hint="Shown to whoever's choosing what to connect to: what it's for, and how to use it."
            value={form.offerDescription}
            onChange={(event) => set("offerDescription", event.target.value)}
          />
          <div className={styles.row}>
            <TextField
              label="Path"
              placeholder="/api"
              hint="Added to its URL, if its API isn't at the root."
              error={errors.offerPath}
              value={form.offerPath}
              onChange={(event) => set("offerPath", event.target.value)}
            />
            <TextField
              label="Shared with"
              placeholder="None"
              hint={`Other namespaces that may connect, beyond ${form.namespace || "its own"}.`}
              error={errors.offerShareWith}
              value={form.offerShareWith}
              onChange={(event) => set("offerShareWith", event.target.value)}
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        </div>
      )}
    </div>
  );
}
