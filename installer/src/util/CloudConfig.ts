import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

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
    // Relative paths are resolved against the working directory,
    // absolute ones are already where they need to be
    const filePath = isAbsolute(configFilePath)
      ? configFilePath
      : join(process.cwd(), configFilePath);

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
    const name = nodeName.toLowerCase();

    // Node names carry capitals and spaces ("Mamoru BKK") while the
    // address is what people actually type at a terminal, so a node
    // answers to either.
    const nodes = config.nodes.filter((node) => {
      return (
        node.name?.toLowerCase() === name || node.address?.toLowerCase() === name
      );
    });

    return nodes[0] !== undefined ? nodes[0] : null;
  }

  /**
   * On K3s
   */
  getControlPlaneUrl() {
    const controlPlane = this.getControlPlaneHost();

    // Agents have to reach the API themselves, and the address we
    // administer a node through won't always get them there
    const planeAddress =
      controlPlane.apiAddress !== undefined
        ? controlPlane.apiAddress
        : controlPlane.address;

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
    const controlPlaneNodes = config.nodes.filter((host) => {
      return host.type === "server";
    });

    return controlPlaneNodes[0];
  }
}
