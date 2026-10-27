/**
 * @file
 * A page's title, with what it's about and what can be done from it.
 *
 * GUI Mellow's Section and Hero head marketing pages: centred, roomy,
 * with no place for a button beside the title. An app's pages want the
 * title and its actions on one line, and a way back up, so this is
 * that, built from the same tokens and the same Eyebrow.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Eyebrow } from "gui-mellow/Eyebrow";

import styles from "./PageHeader.module.scss";

export interface PageHeaderProps {
  title: ReactNode;
  // A line or two under the title
  description?: ReactNode;
  // The small label above the title, such as the namespace
  eyebrow?: ReactNode;
  // Buttons at the far end of the title's line
  actions?: ReactNode;
  // The page this one sits under
  back?: { href: string; label: ReactNode };
}

/**
 * @param props
 * @returns
 */
export function PageHeader({ title, description, eyebrow, actions, back }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      {back && (
        <Link href={back.href} className={styles.back}>
          ← {back.label}
        </Link>
      )}
      <div className={styles.row}>
        <div className={styles.text}>
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h1 className={styles.title}>{title}</h1>
          {description && <p className={styles.description}>{description}</p>}
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
}
