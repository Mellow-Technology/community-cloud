/**
 * @file
 * A user's Access Keys tab: its key pairs, each in a Secret, with the
 * secret half shown on request, and new ones made or old ones deleted.
 */
import type { Metadata } from "next";
import { Alert } from "gui-mellow/Alert";

import { AccessKeys } from "@/components/AccessKeys";
import { ErrorNotice } from "@/components/ErrorNotice";
import styles from "@/components/page.module.scss";
import { UserShell } from "@/components/UserShell";
import { loadUser } from "@/lib/storage/loadUser";
import { newKeyNames } from "@/lib/storage/keys";
import { identityName } from "@/lib/storage/users";

export const metadata: Metadata = { title: "Access keys" };

/**
 * @param props
 * @param props.params
 * @param props.searchParams
 * @returns
 */
export default async function UserKeysPage({
  params,
  searchParams,
}: {
  params: Promise<{ namespace: string; name: string }>;
  // Set by the Add user form when the user was made and its key wasn't
  searchParams: Promise<{ keyError?: string }>;
}) {
  const { namespace, name } = await params;
  const { keyError } = await searchParams;
  const user = await loadUser(namespace, name);
  return (
    <UserShell user={user} tab="keys">
      {keyError && (
        <Alert tone="warning" title="The user was made, but not its key" className={styles.stats}>
          {keyError.slice(0, 500)} Make one below.
        </Alert>
      )}
      {user.identity.ok &&
        (user.keys?.ok ? (
          <AccessKeys
            namespace={user.namespace}
            identity={user.name}
            userName={identityName(user.identity.value)}
            keys={user.keys.value}
            suggestedSecret={newKeyNames(user.name, user.namespaceKeys ?? []).secretName}
          />
        ) : (
          <ErrorNotice error={user.keys?.ok === false ? user.keys.error : undefined} title="Couldn't list its keys" />
        ))}
    </UserShell>
  );
}
