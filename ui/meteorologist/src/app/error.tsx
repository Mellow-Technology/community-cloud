"use client";

/**
 * @file
 * What's shown when a page fails outright. Reads from the cluster are
 * caught by the pages themselves, so reaching this means something
 * else broke, most likely a setting.
 */
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";

import { PageHeader } from "@/components/PageHeader";

/**
 * @param props
 * @param props.error
 * @param props.reset
 * @returns
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <PageHeader title="Something went wrong" />
      <Alert
        tone="danger"
        title="This page couldn't be shown"
        actions={
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
        }
      >
        {error.message || "The server logged the details."}
        {error.digest && <> (reference {error.digest})</>}
      </Alert>
    </>
  );
}
