/**
 * @file
 * A row of related actions, drawn like GUI Mellow's SegmentedControl.
 *
 * SegmentedControl is a radio group, for choosing one of a few options:
 * arrow keys move the selection, and each move is a change. Used for
 * actions, arrowing from Open to Delete would open the application and
 * then its edit page on the way. These are real links and buttons
 * instead, each its own Tab stop, and nothing happens until one is
 * pressed. Meant for GUI Mellow (GM-14), and here until it's there.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./ButtonGroup.module.scss";

export interface ButtonGroupItem {
  id: string;
  label: ReactNode;
  // A link when given, opened in place unless a target says otherwise
  href?: string;
  target?: string;
  rel?: string;
  // A button otherwise
  onClick?: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
}

export interface ButtonGroupProps {
  items: ButtonGroupItem[];
  // Names the group for assistive technology
  label: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * @param props
 * @returns
 */
export function ButtonGroup({ items, label, size = "md", className }: ButtonGroupProps) {
  return (
    <div role="group" aria-label={label} className={[styles.group, styles[size], className].filter(Boolean).join(" ")}>
      {items.map((item) => {
        const classes = [styles.item, item.tone === "danger" && styles.danger].filter(Boolean).join(" ");

        if (item.href !== undefined && !item.disabled) {
          // An address outside Meteorologist is a plain link; Link is
          // for its own pages
          return /^[a-z]+:\/\//i.test(item.href) ? (
            <a key={item.id} href={item.href} target={item.target} rel={item.rel} className={classes}>
              {item.label}
            </a>
          ) : (
            <Link key={item.id} href={item.href} target={item.target} rel={item.rel} className={classes}>
              {item.label}
            </Link>
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            className={classes}
            onClick={item.onClick}
            disabled={item.disabled || (item.href === undefined && item.onClick === undefined)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
