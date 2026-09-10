/**
 * @file
 * A command that calls an HTTP API.
 *
 * Parts of an install aren't shell commands: registering a node with a
 * control plane, asking a provider for a token, telling something the
 * cluster changed. Those are API calls, and a bundle should be able to
 * hold them next to the commands they belong with rather than being
 * split across two mechanisms.
 *
 * A response reports through the same output fields a shell command
 * uses, with the body in "stdout", so parsing, post-processing and
 * saving values into the context all work the same way. What comes
 * back is most often JSON, so that's the parsing this defaults to.
 */
import Command, {
  CommandOutput,
  OutputType,
  WebCommandSpec,
} from "./Command.ts";

// What to send when a spec doesn't say
const DEFAULT_METHOD = "GET";

export default class WebCommand extends Command {
  // Where the request goes
  url: string | Function;

  // The HTTP method
  method: string;

  // Query string parameters
  query?: Record<string, string | number | boolean> | Function;

  // Request headers
  headers?: Record<string, string> | Function;

  // The request body. A string is sent as-is, anything else as JSON.
  body?: unknown;

  // Response codes to accept. Any 2xx when this isn't set.
  expectStatus?: number[];

  // How long to wait, in milliseconds
  timeout?: number;

  // The function requests are made with, so that a bundle can hand
  // over something else to call
  fetchFunction: Function;

  constructor(spec: WebCommandSpec) {
    // An API answers in JSON unless told otherwise
    super(spec, OutputType.Json);

    const {
      url,
      method = DEFAULT_METHOD,
      query = undefined,
      headers = undefined,
      body = undefined,
      expectStatus = undefined,
      timeout = undefined,
    } = spec;

    this.url = url;
    this.method = method.toUpperCase();
    this.query = query;
    this.headers = headers;
    this.body = body;
    this.expectStatus = expectStatus;
    this.timeout = timeout;
    this.fetchFunction = fetch;
  }

  /**
   * Set the function requests are made with.
   *
   * @param fetchFunction
   */
  setFetchFunction(fetchFunction: Function) {
    this.fetchFunction = fetchFunction;
  }

  /**
   * Make the request.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  protected async run(config, context, commandResults): Promise<CommandOutput> {
    const url = this.buildUrl(config, context, commandResults);
    const headers = {
      ...this.resolve(this.headers, config, context, commandResults),
    };

    // A string body goes as it is, on the assumption that whoever
    // wrote it also set a content type. Anything else is JSON.
    const body = this.resolve(this.body, config, context, commandResults);
    let payload = undefined;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") {
        payload = body;
      }
      else {
        payload = JSON.stringify(body);
        if (findHeader(headers, "content-type") === undefined) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    let response = null;
    try {
      response = await this.fetchFunction(url, {
        method: this.method,
        headers,
        body: payload,
        signal: this.timeout !== undefined ? AbortSignal.timeout(this.timeout) : undefined,
      });
    } catch (e: any) {
      // A request that never landed reports the same way one that came
      // back wrong does, so a bundle only has the one thing to handle
      throw this.buildError(url, `${this.method} ${url} failed: ${e.message}`, "", e.message);
    }

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value: string, name: string) => {
      responseHeaders[name] = value;
    });

    if (!this.isExpected(response.status)) {
      throw this.buildError(
        url,
        `${this.method} ${url} returned ${response.status}`,
        responseBody,
        responseBody !== "" ? responseBody : response.statusText,
        response.status,
      );
    }

    return {
      stdout: responseBody,
      stderr: "",
      status: response.status,
      headers: responseHeaders,
    };
  }

  /**
   * Build the URL, including any query parameters.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  buildUrl(config, context, commandResults): string {
    const url = this.resolve(this.url, config, context, commandResults);
    if (typeof url !== "string" || url === "") {
      throw new Error(`Command "${this.name}" didn't produce a URL to call.`);
    }

    const query = this.resolve(this.query, config, context, commandResults);
    if (query === undefined || query === null) {
      return url;
    }

    const built = new URL(url);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        built.searchParams.set(name, String(value));
      }
    }

    return built.toString();
  }

  /**
   * Whether a response code counts as a success.
   *
   * @param status
   * @returns
   */
  isExpected(status: number): boolean {
    if (this.expectStatus !== undefined) {
      return this.expectStatus.includes(status);
    }

    return status >= 200 && status < 300;
  }

  /**
   * Any part of a request can be a function worked out from the
   * configuration and from what earlier commands found, the same way
   * a command string can be.
   *
   * @param value
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  protected resolve(value: any, config, context, commandResults) {
    return typeof value === "function"
      ? value(config, context, commandResults)
      : value;
  }

  /**
   * Shape a failure the way a failing shell command does, so that a
   * bundle can report it without caring which kind of command it was.
   *
   * @param url
   * @param message
   * @param stdout
   * @param stderr
   * @param status
   * @returns
   */
  protected buildError(
    url: string,
    message: string,
    stdout: string,
    stderr: string,
    status?: number,
  ) {
    const error: any = new Error(message);

    // Headers can carry credentials, so only the method and URL are
    // named here: this ends up in the log when a bundle fails
    error.cmd = `${this.method} ${url}`;
    error.stdout = stdout;
    error.stderr = stderr;
    error.status = status;

    return error;
  }
}

/**
 * Find a header regardless of how it was capitalised.
 *
 * @param headers
 * @param name
 * @returns
 */
function findHeader(headers: Record<string, string>, name: string) {
  return Object.keys(headers).find((header) => header.toLowerCase() === name);
}
