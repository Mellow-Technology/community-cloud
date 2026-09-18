class K3SInstallation {
  GATEWAY_API_VERSION = "1.4.0";
  CERT_MANAGER_VERSION = "1.19.2";

  // The type of K3S installation
  // either "server" or "agent"
  type: K3SInstallationType;

  // The token of the K3s server
  K3sToken: null | string;

  // Installation steps
  // Each installation step is
  // an array of async functions
  // which will be called in sequence
  steps: {
    agent: Function[];
    server: Function[];
  };

  constructor(type: K3SInstallationType) {
    // Installation type
    // either "server" or "agent"
    this.type = type;

    // Initialize the steps object
    // These steps will be run in order
    // on the client and server
    // respectively
    this.steps = {
      server: [],
      agent: [],
    };

    this.K3sToken = null;

    // Set install steps
    this.steps[K3SInstallationType.Server] = [
      this.installK3sServer,
      this.getK3sToken,
      this.setTraefikConfig,
      this.setRegistriesFile,
      this.installGatewayAPICRDs,
      this.labelGatewayNodes,
      this.installCertManager,
    ];

    this.steps[K3SInstallationType.Agent] = [];
  }

  runInstall(type: K3SInstallationType) {
    const steps = this.steps[type];

    steps.forEach((installStep) => {
      installStep(type);
    });

    if (type === K3SInstallationType.Server) {
    } else {
      this.ins;
    }
  }

  executeInstallSteps(steps: Function[]) {}

  getNodeInfo(node: string) {
    return {
      action: `sudo kubectl get node ${node} -o json`,
      description: "Get node information",
    };
  }

  // Install K3s server
  installK3sServer() {
    return {
      action: "",
      description: "Installing K3s Server",
    };
  }

  // Install K3s Agent
  instatllK3sAgent() {
    return {
      action: "",
      description: "Installing K3s agent",
    };
  }

  // Get K3S Token
  getK3sToken() {}

  // Setup configuration for traefik
  setTraefikConfig() {}

  // Setup registries.yml
  setRegistriesFile() {}

  // Install Gateway API CRDs
  installGatewayAPICRDs() {}

  // Label gateway Nodes
  labelGatewayNode() {
    return {
      action: "kubectl label node svccontroller.k3s.cattle.io/enablelb=true",
    };
  }

  // Label storage nodes
  labelNode() {}

  setupStorageProvisioner() {}

  // Setup storage classes
  setStorageClasses() {}

  // Install cert manager
  installCertManager() {}

  // Install TopoLVM
  installTopoLVM() {}

  // Install
  installPostgres() {}

  setupLocalStorage() {
    return [
      {
        action: "pvcreate --reportformat json",
        description: "Creating physical volume on device ${device}",
      },
      {
        action: "lvcreate --reportformat json",
        description: "Creating logical volume on device ${device}",
      },
    ];
  }
}
