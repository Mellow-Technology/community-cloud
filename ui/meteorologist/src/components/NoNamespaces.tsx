/**
 * @file
 * What someone sees before they've been given access to anything:
 * being let in to Meteorologist only takes a "k8s-" group, and having
 * access to a namespace is a separate grant.
 */
import styles from "@/components/page.module.scss";

/**
 * @returns
 */
export function NoNamespaces() {
  return (
    <p className={styles.empty}>
      You don&apos;t have access to any namespaces yet. A cluster admin can give your group access to one.
    </p>
  );
}
