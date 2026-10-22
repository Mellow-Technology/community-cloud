/**
 * @file
 * Messages laid out a point to a line.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { layOut, splitIntoPoints } from "../util/prose.ts";

describe("splitting a message into points", () => {
  it("breaks after sentences and clauses", () => {
    assert.deepEqual(
      splitIntoPoints("Labels don't match: a is missing; b is missing. Run it again! Why? Nobody knows"),
      ["Labels don't match: a is missing;", "b is missing.", "Run it again!", "Why?", "Nobody knows"],
    );
  });

  it("leaves versions, file names and abbreviations alone", () => {
    assert.deepEqual(
      splitIntoPoints("Found k3s 1.31.2 in /etc/rancher/k3s.yaml, e.g. on cc.example.com. Fine."),
      ["Found k3s 1.31.2 in /etc/rancher/k3s.yaml, e.g. on cc.example.com.", "Fine."],
    );
  });

  it("never breaks inside quotes", () => {
    assert.deepEqual(
      splitIntoPoints('Add "kyle ALL=(ALL) NOPASSWD: ALL. Really; yes" to sudoers. Then retry.'),
      ['Add "kyle ALL=(ALL) NOPASSWD: ALL. Really; yes" to sudoers.', "Then retry."],
    );
  });

  it("keeps the message's own line breaks", () => {
    assert.deepEqual(splitIntoPoints("one\n\ntwo. three"), ["one", "two.", "three"]);
  });
});

describe("laying a message out", () => {
  it("indents every line, wrapped ones included, and keeps inside the width", () => {
    const lines = layOut(
      "Short one. This sentence is rather longer than the room it is given and has to wrap onto more lines.",
      "    ",
      44,
    );

    assert.equal(lines[0], "    Short one.");
    assert.ok(lines.length > 2);

    for (const line of lines) {
      assert.ok(line.startsWith("    ") && !line.startsWith("     "), `"${line}" should be indented exactly`);
      assert.ok(line.length <= 44, `"${line}" is wider than 44`);
    }
  });

  it("breaks a long point after its colon before anywhere else", () => {
    assert.deepEqual(layOut("Available: reno cubic", "", 40), ["Available: reno cubic"]);
    assert.deepEqual(
      layOut('The labels don\'t match what was configured: role/worker-gpu is missing', "", 50),
      ["The labels don't match what was configured:", "role/worker-gpu is missing"],
    );
    assert.deepEqual(
      layOut('Put "a: b" somewhere sensible, and then go on at some length: done', "", 40),
      ['Put "a: b" somewhere sensible, and then', "go on at some length:", "done"],
    );
  });

  it("puts a word wider than the room on a line of its own rather than splitting it", () => {
    const long = "x".repeat(50);

    assert.deepEqual(layOut(`see ${long} here`, "", 30), ["see", long, "here"]);
  });
});
