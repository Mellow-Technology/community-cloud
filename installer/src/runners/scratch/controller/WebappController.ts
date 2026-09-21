import * as yaml from "js-yaml";

/**
 * Represents the structure of the Webapp CRD spec for type safety within the controller.
 */
interface WebappSpec {
  webappImage: string;
  webappReplicas?: number;
  container?: {
    ports?: number[];
    env?: Array<{ name: string; value: string }>;
  };
  storage?: {
    size: string;
    mountPath: string;
  };
  resources?: {
    limits?: { cpu?: string; memory?: string };
    requests?: { cpu?: string; memory?: string };
  };
  database?: {
    type?: string;
    clusterName?: string;
    storageSize?: string;
  };
  domains?: string[];
  gateway?: {
    httpRoute?: {
      path?: string;
      host?: string;
    };
  };
}

const CERT_ISSUER = "cc-lets-encrypt";
const DEFAULT_POD_MEMORY_LIMIT = "256Mi";

export class WebappController {
  /**
   * Generates a set of Kubernetes manifests based on the provided Webapp spec.
   *
   * @param name The name of the webapp resource.
   * @param namespace The namespace where the webapp is deployed.
   * @param spec The specification of the Webapp CRD.
   * @returns A string containing all generated YAML manifests separated by '---'.
   */
  public generateManifests(
    name: string,
    namespace: string,
    spec: WebappSpec,
  ): string {
    const manifests: string[] = [];

    // 1. Deployment
    manifests.push(this.createDeployment(name, namespace, spec));

    // 2. Service (to expose the pod internally)
    manifests.push(this.createService(name, namespace, spec));

    // 3. PersistentVolumeClaim (if storage is requested)
    if (spec.storage) {
      manifests.push(this.createPVC(name, namespace, spec.storage));
    }

    // 4. CloudNativePG Cluster (if database is requested)
    if (spec.database && spec.database.type === "cloudnative-pg") {
      manifests.push(this.createCNPGCluster(name, namespace, spec.database));
    }

    // 5. Gateway API: HTTPRoute
    if (spec.gateway?.httpRoute || spec.domains?.length) {
      manifests.push(this.createHTTPRoute(name, namespace, spec));
    }

    // 6. Certificate (via cert-manager for the domains)
    if (spec.domains && spec.domains.length > 0) {
      manifests.push(this.createCertificate(name, namespace, spec.domains));
    }

    return manifests.join("\n---\n");
  }

  private createDeployment(
    name: string,
    namespace: string,
    spec: WebappSpec,
  ): string {
    const containerPorts =
      spec.container?.ports?.map((p) => ({ containerPort: p })) || [];
    const env =
      spec.container?.env?.map((e) => ({ name: e.name, value: e.value })) || [];

    // Apply default memory limit of 256Mi if not specified
    const limits = {
      cpu: spec.resources?.limits?.cpu || "500m",
      memory: spec.resources?.limits?.memory || "256Mi",
    };

    const requests = {
      cpu: spec.resources?.requests?.cpu || "100m",
      memory: spec.resources?.requests?.memory || "128Mi",
    };

    // Add volume mounts if storage is requested
    const volumeMounts = spec.storage
      ? [{ name: "webapp-storage", mountPath: spec.storage.mountPath }]
      : [];
    const volumes = spec.storage
      ? [
          {
            name: "webapp-storage",
            persistentVolumeClaim: { claimName: `${name}-pvc` },
          },
        ]
      : [];

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace },
      spec: {
        replicas: spec.webappReplicas ?? 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [
              {
                name: "webapp",
                image: spec.webappImage,
                ports: containerPorts,
                env: env,
                resources: { limits, requests },
                volumeMounts: volumeMounts,
              },
            ],
            volumes: volumes,
          },
        },
      },
    };

    return yaml.dump(deployment);
  }

  private createService(
    name: string,
    namespace: string,
    spec: WebappSpec,
  ): string {
    const port = spec.container?.ports?.[0] || 80;
    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace },
      spec: {
        selector: { app: name },
        ports: [{ port: 80, targetPort: port }],
      },
    };
    return yaml.dump(service);
  }

  private createPVC(
    name: string,
    namespace: string,
    storage: { size: string; mountPath: string },
  ): string {
    const pvc = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: `${name}-pvc`, namespace },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: storage.size } },
      },
    };
    return yaml.dump(pvc);
  }

  private createCNPGCluster(
    name: string,
    namespace: string,
    dbSpec: any,
  ): string {
    const clusterName = `${name}-db`;
    const cluster = {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: { name: clusterName, namespace },
      spec: {
        instances: 3,
        storage: {
          size: dbSpec.storageSize || "1Gi",
        },
      },
    };
    return yaml.dump(cluster);
  }

  private createHTTPRoute(
    name: string,
    namespace: string,
    spec: WebappSpec,
  ): string {
    const path = spec.gateway?.httpRoute?.path || "/";
    const host = spec.domains?.[0] || "";

    const route = {
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      metadata: { name, namespace },
      spec: {
        parentRefs: [{ fromName: `${name}-gateway` }],
        hostnames: spec.domains || [],
        rules: [
          {
            matches: [{ path: { type: "PathPrefix", value: path } }],
            backendRefs: [{ name, port: 80 }],
          },
        ],
      },
    };
    return yaml.dump(route);
  }

  private createCertificate(
    name: string,
    namespace: string,
    domains: string[],
  ): string {
    const certificate = {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: `${name}-cert`, namespace },
      spec: {
        dnsNames: domains,
        secretName: `${name}-tls`,
        issuerRef: {
          name: "letsencrypt-prod",
          kind: "ClusterIssuer",
        },
      },
    };
    return yaml.dump(certificate);
  }
}
