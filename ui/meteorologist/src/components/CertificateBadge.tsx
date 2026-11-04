/**
 * @file
 * An application's HTTPS certificate as a coloured dot and a word, with
 * the reason on hover, like its health beside it.
 */
import { StatusDot } from "gui-mellow/StatusDot";
import type { TableCell } from "gui-mellow/Table";

import type { Certificate } from "@/lib/kube/types";
import {
  CERTIFICATE_ORDER,
  certificateStatus,
  findCertificate,
  type CertificateStatus,
} from "@/lib/webapp/certificate";
import type { WebApplication } from "@/lib/webapp/types";
import styles from "./page.module.scss";

/**
 * @param props
 * @param props.status nothing for an application with no hostname
 * @returns
 */
export function CertificateBadge({ status }: { status: CertificateStatus | undefined }) {
  if (status === undefined) {
    return (
      <span className={styles.empty} title="It has no hostname, so it isn't served over HTTPS">
        No hostname
      </span>
    );
  }
  return (
    <StatusDot tone={status.tone} pulse={status.state === "issuing"} title={status.message}>
      {status.label}
    </StatusDot>
  );
}

/**
 * An application's certificate as a table cell, sorting worst first
 * and those with no hostname last.
 *
 * @param app
 * @param certificates every Certificate the page could see
 * @returns
 */
export function certificateCell(app: WebApplication, certificates: Certificate[]): TableCell {
  const status = certificateStatus(app, findCertificate(app, certificates));
  return {
    value: status ? CERTIFICATE_ORDER.indexOf(status.state) : CERTIFICATE_ORDER.length,
    display: <CertificateBadge status={status} />,
  };
}
