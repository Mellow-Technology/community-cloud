import Command from "./Command.ts";


/**
 * @file
 * Detect GPU hardware and label node appropriately.
 */

class GpuInfo extends Command {
  constructor() {
    super();
  }
}

/**
 * Detects GPU hardware and driver status *remotely* via SSH.
 */
async detectGpu(): Promise<GpuInfo> {
  const gpu: GpuInfo = { type: "none" };

  // 1. NVIDIA check
  try {
    const { stdout } = await this.exec(
      "nvidia-smi --query-gpu=name,driver_version --format=csv,noheader,nounits",
      {
        timeout: 5000,
        stdio: "pipe",
      },
    );

    if (stdout.trim()) {
      gpu.type = "nvidia";
      const [name] = stdout.split("\n")[0].split(",");
      gpu.model = name?.trim();
      gpu.driversInstalled = true;

      // Count GPUs (each line = 1 GPU)
      gpu.count = stdout.split("\n").filter(Boolean).length;
    }
  } catch {
    /* no NVIDIA */
  }

  // 2. AMD check — fallback to lspci + rocm-smi
  if (!gpu.type || gpu.type === "none") {
    try {
      const { stdout } = await this.exec(
        'lspci -v | grep -E "VGA|3D|Display" | grep -i amd',
        { timeout: 5000 },
      );

      if (stdout.includes("Advanced Micro Devices")) {
        gpu.type = "amd";
        const modelMatch = stdout.match(/Radeon\s+([A-Za-z0-9\-]+)/i);
        if (modelMatch?.[1]) gpu.model = modelMatch[1];

        // Check rocm-smi availability
        try {
          await this.exec("rocm-smi --version >/dev/null 2>&1");
          gpu.driversInstalled = true;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no AMD */
    }
  }

  // 3. Intel GPU check (iris, UHD, etc.)
  if (!gpu.type || gpu.type === "none") {
    try {
      const { stdout } = await this.exec(
        'lspci -v | grep -E "Intel.*VGA|Display" | head -1',
        { timeout: 5000 },
      );

      if (stdout.includes("Intel")) {
        gpu.type = "intel";
        const modelMatch = stdout.match(/Intel\s+([A-Za-z0-9]+\s+Graphics)/i);
        if (modelMatch?.[1]) gpu.model = modelMatch[1];
      }
    } catch {
      /* no Intel GPU */
    }
  }

  return gpu;
}
