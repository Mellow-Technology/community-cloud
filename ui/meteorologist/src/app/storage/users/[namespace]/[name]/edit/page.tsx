/**
 * @file
 * A user's Edit tab: who it's for, whether it's disabled, and what
 * deleting it does.
 */
import type { Metadata } from "next";

import { UserForm } from "@/components/UserForm";
import { UserShell } from "@/components/UserShell";
import { loadUser } from "@/lib/storage/loadUser";
import { toUserForm } from "@/lib/storage/userForm";
import { identityName } from "@/lib/storage/users";

export const metadata: Metadata = { title: "Edit user" };

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function EditUserPage({ params }: { params: Promise<{ namespace: string; name: string }> }) {
  const { namespace, name } = await params;
  const user = await loadUser(namespace, name);
  return (
    <UserShell user={user} tab="edit">
      {user.identity.ok && (
        <UserForm
          initial={toUserForm(user.identity.value)}
          resourceVersion={user.identity.value.metadata.resourceVersion ?? ""}
          userName={identityName(user.identity.value)}
        />
      )}
    </UserShell>
  );
}
