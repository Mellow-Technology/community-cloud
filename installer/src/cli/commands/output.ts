/**
 * @file
 * Reading what a command printed.
 *
 * A shell command can't return a structure, so the ones here that have
 * something to say print it as lines of fields separated by pipes,
 * with the first field naming what kind of line it is:
 *
 *   service|k3s|active
 *   registry|registry.gitlab.com|401|Bearer
 *   pci|0000:01:00.0|0x030000|0x10de|0x2504|nvidia
 *
 * One command often prints more than one kind, which is the point:
 * walking the node once and reporting everything found beats a command
 * per question. This turns that back into something to iterate over.
 */
import { CommandOutput } from "./Command.ts";

/**
 * One line of output: what it is, and what it said.
 */
export interface OutputRecord {
  kind: string;
  fields: string[];
}

/**
 * Split output into non-empty lines.
 *
 * @param output
 * @returns
 */
export function readLines(output: CommandOutput): string[] {
  const text = typeof output.parsed === "string" ? output.parsed : output.stdout;

  return (text !== null && text !== undefined ? text : "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Every record the command printed.
 *
 * @param output
 * @returns
 */
export function readRecords(output: CommandOutput): OutputRecord[] {
  return readLines(output).map((line) => {
    const parts = line.split("|");
    return { kind: parts[0] !== undefined ? parts[0] : "", fields: parts.slice(1) };
  });
}

/**
 * The records of one kind, as their fields.
 *
 * Anything else the command printed is ignored rather than being an
 * error: a command that also echoes something for a person to read
 * shouldn't break the part that reads it.
 *
 * @param output
 * @param kind
 * @returns
 */
export function readRecordsOfKind(output: CommandOutput, kind: string): string[][] {
  return readRecords(output)
    .filter((record) => record.kind === kind)
    .map((record) => record.fields);
}

/**
 * The first record of one kind, when there's at most one.
 *
 * @param output
 * @param kind
 * @returns
 */
export function readRecordOfKind(
  output: CommandOutput,
  kind: string,
): string[] | undefined {
  return readRecordsOfKind(output, kind)[0];
}

/**
 * Read a field out of a record, treating a missing one as empty.
 *
 * The number of fields on a line depends on what the command found, so
 * reading past the end is ordinary rather than exceptional.
 *
 * @param fields
 * @param index
 * @returns
 */
export function field(fields: string[], index: number): string {
  const value = fields[index];
  return value !== undefined ? value : "";
}
