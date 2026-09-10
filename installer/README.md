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

## Building

The installer ships as a single executable. It needs nothing on the
machine it runs on: no Bun, no Node, and no checkout of this
repository, because the manifests and values files under `k8s/` are
embedded in the binary.

```bash
cd installer
bun install
bun run build            # every platform
bun run build linux      # or a filter: linux, macos, windows, arm64, musl
```

Executables land in `installer/build/`:

| Target | File |
| --- | --- |
| Linux x64 (glibc) | `community-cloud-linux-x64` |
| Linux arm64 (glibc) | `community-cloud-linux-arm64` |
| Linux x64 (musl/Alpine) | `community-cloud-linux-x64-musl` |
| Linux arm64 (musl/Alpine) | `community-cloud-linux-arm64-musl` |
| macOS Apple silicon | `community-cloud-macos-arm64` |
| macOS Intel | `community-cloud-macos-x64` |
| Windows x64 | `community-cloud-windows-x64.exe` |
| Windows arm64 | `community-cloud-windows-arm64.exe` |

Every target cross-compiles from whatever machine you build on, so a
release can be cut from a laptop.

### Embedded manifests

The manifests and values files under `k8s/` are compiled into the
binary as a SQLite database, so a released executable can apply them on
a machine that has never seen this repository.

They're referred to with an `embed://` URL, and the paths have no
`k8s/` prefix:

```bash
community-cloud run-template embed://ai/vLLM/vllm-amd.yaml cc.config.json
community-cloud run-template ./ops/my-template.yaml cc.config.json
community-cloud list-embedded              # everything it carries
community-cloud list-embedded authentik    # filtered
```

`bun run build` rebuilds `src/generated/embedded.sqlite` before
compiling, so anything added under `k8s/` is picked up automatically.
Rebuild it on its own with:

```bash
bun run build:embedded
```

The database has one table, `files`, with `path` and `contents`
columns and a unique index on `path`. It's built from scratch each
time and the rows go in sorted, so the same tree always produces the
same bytes and a rebuild only shows up in a diff when something under
`k8s/` actually changed.

Only `.yaml` and `.yml` files are embedded — the READMEs under `k8s/`
are for people reading the repository, and nothing reads them at
runtime.

### Other scripts

```bash
bun run cc <args>        # run from source without building
bun run typecheck        # tsc --noEmit
```

## Contributing

We welcome contributions from the community! Please see our [Contributing Guide](./CONTRIBUTING.md) for more information on how to get involved.

## License

This project is licensed under the [MIT License](./LICENSE).
