/**
 * @file
 * Checking a configuration against cc.config.schema.json.
 *
 * The configuration is plain JSON read straight into an untyped
 * object, and for a long time what it could hold was spread over a
 * dozen interfaces, each next to the code that read its section. That
 * told the code what to expect and told nobody writing the file
 * anything. A key spelled slightly wrong, or one an older installer
 * wrote and this one ignores, did nothing and said nothing — the
 * cluster just wasn't configured the way the file read.
 *
 * The schema is one JSON Schema file, so an editor can check the
 * configuration as it's typed, and this reads the same file so that
 * preflight says the same things. It's checked here rather than with a
 * validator library because only a small part of JSON Schema is used,
 * and because what comes out goes in front of people: "should be a
 * list, and it's text" with the key's path, not a JSON pointer and
 * "must be array".
 *
 * Two kinds of finding, kept apart because they deserve different
 * answers. A value of the wrong type, or not one of the values allowed,
 * is a problem: something would read it and do the wrong thing. A key
 * nothing reads is a warning: it does nothing, which is harmless to
 * the install and only misleading to whoever wrote it.
 *
 * What the schema doesn't do is say what's required, or how settings
 * relate to each other — no server, two DNS providers claiming one
 * domain. Preflight says those itself, in terms of the cluster rather
 * than of the file.
 */
import schema from "../../cc.config.schema.json" with { type: "json" };

/**
 * The part of JSON Schema the configuration's schema uses.
 */
interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  deprecated?: boolean;
  deprecationMessage?: string;
  $defs?: Record<string, Schema>;
}

/**
 * What checking a configuration found.
 *
 * - problems: values something would read and get wrong
 * - warnings: keys nothing reads
 */
export interface SchemaFindings {
  problems: string[];
  warnings: string[];
}

const ROOT = schema as Schema;

// How a type reads in a sentence about a value that should have been
// one
const TYPE_NAMES: Record<string, string> = {
  string: "text",
  integer: "a whole number",
  number: "a number",
  boolean: "true or false",
  array: "a list",
  object: "an object",
  null: "null",
};

// How close a key has to be to a real one to be offered as what was
// meant. Two edits catches a transposition or a dropped letter, and
// a short key gets fewer, since "host" is two edits from "port".
const SUGGESTION_DISTANCE = 2;
const SUGGESTION_SHARE = 1 / 3;

/**
 * Check a configuration against the schema.
 *
 * @param raw the configuration as it was read
 * @returns
 */
export function checkSchema(raw: unknown): SchemaFindings {
  const findings: SchemaFindings = { problems: [], warnings: [] };
  check(raw, ROOT, "", findings);
  return findings;
}

/**
 * The schema, for a test that wants to hold it against the code.
 *
 * @returns
 */
export function getConfigSchema(): Schema {
  return ROOT;
}

/**
 * Follow a reference to one of the schema's definitions.
 *
 * @param node
 * @returns
 */
function resolve(node: Schema): Schema {
  if (node.$ref === undefined) {
    return node;
  }

  const name = node.$ref.replace(/^#\/\$defs\//, "");
  const target = ROOT.$defs?.[name];

  if (target === undefined) {
    throw new Error(`The configuration schema refers to "${node.$ref}", which it doesn't define.`);
  }

  return resolve(target);
}

/**
 * The JSON type of a value, as JSON Schema names them.
 *
 * @param value
 * @returns
 */
function typeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }

  return typeof value;
}

/**
 * Whether a value is of a type the schema allows.
 *
 * @param value
 * @param node
 * @returns
 */
function isOfType(value: unknown, node: Schema): boolean {
  if (node.type === undefined) {
    return true;
  }

  const allowed = Array.isArray(node.type) ? node.type : [node.type];
  const actual = typeOf(value);

  // A whole number is a number too
  return allowed.includes(actual) || (actual === "integer" && allowed.includes("number"));
}

/**
 * The types a schema allows, in words.
 *
 * @param nodes
 * @returns
 */
function describeTypes(nodes: Schema[]): string {
  const names = nodes.flatMap((node) => (Array.isArray(node.type) ? node.type : node.type !== undefined ? [node.type] : []));
  return [...new Set(names.map((name) => TYPE_NAMES[name] ?? name))].join(" or ");
}

/**
 * Where a key is, as someone would look for it in the file.
 *
 * An entry in a list is named by its "name" when it has one, since
 * "nodes[3]" means counting and "nodes[mamoru]" doesn't.
 *
 * @param parent
 * @param key
 * @returns
 */
function join(parent: string, key: string): string {
  // Registry hostnames have dots in them, which would read as nesting
  const part = key.includes(".") ? `["${key}"]` : key;

  if (parent === "") {
    return part;
  }

  return part.startsWith("[") ? `${parent}${part}` : `${parent}.${part}`;
}

/**
 * How an entry in a list is named in a path.
 *
 * @param item
 * @param index
 * @returns
 */
function itemLabel(item: unknown, index: number): string {
  const name = item !== null && typeof item === "object" ? (item as Record<string, unknown>)["name"] : undefined;
  return typeof name === "string" && name !== "" ? name : String(index);
}

/**
 * Check one value, and everything inside it.
 *
 * @param value
 * @param node
 * @param path
 * @param findings
 */
function check(value: unknown, node: Schema, path: string, findings: SchemaFindings) {
  const resolved = resolve(node);
  const where = `"${path}"`;

  // A key kept for what older configurations hold. With a message it's
  // said here; without one, something more specific says it.
  if (resolved.deprecated === true) {
    if (resolved.deprecationMessage !== undefined) {
      findings.warnings.push(`${where} ${resolved.deprecationMessage}`);
    }
    return;
  }

  if (resolved.anyOf !== undefined) {
    const branches = resolved.anyOf.map(resolve);
    const fitting = branches.find((branch) => isOfType(value, branch));

    if (fitting === undefined) {
      findings.problems.push(`${where} should be ${describeTypes(branches)}, and it's ${TYPE_NAMES[typeOf(value)]}.`);
      return;
    }

    check(value, fitting, path, findings);
    return;
  }

  // Only the values allowed are worth showing: they're names of
  // things, never secrets
  if (resolved.enum !== undefined) {
    if (!resolved.enum.includes(value)) {
      findings.problems.push(`${where} is ${JSON.stringify(value)}, and has to be one of: ${resolved.enum.join(", ")}.`);
    }
    return;
  }

  // The value itself isn't repeated, since it may well be a password
  // in the wrong place
  if (!isOfType(value, resolved)) {
    findings.problems.push(`${where} should be ${describeTypes([resolved])}, and it's ${TYPE_NAMES[typeOf(value)]}.`);
    return;
  }

  if (typeof value === "string" && resolved.pattern !== undefined && !new RegExp(resolved.pattern).test(value)) {
    findings.problems.push(`${where} isn't in the right form: it should match ${resolved.pattern}.`);
  }

  if (typeof value === "number") {
    if (resolved.minimum !== undefined && value < resolved.minimum) {
      findings.problems.push(`${where} is ${value}, and can't be less than ${resolved.minimum}.`);
    }

    if (resolved.maximum !== undefined && value > resolved.maximum) {
      findings.problems.push(`${where} is ${value}, and can't be more than ${resolved.maximum}.`);
    }
  }

  if (Array.isArray(value) && resolved.items !== undefined) {
    value.forEach((item, index) => check(item, resolved.items!, `${path}[${itemLabel(item, index)}]`, findings));
  }

  if (typeOf(value) === "object") {
    checkObject(value as Record<string, unknown>, resolved, path, findings);
  }
}

/**
 * Check the keys of an object.
 *
 * @param value
 * @param node
 * @param path
 * @param findings
 */
function checkObject(value: Record<string, unknown>, node: Schema, path: string, findings: SchemaFindings) {
  const known = node.properties ?? {};

  for (const [key, entry] of Object.entries(value)) {
    const keyPath = join(path, key);
    const property = known[key];

    if (property !== undefined) {
      check(entry, property, keyPath, findings);
    }
    else if (node.additionalProperties === false) {
      findings.warnings.push(describeUnknown(key, keyPath, Object.keys(known)));
    }
    else if (typeof node.additionalProperties === "object") {
      check(entry, node.additionalProperties, keyPath, findings);
    }
  }
}

/**
 * Say that a key isn't a setting, and what it might have meant.
 *
 * At the top level a key isn't quite nothing: the whole configuration
 * is laid under ".Values", so a manifest could read it. Nothing the
 * installer ships does, and "values" is where such things belong.
 *
 * @param key
 * @param path
 * @param siblings
 * @returns
 */
function describeUnknown(key: string, path: string, siblings: string[]): string {
  const meant = suggest(key, siblings);
  const suggestion = meant !== undefined ? ` Did you mean "${meant}"?` : "";

  return path === key
    ? `"${key}" isn't one of the installer's settings.${suggestion} A value meant for the manifests belongs under "values".`
    : `"${path}" isn't a setting, so nothing reads it.${suggestion}`;
}

/**
 * The real key a mistyped one is closest to, if any is close enough.
 *
 * @param key
 * @param candidates
 * @returns
 */
function suggest(key: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.min(SUGGESTION_DISTANCE, Math.floor(key.length * SUGGESTION_SHARE)) + 1;

  for (const candidate of candidates) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());

    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/**
 * How many single character edits turn one string into another.
 *
 * @param a
 * @param b
 * @returns
 */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];

    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }

    previous = current;
  }

  return previous[b.length]!;
}
