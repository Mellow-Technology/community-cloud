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
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { parse } from "@ctrl/golang-template";
import { parse as parseYaml } from "yaml";

import CloudConfig from "./CloudConfig.ts";
import { GatewayMode, NodeRole } from "./types.ts";
import { asCiliumDevices } from "./interfaces.ts";
import { isEmbeddedPath, readEmbeddedFile } from "./embedded.ts";
import { getValueContributors, resolveFile } from "./fileResolvers.ts";
import {
  STORAGE_NODE_SELECTOR,
  buildShape,
  buildShapeSelector,
  getStorageShapes,
  readShape,
} from "./storage.ts";

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

  let value = evaluateStage(stages[0] ?? "", values);
  for (let i = 1; i < stages.length; i++) {
    value = applyFunction(stages[i] ?? "", value, values);
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

// The port a K3s API server listens on unless it's been configured
// to do otherwise
const DEFAULT_K8S_API_PORT = "6443";

// Where the device classes are declared. Read here to work out which
// nodes can serve which of them, and read again by the LVM bundle to
// know which volume groups to create.
const TOPOLVM_VALUES_FILE = "embed://storage/TopoLVM/TopoLVM.values.yaml";

/**
 * Build the value set handed to the template renderer.
 *
 * The manifests in k8s/ are written Helm style, so everything they
 * reference is reached through ".Values". Values come from the
 * "values" section of the configuration when there is one and from
 * the top level of the configuration otherwise, which lets a
 * configuration keep its values alongside its node list or in a
 * section of their own.
 *
 * @param config
 * @returns
 */
export function buildTemplateValues(config: CloudConfig, context?: any) {
  const rawConfig = config.getConfig();
  const values = {
    ...rawConfig,
    ...(rawConfig.values !== undefined ? rawConfig.values : {}),
  };

  // The API server lives on the control plane node, so we derive it
  // rather than make a configuration repeat what the node list
  // already says
  if (values.k8sApiServer === undefined) {
    const controlPlane = getControlPlaneHost(config);
    if (controlPlane !== undefined) {
      // The address other nodes reach the API on, which isn't always
      // the one we administer the node through
      values.k8sApiServer =
        controlPlane.apiAddress !== undefined
          ? controlPlane.apiAddress
          : controlPlane.address;
    }
  }

  if (values.k8sApiPort === undefined) {
    values.k8sApiPort = DEFAULT_K8S_API_PORT;
  }

  // Cilium only answers for a load balancer address on the LAN when
  // it was installed with that switched on, and whether it should be
  // follows from how the cluster is reached rather than being another
  // thing to remember to set. Always given a value, since a missing
  // one renders as nothing and leaves Helm an empty setting.
  if (values.l2Announcements === undefined) {
    values.l2Announcements = announcesGatewayAddresses(rawConfig);
  }

  // Which interfaces Cilium's datapath attaches to. Taken from the one
  // list rather than written out in the values file, so that Cilium
  // and the gateway's ARP announcements agree about what counts as an
  // interface on this node.
  if (values.networkDevices === undefined) {
    values.networkDevices = asCiliumDevices();
  }

  // How many storage controllers there can be. TopoLVM's controller
  // spreads its replicas across nodes and insists on it, so a cluster
  // with fewer storage nodes than replicas has one that can never be
  // scheduled — and an install that waits for it never finishes.
  if (values.storageControllerReplicas === undefined) {
    values.storageControllerReplicas = countStorageNodes(rawConfig);
  }

  // Which lvmd serves which nodes. Worked out last, because doing it
  // means rendering the TopoLVM values with everything above already
  // in place to find out what device classes there are.
  const built = { Values: values };
  Object.assign(values, buildLvmdValues(built, context));

  // And what the plugins add, after everything the installer derives,
  // so that a plugin can build its values out of them
  Object.assign(values, buildPluginValues(built));

  return built;
}

/**
 * The values loaded plugins contribute.
 *
 * A plugin's templates are no use if they can only substitute what the
 * configuration happens to hold: the interesting values are derived
 * ones, and only the plugin knows how to derive its own. So a manifest
 * can declare values, and those values are themselves templates —
 * rendered against everything above, which is why this runs last.
 *
 * A plugin may not overwrite a value the installer derived or the
 * configuration set. Letting one quietly redefine "k8sApiServer" for
 * every other chart in the cluster is not extensibility, it is a very
 * confusing afternoon.
 *
 * @param built the values so far
 * @returns
 */
function buildPluginValues(built: any): Record<string, unknown> {
  const added: Record<string, unknown> = {};

  for (const { name, values: contributed } of getValueContributors()) {
    for (const [key, value] of Object.entries(contributed)) {
      if (built.Values[key] !== undefined) {
        console.warn(
          `⚠️  "${name}" wanted to set the value "${key}", which is already set. Keeping the existing one.`,
        );
        continue;
      }

      if (added[key] !== undefined) {
        console.warn(`⚠️  Two plugins both set the value "${key}". Keeping the first.`);
        continue;
      }

      try {
        added[key] =
          typeof value === "string" ? renderTemplate(value, built) : value;
      } catch (error: any) {
        throw new Error(`"${name}" couldn't work out its value "${key}": ${error.message}`);
      }
    }
  }

  return added;
}

/**
 * How to divide the device classes up between the nodes that can
 * serve them.
 *
 * lvmd won't start unless every volume group it's told about is on
 * the node it landed on, so a cluster of unlike machines needs one
 * lvmd configuration per combination of classes rather than one for
 * everybody. The combinations come from the cluster itself: nodes are
 * labelled with what they serve once their volume groups exist, and
 * an earlier command reads those labels back.
 *
 * Two values come out of this, both as JSON. YAML is a superset of
 * JSON, so a flow mapping or sequence drops into the values file on
 * one line and there is no indentation to get wrong:
 *
 * - lvmdBaseSelector: the nodeSelector for the configuration already
 *   written in the values file, which names every class
 * - lvmdAdditionalConfigs: one configuration per other shape found,
 *   each naming only the classes that shape has
 *
 * Nothing found means nothing to divide, and every node is offered
 * every class — which is what happened before any of this existed,
 * and what a first install does.
 *
 * @param built the values so far, used to render the TopoLVM values
 * @param context
 * @returns
 */
function buildLvmdValues(built: any, context?: any): Record<string, string> {
  const everyNode = {
    lvmdBaseSelector: JSON.stringify(STORAGE_NODE_SELECTOR),
    lvmdAdditionalConfigs: "[]",
  };

  const shapes = [...new Set(Object.values(getStorageShapes(context)))];

  if (shapes.length === 0) {
    return everyNode;
  }

  const catalogue = readDeviceClasses(built);

  if (catalogue.length === 0) {
    return everyNode;
  }

  // The shape of a node that has everything. The configuration in the
  // values file names every class, so it's the one that serves those
  // nodes, and the others are added alongside it.
  const complete = buildShape(catalogue.map((entry: any) => String(entry.name)));

  const additional = shapes
    .filter((shape) => shape !== complete)
    .map((shape) => {
      const wanted = readShape(shape);

      return {
        nodeSelector: buildShapeSelector(shape),

        // Kept in the catalogue's order rather than the shape's, so
        // that whichever class was marked default stays default when
        // the node has it. A shape without that class has no default
        // at all, which is fine: every StorageClass in k8s/ names the
        // device class it wants, so nothing relies on there being one.
        deviceClasses: catalogue.filter((entry: any) =>
          wanted.includes(String(entry.name)),
        ),
      };
    })
    .filter((entry) => entry.deviceClasses.length > 0);

  return {
    lvmdBaseSelector: JSON.stringify(buildShapeSelector(complete)),
    lvmdAdditionalConfigs: JSON.stringify(additional),
  };
}

/**
 * The device classes the TopoLVM values name.
 *
 * Read out of the file being rendered rather than written down here,
 * so that adding a class over there is all it takes — the same reason
 * the LVM bundle reads them rather than keeping its own list.
 *
 * Rendered with the values built so far, which don't yet include the
 * two this is working out. Those render as nothing, leaving the keys
 * empty, and the device classes are plain YAML either way.
 *
 * @param built
 * @returns
 */
function readDeviceClasses(built: any): any[] {
  try {
    const rendered = renderTemplate(readInstallerFile(TOPOLVM_VALUES_FILE), built);
    const classes = parseYaml(rendered)?.lvmd?.deviceClasses;

    return Array.isArray(classes) ? classes : [];
  } catch {
    // A values file that can't be read is a problem, but not this
    // function's problem: the LVM bundle reads the same file and says
    // so properly. Here it just means there's nothing to divide up.
    return [];
  }
}

/**
 * How many nodes can run a storage controller, up to the two that
 * make it redundant.
 *
 * A single node cluster is a real thing to want — it's where most
 * people start — and it shouldn't be told to wait for a second
 * replica that has nowhere to go.
 *
 * @param rawConfig
 * @returns
 */
function countStorageNodes(rawConfig: any): number {
  const nodes = Array.isArray(rawConfig.nodes) ? rawConfig.nodes : [];

  const storage = nodes.filter(
    (node: any) =>
      Array.isArray(node.roles) && node.roles.includes(NodeRole.StorageLocal),
  );

  return Math.max(1, Math.min(2, storage.length));
}

/**
 * Whether Cilium has to announce the cluster's gateway addresses.
 *
 * True only for the port-forward shape, where a router sends traffic
 * to an address on the LAN that nothing is holding. In the floating
 * shape the gateway node already has the address on an interface, and
 * a second machine announcing it would be claiming what isn't its own.
 *
 * @param rawConfig
 * @returns
 */
function announcesGatewayAddresses(rawConfig: any): boolean {
  const network = rawConfig.network;
  const gateway =
    network !== undefined && network !== null ? network.gateway : undefined;

  return (
    gateway !== undefined && gateway !== null && gateway.mode === GatewayMode.PortForward
  );
}

/**
 * Look up the control plane node, tolerating a configuration that
 * doesn't describe any nodes at all. Manifests that don't reference
 * the API server should still render for those.
 *
 * @param config
 * @returns
 */
function getControlPlaneHost(config: CloudConfig) {
  try {
    return config.getControlPlaneHost();
  } catch {
    return undefined;
  }
}

/**
 * Read a file, from inside the installer, from a plugin, or from this
 * machine.
 *
 * Three sources behind one function, which is what lets a plugin's
 * templates work everywhere the installer's own do — as a package's
 * values file, as a manifest applied before or after a chart, as the
 * argument to run-template, as any command's standard input. None of
 * those callers knows there is more than one kind of path.
 *
 * - embed://  one of the manifests compiled into this binary
 * - plugin:// a file inside a loaded plugin
 * - anything else, a path on this machine, relative to where the
 *   command was run from
 *
 * @param filePath
 * @returns
 */
export function readInstallerFile(filePath: string): string {
  if (isEmbeddedPath(filePath)) {
    return readEmbeddedFile(filePath);
  }

  // Anything a subsystem taught the renderer to read — plugin:// is
  // the one that exists, and it registers itself when it loads
  const contributed = resolveFile(filePath);
  if (contributed !== undefined) {
    return contributed;
  }

  const resolved = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);

  try {
    return readFileSync(resolved, { encoding: "utf8" });
  } catch (e: any) {
    throw new Error(`Couldn't read "${resolved}": ${e.message}`);
  }
}

/**
 * Read a file from the repository and fill in the configured values.
 *
 * The values files in k8s/ are templates, so an address or a domain
 * that only the configuration knows can be written once and land in
 * every chart that needs it.
 *
 * TODO: Update to support bundled bun URLs.
 * See https://bun.com/docs/bundler/executables#embed-assets-files
 *
 * @param config
 * @param filePath
 * @param fromConfiguration
 * @returns
 */
export function renderInstallerFile(
  config: CloudConfig,
  filePath: string,
  context?: any,
): string {
  const contents = readInstallerFile(filePath);

  try {
    return renderTemplate(contents, buildTemplateValues(config, context));
  } catch (e: any) {
    throw new Error(`Couldn't render "${filePath}": ${e.message}`);
  }
}
