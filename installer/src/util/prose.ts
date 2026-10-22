/**
 * @file
 * Laying out a message for a terminal.
 *
 * The messages here are written as a few sentences each, so that they
 * say what happened, why, and what to do about it. Printed as one line
 * they wrap wherever the terminal's edge falls, mid-word and back at
 * column zero, and a report of a dozen of them turns into a wall that
 * nobody reads. A sentence a line, kept to the width of the terminal
 * and indented under whatever it belongs to, reads like the list of
 * points it is.
 */

// Words ending in a full stop that don't end a sentence
const ABBREVIATIONS = /(?:^|\s)(?:e\.g|i\.e|etc|vs|cf)\.$/i;

// Where a message turns from one point to the next: a full stop,
// semicolon, question or exclamation mark, followed by a space.
// Version numbers, file names and domains have no space after their
// dots, so they stay whole.
const BOUNDARY = /([.;!?])\s+/g;

/**
 * Split a message into its sentences and clauses.
 *
 * Nothing inside quotes is split, since what's quoted is usually
 * something to copy exactly, like a line for a sudoers file.
 *
 * @param text
 * @returns
 */
export function splitIntoPoints(text: string): string[] {
  const points: string[] = [];

  for (const paragraph of text.split("\n")) {
    let start = 0;

    for (const match of paragraph.matchAll(BOUNDARY)) {
      const end = match.index + match[1]!.length;
      const piece = paragraph.slice(start, end);

      if (insideQuotes(paragraph.slice(0, end)) || ABBREVIATIONS.test(piece)) {
        continue;
      }

      points.push(piece.trim());
      start = match.index + match[0].length;
    }

    points.push(paragraph.slice(start).trim());
  }

  return points.filter((point) => point !== "");
}

/**
 * Break a message into lines no wider than the terminal, a point to a
 * line, each starting with the same indentation.
 *
 * A point too long for the width is wrapped between words, still at
 * that indentation, so nothing ever lands back at the left edge.
 *
 * @param text
 * @param indent what to start every line with
 * @param width the whole width available, indentation included
 * @returns
 */
export function layOut(text: string, indent: string, width: number): string[] {
  // Never narrower than this, however deep the indentation or small
  // the terminal: a column of single words is worse than a wrap
  const room = Math.max(width - indent.length, 30);
  const lines: string[] = [];

  for (const point of splitIntoPoints(text).flatMap((point) => splitLongPoint(point, room))) {
    let line = "";

    for (const word of point.split(/\s+/)) {
      if (line !== "" && line.length + 1 + word.length > room) {
        lines.push(line);
        line = word;
      } else {
        line = line === "" ? word : `${line} ${word}`;
      }
    }

    lines.push(line);
  }

  return lines.map((line) => `${indent}${line}`);
}

/**
 * A point too long for its line, broken after a colon instead of
 * wherever the width runs out.
 *
 * Only when it's too long: "Available: reno cubic" is better on one
 * line, but "labels don't match what was configured: …" followed by
 * the list is better with the list starting on a line of its own.
 *
 * @param point
 * @param room
 * @returns
 */
function splitLongPoint(point: string, room: number): string[] {
  if (point.length <= room) {
    return [point];
  }

  for (const match of point.matchAll(/:\s+/g)) {
    const end = match.index + 1;

    if (!insideQuotes(point.slice(0, end))) {
      return [point.slice(0, end), ...splitLongPoint(point.slice(match.index + match[0].length), room)];
    }
  }

  return [point];
}

/**
 * Whether the end of some text falls inside double quotes.
 *
 * @param text
 * @returns
 */
function insideQuotes(text: string): boolean {
  return ((text.match(/"/g) ?? []).length) % 2 === 1;
}
