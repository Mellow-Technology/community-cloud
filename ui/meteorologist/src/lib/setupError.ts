/**
 * @file
 * What a request gets when Meteorologist isn't set up to answer it.
 *
 * Without this, a missing setting surfaces as an exception thrown from
 * the proxy, which Next shows as a stack trace on every page, naming
 * one setting per restart. This answers with the whole list instead
 * (a ConfigError's message),
 * as plain text, so it reads the same in a browser, in curl, and in a
 * pod's health check.
 */
import { NextResponse } from "next/server";

import { assertConfigured } from "./config";

/**
 * A plain-text error response.
 *
 * @param status
 * @param message
 * @returns
 */
export function textResponse(status: number, message: string): NextResponse {
  return new NextResponse(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/**
 * A response explaining what's missing, or undefined when nothing is.
 *
 * @returns
 */
export function setupProblem(): NextResponse | undefined {
  try {
    assertConfigured();
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      return textResponse(500, error.message);
    }
    throw error;
  }
}
