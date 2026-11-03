/**
 * @file
 * Meteorologist's mark, a weathervane, for the header.
 *
 * The same drawing as src/app/icon.svg, inline rather than an <img> so
 * it follows Meteorologist's own light and dark switch: the favicon can
 * only go by the system's setting. The vane points into the wind, at
 * 37°, with two streaks coming off its tail.
 *
 * Only one is ever on a page, so its gradients' ids are fixed.
 */
import styles from "./WeathervaneMark.module.scss";

export interface WeathervaneMarkProps {
  size?: number;
  className?: string;
}

/**
 * @param props
 * @returns
 */
export function WeathervaneMark({ size = 28, className }: WeathervaneMarkProps) {
  return (
    <svg
      viewBox="-3.3 1.3 31.3 31.3"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={[styles.mark, className].filter(Boolean).join(" ")}
    >
      <defs>
        <linearGradient id="mark-shaft" gradientUnits="userSpaceOnUse" x1="-12" y1="0" x2="7" y2="0">
          <stop offset="0" className={styles.blue} stopOpacity="0.45" />
          <stop offset="1" className={styles.blue} />
        </linearGradient>
        <linearGradient id="mark-tail" gradientUnits="userSpaceOnUse" x1="-14" y1="0" x2="-6" y2="0">
          <stop offset="0" className={styles.blue} stopOpacity="0.3" />
          <stop offset="1" className={styles.blue} stopOpacity="0.75" />
        </linearGradient>
        <linearGradient id="mark-head" gradientUnits="userSpaceOnUse" x1="6" y1="0" x2="14" y2="0">
          <stop offset="0" className={styles.red} stopOpacity="0.85" />
          <stop offset="1" className={styles.red} />
        </linearGradient>
        <linearGradient id="mark-wind" gradientUnits="userSpaceOnUse" x1="-22" y1="0" x2="-9" y2="0">
          <stop offset="0" className={styles.blue} stopOpacity="0" />
          <stop offset="1" className={styles.blue} stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <path d="M16 13 V28 M11 28 H21" className={styles.stroke} strokeWidth="2.6" strokeLinecap="round" />
      <g transform="translate(16 13) rotate(-37)">
        <path d="M-9.5 -6.6 H-21" stroke="url(#mark-wind)" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M-11 6.6 H-22.5" stroke="url(#mark-wind)" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M-11 0 H7" stroke="url(#mark-shaft)" strokeWidth="2.6" strokeLinecap="round" />
        <path
          d="M-14 -4.6 H-9.4 L-6.6 0 L-9.4 4.6 H-14 L-11.4 0 Z"
          fill="url(#mark-tail)"
          stroke="url(#mark-tail)"
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
        <path
          d="M14 0 L6 -5 V5 Z"
          fill="url(#mark-head)"
          stroke="url(#mark-head)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <path d="M14 0 L6 -5 V0 Z" fill="#ffffff" fillOpacity="0.28" />
      </g>
      <circle cx="16" cy="13" r="2.2" className={styles.fill} />
    </svg>
  );
}
