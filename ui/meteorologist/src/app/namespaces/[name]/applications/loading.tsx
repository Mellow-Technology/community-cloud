/**
 * @file
 * The Applications tab while its page is first being read: a header,
 * tabs and the list, as placeholders. Once the namespace is read, the
 * page replaces this, and its list streams in after (see page.tsx).
 */
import { ApplicationListPlaceholder } from "@/components/ApplicationList";
import { PlaceholderHeader } from "@/components/Placeholder";
import { NAMESPACE_TABS } from "@/lib/namespace/tabs";

/**
 * @returns
 */
export default function Loading() {
  return (
    <>
      <PlaceholderHeader tabs={NAMESPACE_TABS.length} />
      <ApplicationListPlaceholder showNamespace={false} />
    </>
  );
}
