/**
 * @file
 * Labelled facts about one thing, such as an application's image and
 * address.
 *
 * GUI Mellow has nothing for a description list: PairList sets two
 * pieces of prose against each other, and a two-column Table reads as
 * data to be compared row by row. This is a plain <dl> in the
 * library's label style.
 */
import type { ReactNode } from "react";

import styles from "./DetailList.module.scss";

export interface Detail {
  label: ReactNode;
  value: ReactNode;
}

/**
 * @param props
 * @param props.items facts with nothing to say are left out
 * @returns
 */
export function DetailList({ items }: { items: Detail[] }) {
  const shown = items.filter((item) => item.value !== undefined && item.value !== null && item.value !== "");
  return (
    <dl className={styles.list}>
      {shown.map((item, index) => (
        <div className={styles.row} key={index}>
          <dt className={styles.label}>{item.label}</dt>
          <dd className={styles.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
