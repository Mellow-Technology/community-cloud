/**
 * @file
 * Commands handed to a login shell that isn't sh.
 *
 * Run through zsh, since that's the login shell that broke them: what
 * reaches it has to come out the other side as the same script, run
 * by sh.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { inPosixShell } from "../util/shell.ts";
import { makeTempDirectory } from "./helpers.ts";

const ZSH = "/bin/zsh";

/**
 * Run a command the way SSH does, as an argument to the login shell.
 *
 * @param command
 * @returns
 */
function throughZsh(command: string): string {
  return execFileSync(ZSH, ["-c", inPosixShell(command)], { encoding: "utf8" });
}

describe("inPosixShell", { skip: !existsSync(ZSH) && "zsh isn't installed here" }, () => {
  it("leaves a glob that matches nothing to the script", () => {
    const temporary = makeTempDirectory("glob");

    try {
      const said = throughZsh(
        `for holder in ${temporary.path}/holders/*; do [ -e "$holder" ] || continue; echo "$holder"; done; echo done`,
      );

      assert.equal(said, "done\n");
    }
    finally {
      temporary.remove();
    }
  });

  it("lets a script use the names zsh keeps for itself", () => {
    assert.equal(throughZsh('status=1; path=/x; echo "$status $path"; command -v sh > /dev/null && echo found'), "1 /x\nfound\n");
  });

  it("passes quotes, variables and newlines through untouched", () => {
    const said = throughZsh(`name='it'"'"'s'\nprintf '%s|%s\\n' "$name" "\${HOME:+set}"`);

    assert.equal(said, "it's|set\n");
  });
});
