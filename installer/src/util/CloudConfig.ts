import { readFile } from "node:fs/promises";
import { join } from "node:path";

// For now we're just loading a file in the current
// working directory and using that for host defintions
// const HOSTS_FILE_NAME = "cc.json";

export default class CloudConfig {
  /**
   * We're leaving config protected so
   * that if in the future we want to do
   * reactive style changes we can do so.
   *
   * i.e. live config updates
   */
  protected config: any;

  constructor(config: any = {}) {
    this.config = config;
  }


  /**
   * Load configuration from a file
   * @param configFilePath
   */
  async loadConfigFromFile(configFilePath: string) {
    const cwd = process.cwd();
    const filePath = join(cwd, configFilePath);

    const fileContents = await readFile(filePath, { encoding: "utf8" });
    this.config = JSON.parse(fileContents);
  }

  /**
   * Get the entire configuration
   * @returns
   */
  getConfig() {
    return this.config;
  }


  /**
   * Retrieve configuration information
   * for a node.
   * @param nodeName
   * @returns
   */
  getNode(nodeName: string) {
    const { config } = this;
    const nodes = config.nodes.filter((node) => nodeName === node.name);
    return nodes[0] !== undefined ? nodes[0] : null;
  }

  /**
   * On K3s
   */
  getControlPlaneUrl() {
    const planeAddress = this.getControlPlaneHost().address;
    return `https://${planeAddress}:6443`;
  }

  /**
   * Retrieve the host address from configuraiton.
   *
   * @param config
   * @returns
   */
  getControlPlaneHost() {
    const { config } = this;
    const controlPlaneNodes = config.hosts.filter((host) => {
      return host.type === "server";
    });

    return controlPlaneNodes[0];
  }
}
