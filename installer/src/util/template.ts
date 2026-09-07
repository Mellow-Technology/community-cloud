/**
 * @file
 * Rendering of the Go style templates used by the manifests in k8s/.
 *
 * The manifests are written the way Helm charts are, so alongside plain
 * ".Values.some.path" references they use a handful of Helm's pipeline
 * helpers. @ctrl/golang-template only understands paths and control tags
 * (if/with/range/join/index/re_replace), so we resolve the pipelines
 * ourselves first and hand it a template it can render.
 *
 * This is deliberately not a Helm implementation. It covers the helpers
 * the manifests actually use, and anything else raises an error naming
 * the tag rather than rendering something surprising.
 */
import { parse } from "@ctrl/golang-template";

// Tags that @ctrl/golang-template handles on its own.
// A tag opening with any of these is left untouched.
const CONTROL_TAG = /^(?:if|else|end|with|range|join|index|re_replace)\b|^\.$/;

// Everything between a pair of braces. Tags can't contain "}}"
// so a non-greedy match gives us one tag at a time.
const TEMPLATE_TAG = /{{(.*?)}}/gs;

// The printf verbs the manifests use. Go supports a great deal
// more, but there's no reason to guess at what isn't in use.
const PRINTF_VERB = /%[sdv%]/g;

/**
 * Render a template with the supplied values.
 *
 * @param source
 * @param values
 * @returns
 */
export function renderTemplate(source: string, values: Record<string, any>): string {
  return parse(resolvePipelines(source, values), values);
}

/**
 * Resolve every tag that uses a function or a pipeline, leaving
 * plain paths and control tags for the template library.
 *
 * @param source
 * @param values
 * @returns
 */
function resolvePipelines(source: string, values: Record<string, any>): string {
  return source.replace(TEMPLATE_TAG, (tag, body) => {
    const expression = body.trim();

    // Control flow belongs to the library
    if (CONTROL_TAG.test(expression)) {
      return tag;
    }

    // So does a bare path, which is the common case
    if (!expression.includes("|") && !expression.includes(" ")) {
      return tag;
    }

    return renderPipeline(expression, values);
  });
}

/**
 * Evaluate a pipeline, e.g. `printf "auth@%s" .Values.domain.main | quote`
 *
 * @param expression
 * @param values
 * @returns
 */
function renderPipeline(expression: string, values: Record<string, any>): string {
  const stages = splitStages(expression);

  let value = evaluateStage(stages[0], values);
  for (let i = 1; i < stages.length; i++) {
    value = applyFunction(stages[i], value, values);
  }

  // Go renders a missing value as nothing, and so does the
  // template library, so we stay consistent with both
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Split a pipeline on the pipes that separate its stages,
 * ignoring any that appear inside a quoted string.
 *
 * @param expression
 * @returns
 */
function splitStages(expression: string): string[] {
  const stages = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < expression.length; i++) {
    const character = expression[i];

    if (character === '"') {
      quoted = !quoted;
    }

    if (character === "|" && !quoted) {
      stages.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  stages.push(current.trim());
  return stages.filter((stage) => stage.length > 0);
}

/**
 * Evaluate the first stage of a pipeline, which produces the
 * value the rest of the stages operate on.
 *
 * @param stage
 * @param values
 * @returns
 */
function evaluateStage(stage: string, values: Record<string, any>) {
  const tokens = tokenize(stage);

  if (tokens[0] === "printf") {
    return formatPrintf(tokens.slice(1), values);
  }

  if (tokens.length === 1) {
    return resolveArgument(tokens[0], values);
  }

  throw new Error(`Unsupported template expression: "${stage}"`);
}

/**
 * Apply one of the supported functions to the value coming
 * down the pipeline.
 *
 * @param stage
 * @param value
 * @param values
 * @returns
 */
function applyFunction(stage: string, value: any, values: Record<string, any>) {
  const [name, ...args] = tokenize(stage);

  switch (name) {
    // Wrap in double quotes, escaping as needed, so that a value
    // lands in the manifest as a string and nothing else
    case "quote":
      return JSON.stringify(value === undefined || value === null ? "" : String(value));

    // Fall back to the supplied value when the configuration
    // doesn't set one
    case "default":
      return isEmpty(value) ? resolveArgument(args[0], values) : value;

    case "printf":
      // In a pipeline the incoming value is printf's last argument
      return formatPrintf([...args, value], values, true);

    default:
      throw new Error(
        `Unsupported template function "${name}". Supported functions are: quote, default, printf.`,
      );
  }
}

/**
 * Substitute arguments into a Go printf format string.
 *
 * @param tokens the format string followed by its arguments
 * @param values
 * @param argsResolved whether the arguments are already values rather than tokens
 * @returns
 */
function formatPrintf(tokens: any[], values: Record<string, any>, argsResolved = false): string {
  if (tokens.length === 0) {
    throw new Error("printf needs a format string");
  }

  const format = String(resolveArgument(tokens[0], values));
  const args = tokens
    .slice(1)
    .map((token) => (argsResolved && typeof token !== "string" ? token : resolveArgument(token, values)));

  let index = 0;
  return format.replace(PRINTF_VERB, (verb) => {
    if (verb === "%%") {
      return "%";
    }

    const argument = args[index];
    index++;
    return argument === undefined || argument === null ? "" : String(argument);
  });
}

/**
 * Turn a single token into a value. Tokens are either quoted
 * literals, numbers, or paths into the value set.
 *
 * @param token
 * @param values
 * @returns
 */
function resolveArgument(token: any, values: Record<string, any>) {
  if (typeof token !== "string") {
    return token;
  }

  if (token.startsWith('"')) {
    return unquote(token);
  }

  if (token.startsWith(".")) {
    return lookup(token, values);
  }

  if (token !== "" && !Number.isNaN(Number(token))) {
    return Number(token);
  }

  return token;
}

/**
 * Follow a dotted path such as ".Values.domain.main" into
 * the value set.
 *
 * @param path
 * @param values
 * @returns
 */
function lookup(path: string, values: Record<string, any>) {
  const segments = path.split(".").filter((segment) => segment.length > 0);

  let current: any = values;
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

/**
 * Split a stage into its tokens, keeping quoted strings whole.
 *
 * @param stage
 * @returns
 */
function tokenize(stage: string): string[] {
  const tokens = stage.match(/"(?:[^"\\]|\\.)*"|\S+/g);
  return tokens !== null ? tokens : [];
}

/**
 * Strip the surrounding quotes from a literal.
 *
 * @param token
 * @returns
 */
function unquote(token: string): string {
  return token.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Whether a value counts as unset for the purposes of `default`.
 *
 * @param value
 * @returns
 */
function isEmpty(value: any): boolean {
  return value === undefined || value === null || value === "" || value === false;
}
