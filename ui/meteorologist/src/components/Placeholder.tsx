/**
 * @file
 * Placeholders for what's still loading: grey shapes where text will
 * be, so a page shows its layout at once rather than nothing.
 *
 * GUI Mellow has no spinner or placeholder of its own yet, only the
 * spinner inside a loading Button, so these are kept here until it
 * does (GM-15). Each is announced once to screen readers
 * as loading, and the shapes are hidden from them.
 */
import type { CSSProperties } from "react";
import { Table } from "gui-mellow/Table";

import styles from "./Placeholder.module.scss";

/**
 * A grey bar where text will be.
 *
 * @param props
 * @param props.width as CSS, such as "8em" or "60%"
 * @param props.title the height of a heading rather than a line
 * @returns
 */
export function PlaceholderBar({ width, title = false }: { width: string; title?: boolean }) {
  const style: CSSProperties = { width };
  return <span aria-hidden className={`${styles.bar} ${title ? styles.title : ""}`} style={style} />;
}

// Widths that vary from row to row, so rows don't read as one block
const WIDTHS = ["70%", "45%", "85%", "55%", "65%", "40%"];

/**
 * A table of placeholder rows under the columns it will have.
 *
 * @param props
 * @param props.label what's loading, for screen readers: "Loading applications"
 * @param props.columns the headings, as the table will have them
 * @param props.rows how many rows to show
 * @returns
 */
export function PlaceholderTable({ label, columns, rows = 4 }: { label: string; columns: string[]; rows?: number }) {
  return (
    <div role="status" aria-busy="true">
      <span className={styles.hidden}>{label}…</span>
      <div aria-hidden>
        <Table
          columns={columns}
          rows={Array.from({ length: rows }, (_, row) =>
            columns.map((_, column) => (
              <PlaceholderBar key={column} width={WIDTHS[(row + column) % WIDTHS.length] ?? "60%"} />
            )),
          )}
        />
      </div>
    </div>
  );
}

/**
 * A page's header and tabs, for a route that's still loading and
 * doesn't know yet what they'll say.
 *
 * @param props
 * @param props.tabs how many tabs to show
 * @returns
 */
export function PlaceholderHeader({ tabs = 0 }: { tabs?: number }) {
  return (
    <div className={styles.stack} aria-hidden>
      <PlaceholderBar width="14em" title />
      {tabs > 0 && (
        <div className={styles.tabs}>
          {Array.from({ length: tabs }, (_, tab) => (
            <PlaceholderBar key={tab} width="6em" />
          ))}
        </div>
      )}
    </div>
  );
}
