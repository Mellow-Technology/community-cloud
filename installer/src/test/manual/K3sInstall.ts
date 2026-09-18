import { runRemoteBundle } from "../runners/runBundle.ts";
import CloudConfig from "../util/CloudConfig.ts";

/**
 * Run a test of a K3s installation.
 */

async function runK3sInstall() {
  const config = new CloudConfig();

  config.loadConfigFromFile(configFilePath);

  runRemoteBundle("k3s", );
}

await runK3sInstall();
