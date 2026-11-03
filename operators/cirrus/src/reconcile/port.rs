//! @file
//! Which port an application listens on, when its spec doesn't say.
//!
//! The image says, through the `EXPOSE` in the Dockerfile that built
//! it, and reading it from there removes one way for a WebApplication
//! to be quietly wrong. It's read once per image and kept in the
//! status, since an image's config never changes under its digest and
//! a registry shouldn't be asked the same question every pass.
//!
//! Only an image declaring exactly one TCP port is taken at its word.
//! None means the Dockerfile didn't say; several (an HTTP and an HTTPS
//! port, or an app and its metrics) means guessing, and a wrong guess
//! is the very mistake this is here to prevent. Either way the spec's
//! port is asked for, by name, in a condition.
//!
//! The registry is reached with the pull Secrets the pods will use:
//! the spec's, or the namespace's defaults on its default
//! ServiceAccount, which is where Meteorologist puts them.

use k8s_openapi::api::core::v1::{Secret, ServiceAccount};
use kube::Api;

use super::Context;
use crate::crd::{ImagePort, WebApplication};
use crate::error::{Error, Result};
use crate::registry::{self, Credentials, ExposedPort, ImageReference, Registry};

/// The port to run `image` on, or why it isn't known.
///
/// A problem is a message for a condition rather than an error, since
/// it's something a person fixes: an image with no EXPOSE, a pull
/// Secret missing. Kubernetes errors still come back as errors.
pub async fn resolve(
    ctx: &Context,
    app: &WebApplication,
    image: &str,
    known: &mut Vec<ImagePort>,
) -> Result<Result<i32, String>> {
    if let Some(port) = app.spec.port {
        return Ok(Ok(port));
    }
    if let Some(port) = cached(known, image) {
        return Ok(Ok(port));
    }

    let reference = match ImageReference::parse(image) {
        Ok(reference) => reference,
        Err(error) => return Ok(Err(error.to_string())),
    };
    let credentials = credentials(ctx, app, &reference.registry).await?;
    let ports = match Registry::new(reference, credentials).exposed_ports().await {
        Ok(ports) => ports,
        Err(Error::Registry(problem)) => {
            return Ok(Err(format!(
                "couldn't read the port from {image}, so it's tried again shortly: {problem}. Setting spec.port skips this."
            )));
        }
        Err(error) => return Err(error),
    };

    match choose(&ports) {
        Ok(port) => {
            tracing::info!(%image, port, "read the port from the image");
            known.push(ImagePort {
                image: image.to_string(),
                port,
            });
            Ok(Ok(port))
        }
        Err(problem) => Ok(Err(format!("{image} {problem}"))),
    }
}

/// The port an earlier pass read for an image.
pub fn cached(known: &[ImagePort], image: &str) -> Option<i32> {
    known.iter().find(|entry| entry.image == image).map(|entry| entry.port)
}

/// The one TCP port an image declares, or what's wrong with what it
/// declares.
pub fn choose(ports: &[ExposedPort]) -> std::result::Result<i32, String> {
    let tcp: Vec<&ExposedPort> = ports.iter().filter(|port| port.protocol == "tcp").collect();
    match tcp.as_slice() {
        [only] => Ok(only.port),
        [] => Err(
            "declares no TCP port (its Dockerfile has no EXPOSE), so Cirrus can't tell where it listens. Set spec.port."
                .to_string(),
        ),
        several => Err(format!(
            "declares several ports ({}), so Cirrus won't guess which serves HTTP. Set spec.port to that one.",
            several.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Keep only the entries for images still in play, so the status
/// doesn't grow with every release.
pub fn prune(known: &mut Vec<ImagePort>, keep: &[Option<&str>]) {
    known.retain(|entry| keep.contains(&Some(entry.image.as_str())));
    known.dedup_by(|a, b| a.image == b.image);
}

// Credentials for the image's registry, from the pull Secrets its
// pods will use. None for a public image, or one the nodes can pull
// without help.
async fn credentials(ctx: &Context, app: &WebApplication, registry: &str) -> Result<Option<Credentials>> {
    let (namespace, _) = super::identity(app);
    let names = if app.spec.image_pull_secrets.is_empty() {
        let account = Api::<ServiceAccount>::namespaced(ctx.client.clone(), &namespace)
            .get_opt("default")
            .await?;
        account
            .and_then(|account| account.image_pull_secrets)
            .unwrap_or_default()
            .into_iter()
            .map(|reference| reference.name)
            .collect()
    } else {
        app.spec.image_pull_secrets.clone()
    };

    let secrets = Api::<Secret>::namespaced(ctx.client.clone(), &namespace);
    for name in names {
        let Some(secret) = secrets.get_opt(&name).await? else {
            continue;
        };
        let Some(config) = secret.data.and_then(|mut data| data.remove(".dockerconfigjson")) else {
            continue;
        };
        if let Some(found) = registry::credentials_for(&config.0, registry) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(port: i32, protocol: &str) -> ExposedPort {
        ExposedPort {
            port,
            protocol: protocol.into(),
        }
    }

    #[test]
    fn takes_the_one_tcp_port() {
        assert_eq!(choose(&[port(3000, "tcp")]), Ok(3000));
        assert_eq!(choose(&[port(53, "udp"), port(8080, "tcp")]), Ok(8080));
    }

    #[test]
    fn asks_for_the_port_when_there_is_none() {
        assert!(choose(&[]).unwrap_err().contains("no EXPOSE"));
        assert!(choose(&[port(53, "udp")]).unwrap_err().contains("Set spec.port"));
    }

    #[test]
    fn wont_guess_between_several() {
        let problem = choose(&[port(9000, "tcp"), port(9443, "tcp")]).unwrap_err();
        assert!(problem.contains("9000/tcp, 9443/tcp"), "{problem}");
    }

    #[test]
    fn keeps_only_the_images_in_play() {
        let entry = |image: &str| ImagePort {
            image: image.into(),
            port: 3000,
        };
        let mut known = vec![entry("a"), entry("b"), entry("c"), entry("c")];
        prune(&mut known, &[Some("b"), Some("c")]);
        assert_eq!(
            known.iter().map(|entry| entry.image.as_str()).collect::<Vec<_>>(),
            ["b", "c"]
        );
    }
}
