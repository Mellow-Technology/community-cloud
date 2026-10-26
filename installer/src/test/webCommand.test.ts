/**
 * @file
 * What a web command says when an API turns it down.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import WebCommand from "../cli/commands/WebCommand.ts";
import { WebCommandSpec } from "../cli/commands/Command.ts";
import { DEFINED_API_ERRORS } from "../cli/commands/NebulaNetwork.ts";
import { configFrom } from "./helpers.ts";

const CONFIG = configFrom({ nodes: [] });
const REFUSED = '{"errors":[{"code":"ERR_UNAUTHORIZED","message":"unauthorized"}]}';

/**
 * Run a command against an API that always answers the same way, and
 * return why it failed.
 */
async function refusal(status: number, extra: Partial<WebCommandSpec> = {}): Promise<string> {
  const command = new WebCommand({ name: "t", description: "", url: "https://api.example.test/x", ...extra });

  command.setQuiet(true);
  command.setFetchFunction(async () => new Response(REFUSED, { status }));

  try {
    await command.exec(CONFIG, {} as any, {});
  } catch (error: any) {
    return error.stderr;
  }

  assert.fail("the request should have failed");
}

describe("an API that turns a request down", () => {
  it("is explained in words when the command knows what the code means", async () => {
    const why = await refusal(401, { explainStatus: DEFINED_API_ERRORS });

    assert.match(why, /refused the API key/);
    // What the API said is still there, after the explanation
    assert.match(why, /ERR_UNAUTHORIZED/);
  });

  it("is passed on as it was when the command doesn't", async () => {
    assert.equal(await refusal(401), REFUSED);
  });

  it("is passed on as it was for a code the command has no words for", async () => {
    assert.equal(await refusal(500, { explainStatus: DEFINED_API_ERRORS }), REFUSED);
  });
});
