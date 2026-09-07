import { NodeSSH, Config } from "node-ssh";
import { readFile, access } from "node:fs/promises";
import { homedir } from "os";
import { join } from "node:path/posix";

// Common SSH key paths to try automatically
const DEFAULT_KEY_PATHS = [
  join(homedir(), ".ssh", "id_ed25519"),
  join(homedir(), ".ssh", "id_rsa"),
  join(homedir(), ".ssh", "id_ecdsa"),
];

export default class RemoteHost {
  ssh: NodeSSH;
  options: Partial<Config>;

  /**
   * @param {Partial<NodeSSH.SSHConnectionOptions>} options - SSH connection options
   */
  constructor(options: Partial<Config>) {
    this.ssh = new NodeSSH();
    this.options = { ...options };
  }

  /**
   * Try to auto-load a private key from common locations if not provided.
   * Returns the first readable key content, or undefined.
   */
  async loadPrivateKey(): Promise<string | undefined> {
    const { keyFile } = this.options;

    // If explicit keyFile is set, try to read it
    if (keyFile) {
      try {
        return await readFile(keyFile, "utf8");
      } catch (err: any) {
        throw new Error(
          `Failed to load specified private key file '${keyFile}': ${err.message}`,
        );
      }
    }

    // Otherwise, auto-scan default paths
    for (const path of DEFAULT_KEY_PATHS) {
      try {
        await access(path); // throws if not readable
        const content = await readFile(path, "utf8");
        return content;
      } catch {
        continue; // skip unreadable/unexisting keys
      }
    }

    return undefined;
  }

  /**
   * Establish SSH connection with fallback strategies:
   * - If privateKey is set: use it
   * - Else if password is set: use password auth
   * - Else if sshAgent is true: use ssh-agent
   * - Else: auto-load key + fall back to agent (no password fallback by default)
   */
  async connect(): Promise<void> {
    // If no explicit auth, try to load a private key
    let { privateKey, password, sshAgent } = this.options;

    if (!privateKey && !password && !sshAgent) {
      const loadedKey = await this.loadPrivateKey();
      if (loadedKey) {
        privateKey = loadedKey;
      }
    }

    // Prefer explicit auth methods
    const finalOptions: NodeSSH.SSHConnectionOptions = {
      ...this.options,
      privateKey,
      password,
      sshAgent: Boolean(sshAgent || (!privateKey && !password)), // fallback to agent only if no other method given
    };

    // Remove undefined/empty properties (node-ssh is strict about these)
    if (!finalOptions.privateKey) delete finalOptions.privateKey;
    if (!finalOptions.password) delete finalOptions.password;

    try {
      await this.ssh.connect(finalOptions);
    } catch (err: any) {
      throw new Error(
        `SSH connection failed for host '${this.options.host}': ${err.message}`,
      );
    }
  }

  /**
   * Upload a file to the remote host.
   * Supports local → remote and remote → remote (if `remoteToRemote` is set).
   */
  async upload(
    localPath: string,
    remotePath: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<void> {
    await this.ssh.putFile(localPath, remotePath);
  }

  /**
   * Execute a command on the remote host.
   * Returns stdout and stderr as strings.
   *
   * `stdin` is written to the command's standard input, which lets us
   * feed it something (a rendered manifest, say) without first having
   * to copy a file over.
   */
  async exec(
    command: string,
    args?: string[],
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string; parsed: any }> {
    const result = await this.ssh.execCommand(command, { args, stdin });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      parsed: null,
    };
  }

  /**
   * Execute a JSON-returning command.
   * Throws if output is not valid JSON or empty.
   */
  async execJSON<T = any>(command: string, args?: string[]): Promise<T> {
    const { stdout, stderr } = await this.exec(command, args);
    if (!stdout.trim()) {
      throw new Error(`Command returned empty output for: ${command}`);
    }
    try {
      return {
        stdout: stdout,
        stderr: null,
        parsed: JSON.parse(stdout),
      };
    } catch (err) {
      throw new Error(
        `Failed to parse JSON from command '${command}': ${err.message}\nOutput was:\n${stdout}`,
      );
    }
  }

  /**
   * Helper: check if SSH connection is active
   */
  isConnected(): boolean {
    return this.ssh.isConnected();
  }

  /**
   * Close the SSH connection (optional, useful for cleanup)
   */
  async disconnect(): Promise<void> {
    if (this.ssh.isConnected()) {
      await this.ssh.dispose();
    }
  }
}
