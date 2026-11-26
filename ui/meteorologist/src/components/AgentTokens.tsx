"use client";

/**
 * @file
 * A namespace's agents: what lets an AI agent create and change its
 * applications over MCP. The list, making one, a new token for one,
 * and revoking one. See src/lib/agents/tokens.ts for what an agent is.
 *
 * A token is shown once, straight after it's made, with how to give
 * it to an MCP client, and isn't kept anywhere to show again.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { CodeBlock } from "gui-mellow/CodeBlock";
import { SelectField, TextField } from "gui-mellow/Field";
import { Table } from "gui-mellow/Table";

import { createAgent, deleteAgent, renewAgentToken } from "@/lib/actions";
import {
  AGENT_ROLE,
  DEFAULT_LIFETIME,
  TOKEN_LIFETIMES,
  agentNameProblem,
  clientSetup,
  type Agent,
  type AgentToken,
} from "@/lib/agents/tokens";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * A date as a person reads it.
 *
 * @param iso
 * @returns
 */
function day(iso: string | undefined): string {
  return iso === undefined ? "" : new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * When an agent's newest token expires, or that it has expired.
 *
 * @param agent
 * @returns
 */
function expiry(agent: Agent): string {
  if (agent.tokenExpires === undefined) return "No token made here";
  return new Date(agent.tokenExpires).getTime() < Date.now()
    ? `Expired ${day(agent.tokenExpires)}`
    : `Expires ${day(agent.tokenExpires)}`;
}

/**
 * @param props
 * @param props.namespace
 * @param props.agents
 * @param props.canManage whether the person may bind roles here,
 *   which making and revoking agents takes
 * @param props.publicUrl Meteorologist's address, for the client setup
 * @returns
 */
export function AgentTokens({
  namespace,
  agents,
  canManage,
  publicUrl,
}: {
  namespace: string;
  agents: Agent[];
  canManage: boolean;
  publicUrl: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [days, setDays] = useState(String(DEFAULT_LIFETIME));
  const [busy, startWork] = useTransition();
  const [made, setMade] = useState<{ agent: string } & AgentToken>();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const problem = name.trim() === "" ? undefined : agentNameProblem(name.trim());
  const setup = made && clientSetup(publicUrl, made.token);

  const act = (work: () => Promise<void>) =>
    startWork(async () => {
      setResult(undefined);
      setMade(undefined);
      await work();
      router.refresh();
    });

  const add = () =>
    act(async () => {
      const agent = name.trim();
      const created = await createAgent(namespace, agent, Number(days));
      if (created.ok) {
        setName("");
        setMade({ agent, ...created.value });
      } else {
        setResult({ ok: false, message: created.error });
      }
    });

  const renew = (agent: string) =>
    act(async () => {
      const renewed = await renewAgentToken(namespace, agent, Number(days));
      if (renewed.ok) {
        setMade({ agent, ...renewed.value });
      } else {
        setResult({ ok: false, message: renewed.error });
      }
    });

  const revoke = (agent: string) =>
    act(async () => {
      const removed = await deleteAgent(namespace, agent);
      setResult(
        removed.ok
          ? { ok: true, message: `Revoked ${agent}. None of its tokens work any more.` }
          : { ok: false, message: removed.error },
      );
    });

  return (
    <div className={styles.form}>
      <section className={pageStyles.section}>
        <h2 className={pageStyles.heading}>Agents</h2>
        <p className={pageStyles.empty}>
          An agent token lets an AI agent, such as Claude Code, list, create and change the applications in {namespace}{" "}
          over MCP, as {AGENT_ROLE} does for a person. It works out what an application needs from the project&apos;s
          files, and writes that into the Dockerfile as labels. It can&apos;t delete applications, give them hostnames,
          turn their services off, or read Secrets: those stay with people, here.
        </p>
        {agents.length === 0 ? (
          <p className={pageStyles.empty}>None yet.</p>
        ) : (
          <Table
            columns={["Agent", "Made", "Token", ""]}
            rows={agents.map((agent) => [
              <code key="name">{agent.name}</code>,
              [day(agent.createdAt), agent.createdBy && `by ${agent.createdBy}`].filter(Boolean).join(" "),
              expiry(agent),
              canManage ? (
                <span key="actions" className={styles.buttons}>
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => renew(agent.name)}>
                    New token
                  </Button>
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => revoke(agent.name)}>
                    Revoke
                  </Button>
                </span>
              ) : (
                ""
              ),
            ])}
          />
        )}
        {made && setup && (
          <div className={styles.fields}>
            <Alert tone="success" role="status">
              A token for {made.agent}, good until {day(made.expiresAt)}. It&apos;s shown this once: copy it now. Every
              token for {made.agent} stops working when it&apos;s revoked.
            </Alert>
            <CodeBlock code={setup.command} language="sh" title="Claude Code" wrap />
            <CodeBlock code={setup.json} language="json" title="Other MCP clients" />
          </div>
        )}
        {result && (
          <Alert tone={result.ok ? "success" : "danger"} role="status">
            {result.message}
          </Alert>
        )}
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.heading}>Add an agent</h2>
        {canManage ? (
          <div className={styles.fields}>
            <div className={styles.row}>
              <TextField
                label="Name"
                placeholder="claude"
                hint="Its ServiceAccount's name, which shows in the cluster's audit log beside what it does."
                error={problem}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
              <SelectField
                label="Token lasts"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                options={TOKEN_LIFETIMES.map((each) => ({
                  value: String(each),
                  label: each === 365 ? "A year" : `${each} days`,
                }))}
              />
            </div>
            <div>
              <Button loading={busy} disabled={name.trim() === "" || problem !== undefined} onClick={add}>
                Add agent
              </Button>
            </div>
          </div>
        ) : (
          <p className={pageStyles.empty}>
            Making an agent gives it a role in the namespace, which only the namespace&apos;s admins and cluster admins
            can do.
          </p>
        )}
      </section>
    </div>
  );
}
