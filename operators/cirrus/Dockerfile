# Cirrus's image: built with the pinned toolchain, run on distroless.
#
# The build caches Cargo's registry and target directory between
# builds with BuildKit cache mounts, which does what cargo-chef would
# without a second tool to pin. Rustls and ring mean the binary needs
# nothing from the system but libc, so the runtime image is
# distroless's "cc" variant, as a non-root user.
FROM rust:1.99.0-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bin cirrus \
    && cp target/release/cirrus /cirrus

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /cirrus /usr/local/bin/cirrus
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cirrus"]
