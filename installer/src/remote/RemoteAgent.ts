// remote-agent.ts
import { RemoteHost } from "./RemoteHost.ts"; // assume this exists and provides .exec(cmd, opts)
import type { GpuInfo, K3sAgentConfig } from "../types";

export class RemoteAgent extends RemoteHost {
  constructor(
    host: string,
    options?: Omit<ConstructorParameters<typeof RemoteHost>[1], "host">,
  ) {
    super({ ...options, host });
  }



  /**
   * Installs & joins this host as a K3s agent node.
   */
  async installAgent(config: K3sAgentConfig): Promise<void> {
    const { serverUrl, token, labels = {}, extraArgs = [] } = config;

    // Fail fast if no server URL
    if (!serverUrl)
      throw new Error(
        "K3s agent requires a server URL (e.g., https://<ip>:6443)",
      );

    // Detect GPU *remotely*
    const gpuInfo = await this.detectGpu();
    let finalLabels = { ...labels };

    if (gpuInfo.type !== "none") {
      finalLabels["nvidia.com/gpu"] = "true";
      finalLabels["kubernetes.io/os"] = "linux";

      if (gpuInfo.model) {
        const safeModel = gpuInfo.model
          .toLowerCase()
          .replace(/[^a-z0-9-.]/g, "-")
          .slice(0, 63); // DNS label length limit
        finalLabels["nvidia.com/gpu.model"] = safeModel;
      }
    }

    // Build install command (idempotent: re-runs are no-op)
    let cmd = `curl -sfL https://get.k3s.io | K3S_URL=${serverUrl} sh -s - agent`;
    if (token) cmd += ` --token ${token}`;

    for (const arg of extraArgs) {
      cmd += ` ${arg}`;
    }

    // Ensure GPU-aware flags if needed
    const hasNvidia = gpuInfo.type === "nvidia";
    if (
      hasNvidia &&
      !extraArgs.includes("--kubelet-arg=--feature-gates=DevicePlugins=true")
    ) {
      cmd += " --kubelet-arg=--feature-gates=DevicePlugins=true";
    }

    console.log(`[K3s] Installing agent on ${this.options.host}...`);
    try {
      await this.exec(cmd, { timeout: 120_000 }); // generous timeout for install
    } catch (err: any) {
      const stderr = err.stderr || "";
      if (
        !stderr.includes("is already installed") &&
        !stderr.includes("is already running")
      ) {
        throw new Error(
          `K3s agent installation failed: ${stderr || String(err)}`,
        );
      }
      console.warn(
        "[K3s] Agent appears already installed — skipping reinstall.",
      );
    }

    // Apply labels *after* install (node must be registered)
    await this.applyLabels(finalLabels);
  }

  /**
   * Applies labels to this node via `kubectl`.
   */
  async applyLabels(labels: Record<string, string>): Promise<void> {
    if (!labels || Object.keys(labels).length === 0) return;

    // Get remote hostname
    const { stdout: hostname } = await this.exec("hostname", { stdio: "pipe" });
    const node = hostname.trim();

    const kubectlCmd = `kubectl label nodes ${node} --overwrite`;

    try {
      const cmd = `${kubectlCmd} ${this.formatLabels(labels)}`;
      console.log(`[K3s] Applying labels to node '${node}'...`);
      await this.exec(cmd);
    } catch (err: any) {
      // kubectl may fail if kubeconfig not ready yet — warn and retry
      const stderr = err.stderr || "";
      if (
        !stderr.includes("not found") &&
        !stderr.includes("connection refused")
      ) {
        throw err;
      }
      console.warn(
        `[K3s] Label application failed (node may still joining). Retrying once...`,
      );
      await new Promise((r) => setTimeout(r, 5000)); // wait for kubelet to settle
      const cmd = `${kubectlCmd} ${this.formatLabels(labels)}`;
      try {
        await this.exec(cmd);
      } catch (retryErr: any) {
        throw new Error(
          `Failed to apply labels after retry: ${(retryErr as Error).message}`,
        );
      }
    }

    console.log(`✅ Labels applied:`, Object.keys(labels).join(", "));
  }

  /**
   * Helper: formats label map as `k1=v1,k2=v2,...`
   */
  private formatLabels(labels: Record<string, string>): string {
    return Object.entries(labels)
      .map(([k, v]) => `${k}=${v.replace(/"/g, '\\"')}`) // escape quotes
      .join(",");
  }
}
