# Community Cloud Installer

The Community Cloud Installer is a command-line interface (CLI) tool designed to simplify the deployment and configuration of K3s clusters across multiple nodes and sites. Whether you're setting up a single-site environment or managing a distributed multi-site infrastructure, this installer provides an automated, reliable way to get your cluster up and running.

## Key Features

- **Multi-Node, Multi-Site Deployment**: Seamlessly configure K3s across multiple nodes and sites with minimal manual intervention.
- **Automatic Storage Configuration**: The installer automatically sets up and configures storage solutions using [TopoLVM](https://github.com/topolvm/topolvm), providing dynamic volume provisioning and snapshot capabilities tailored to your cluster's needs.
- **Database Support**: Built-in support for PostgreSQL and MySQL databases via MariaDB, enabling easy deployment of database services within your cluster.
- **Tailscale Integration**: Enable secure cross-site communication with automatic Tailscale configuration, allowing nodes in different networks to communicate as if they were on the same local network.
- **Zero-Trust Networking**: Leverage Tailscale's built-in security features to maintain a secure and isolated cluster environment without additional configuration.
- **Scalable Architecture**: Easily scale your cluster by adding more nodes or sites as your requirements grow.

## Use Cases

- Deploying a multi-node K3s cluster for edge computing environments
- Setting up a distributed cluster across multiple physical locations
- Configuring GPU-enabled nodes for machine learning workloads
- Establishing secure cross-site communication for hybrid cloud setups

## Getting Started

For detailed instructions on how to use the Community Cloud Installer, please refer to the [Documentation](./docs/).

## Contributing

We welcome contributions from the community! Please see our [Contributing Guide](./CONTRIBUTING.md) for more information on how to get involved.

## License

This project is licensed under the [MIT License](./LICENSE).
