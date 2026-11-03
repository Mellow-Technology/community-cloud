//! @file
//! What an image says about itself: the ports it declares.
//!
//! An image's config, the JSON blob its manifest points at, carries
//! the `EXPOSE` lines of the Dockerfile that built it as
//! `config.ExposedPorts`. Reading the port from there rather than
//! asking for it means one less thing in a WebApplication that can be
//! wrong — and silently wrong, since a Service pointed at the wrong
//! port just never answers.
//!
//! It's the registry API every registry speaks (the OCI distribution
//! spec), and only the two reads needed: a manifest and a blob. A
//! multi-platform image is an index of manifests, one per platform,
//! and the config is read from one of them; images declare the same
//! ports on every platform, so which one hardly matters, and linux on
//! amd64 is preferred because that's what most clusters run.
//!
//! Registries ask for credentials in one of two ways, both in the
//! WWW-Authenticate header of a 401: Basic, which takes the username
//! and password directly, or Bearer, which sends the client to a token
//! service first. The credentials are whatever a pull Secret has for
//! the registry, or none for a public image.

use std::collections::BTreeMap;

use base64::Engine;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, WWW_AUTHENTICATE};
use reqwest::{Response, StatusCode};
use serde::Deserialize;

use crate::error::{Error, Result};

// Docker Hub, as an image names it and as its API is reached
const DOCKER_HUB: &str = "docker.io";
const DOCKER_HUB_API: &str = "registry-1.docker.io";
const DOCKER_HUB_ALIASES: [&str; 4] = ["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"];

// Every kind of manifest worth reading: the OCI and Docker forms of a
// single image and of an index of them
const MANIFEST_TYPES: &str = "application/vnd.oci.image.index.v1+json, \
     application/vnd.docker.distribution.manifest.list.v2+json, \
     application/vnd.oci.image.manifest.v1+json, \
     application/vnd.docker.distribution.manifest.v2+json";

// Far more than any manifest or config needs; a registry sending more
// than this is sending something else
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// An image reference, taken apart the way Docker reads one.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageReference {
    /// The host the registry API is on.
    pub registry: String,
    /// The repository within it, e.g. acme/shop.
    pub repository: String,
    /// A tag or a digest.
    pub reference: String,
}

impl ImageReference {
    /// Read `registry/repository:tag` or `registry/repository@digest`.
    ///
    /// The first part is a registry when it looks like a host — it has
    /// a dot or a port, or is localhost — and otherwise the image is on
    /// Docker Hub, where a bare name like "nginx" is "library/nginx".
    pub fn parse(image: &str) -> Result<Self> {
        let image = image.trim();
        let invalid = || Error::Config(format!("\"{image}\" isn't an image reference Cirrus can read"));

        let (name, reference) = match image.split_once('@') {
            Some((name, digest)) => (name, digest.to_string()),
            None => {
                // A colon after the last slash is a tag; one before it is
                // a registry's port
                let slash = image.rfind('/').map_or(0, |index| index + 1);
                match image[slash..].rfind(':') {
                    Some(colon) => (&image[..slash + colon], image[slash + colon + 1..].to_string()),
                    None => (image, "latest".to_string()),
                }
            }
        };
        if name.is_empty() || reference.is_empty() {
            return Err(invalid());
        }

        let (first, rest) = name.split_once('/').unwrap_or(("", name));
        let is_host = !first.is_empty() && (first.contains('.') || first.contains(':') || first == "localhost");
        let (registry, repository) = if is_host {
            (normalise_registry(first), rest.to_string())
        } else {
            (DOCKER_HUB.to_string(), name.to_string())
        };
        if repository.is_empty() {
            return Err(invalid());
        }

        // Docker Hub's official images live under "library"
        let repository = if registry == DOCKER_HUB && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository
        };

        Ok(Self {
            registry,
            repository,
            reference,
        })
    }

    // Where the registry's API is
    fn api_base(&self) -> String {
        let host = if self.registry == DOCKER_HUB {
            DOCKER_HUB_API
        } else {
            &self.registry
        };
        // Tests point at a plain-HTTP mock; everything real is HTTPS
        if host.starts_with("127.0.0.1") || host.starts_with("localhost") {
            format!("http://{host}")
        } else {
            format!("https://{host}")
        }
    }
}

impl std::fmt::Display for ImageReference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let separator = if self.reference.contains(':') { '@' } else { ':' };
        write!(f, "{}/{}{separator}{}", self.registry, self.repository, self.reference)
    }
}

/// A registry's host as credentials and images both name it.
pub fn normalise_registry(server: &str) -> String {
    let host = server
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if DOCKER_HUB_ALIASES.contains(&host.as_str()) {
        DOCKER_HUB.to_string()
    } else {
        host
    }
}

/// A username and password for a registry.
#[derive(Clone, PartialEq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

// Kept out of logs and errors
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials").field("username", &self.username).finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct DockerConfig {
    #[serde(default)]
    auths: BTreeMap<String, DockerAuth>,
}

#[derive(Deserialize)]
struct DockerAuth {
    username: Option<String>,
    password: Option<String>,
    auth: Option<String>,
}

/// The credentials a .dockerconfigjson has for a registry, if any.
pub fn credentials_for(docker_config: &[u8], registry: &str) -> Option<Credentials> {
    let config: DockerConfig = serde_json::from_slice(docker_config).ok()?;
    let entry = config
        .auths
        .into_iter()
        .find(|(server, _)| normalise_registry(server) == registry)?
        .1;

    if let (Some(username), Some(password)) = (entry.username, entry.password) {
        return Some(Credentials { username, password });
    }
    let decoded = base64::engine::general_purpose::STANDARD.decode(entry.auth?.trim()).ok()?;
    let (username, password) = String::from_utf8(decoded).ok()?.split_once(':').map(|(user, pass)| (user.to_string(), pass.to_string()))?;
    Some(Credentials { username, password })
}

/// A port an image declares, as `EXPOSE` wrote it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ExposedPort {
    pub port: i32,
    pub protocol: String,
}

impl std::fmt::Display for ExposedPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.port, self.protocol)
    }
}

/// Read `config.ExposedPorts` out of an image config: keys like
/// "3000/tcp", or a bare "3000", which Docker takes as TCP.
pub fn read_exposed_ports(config: &serde_json::Value) -> Vec<ExposedPort> {
    let Some(ports) = config.pointer("/config/ExposedPorts").and_then(|value| value.as_object()) else {
        return Vec::new();
    };
    let mut found: Vec<ExposedPort> = ports
        .keys()
        .filter_map(|key| {
            let (port, protocol) = key.split_once('/').unwrap_or((key, "tcp"));
            Some(ExposedPort {
                port: port.trim().parse().ok().filter(|port| (1..=65535).contains(port))?,
                protocol: protocol.trim().to_lowercase(),
            })
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "mediaType")]
    media_type: Option<String>,
    config: Option<Descriptor>,
    manifests: Option<Vec<Descriptor>>,
}

#[derive(Deserialize, Clone)]
struct Descriptor {
    digest: String,
    platform: Option<Platform>,
}

#[derive(Deserialize, Clone)]
struct Platform {
    os: String,
    architecture: String,
}

// Which of an index's images to read the config of
fn choose_platform(manifests: &[Descriptor]) -> Option<&Descriptor> {
    let on = |os: &str, architecture: Option<&str>| {
        manifests.iter().find(|entry| {
            entry.platform.as_ref().is_some_and(|platform| {
                platform.os == os && architecture.is_none_or(|wanted| platform.architecture == wanted)
            })
        })
    };
    // Attestations are listed as platform "unknown", so they're only
    // taken when there's nothing else
    on("linux", Some("amd64"))
        .or_else(|| on("linux", None))
        .or_else(|| manifests.first())
}

/// A client for one image's registry.
pub struct Registry {
    http: reqwest::Client,
    image: ImageReference,
    credentials: Option<Credentials>,
    // How to authorise requests, once a registry has said
    authorization: Option<String>,
}

impl Registry {
    pub fn new(image: ImageReference, credentials: Option<Credentials>) -> Self {
        crate::install_crypto_provider();
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("a reqwest client builds"),
            image,
            credentials,
            authorization: None,
        }
    }

    /// The ports the image declares.
    pub async fn exposed_ports(&mut self) -> Result<Vec<ExposedPort>> {
        let mut manifest = self.manifest(&self.image.reference.clone()).await?;

        // An index: one more step, to a single platform's image
        if let Some(manifests) = &manifest.manifests {
            let chosen = choose_platform(manifests)
                .ok_or_else(|| self.problem("lists no images in its index"))?
                .digest
                .clone();
            manifest = self.manifest(&chosen).await?;
        }

        let config = manifest.config.ok_or_else(|| {
            self.problem(&format!(
                "has a manifest with no config ({})",
                manifest.media_type.as_deref().unwrap_or("of no stated type")
            ))
        })?;
        let blob = self.get(&format!("blobs/{}", config.digest), None).await?;
        let config: serde_json::Value = serde_json::from_slice(&blob).map_err(|_| self.problem("has a config that isn't JSON"))?;
        Ok(read_exposed_ports(&config))
    }

    async fn manifest(&mut self, reference: &str) -> Result<Manifest> {
        let body = self.get(&format!("manifests/{reference}"), Some(MANIFEST_TYPES)).await?;
        serde_json::from_slice(&body).map_err(|_| self.problem("has a manifest Cirrus can't read"))
    }

    // A GET under the repository, signing in once if the registry asks
    async fn get(&mut self, rest: &str, accept: Option<&str>) -> Result<Vec<u8>> {
        let url = format!("{}/v2/{}/{rest}", self.image.api_base(), self.image.repository);
        let mut response = self.send(&url, accept).await?;
        if response.status() == StatusCode::UNAUTHORIZED && self.authorization.is_none() {
            self.authorization = Some(self.sign_in(response.headers()).await?);
            response = self.send(&url, accept).await?;
        }
        match response.status() {
            status if status.is_success() => read_limited(response).await,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(self.problem(if self.credentials.is_some() {
                "refused the pull Secret's credentials"
            } else {
                "needs credentials, and no pull Secret has any for it"
            })),
            StatusCode::NOT_FOUND => Err(self.problem("doesn't have it")),
            status => Err(self.problem(&format!("answered {status}"))),
        }
    }

    async fn send(&self, url: &str, accept: Option<&str>) -> Result<Response> {
        let mut request = self.http.get(url);
        if let Some(accept) = accept {
            request = request.header(ACCEPT, accept);
        }
        if let Some(authorization) = &self.authorization {
            request = request.header(AUTHORIZATION, authorization);
        }
        request.send().await.map_err(|error| self.problem(&format!("couldn't be reached: {error}")))
    }

    // Work out an Authorization header from a 401's challenge
    async fn sign_in(&self, headers: &HeaderMap) -> Result<String> {
        let challenge = headers
            .get(WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let (scheme, parameters) = parse_challenge(&challenge);

        match scheme.as_str() {
            "basic" => {
                let credentials = self
                    .credentials
                    .as_ref()
                    .ok_or_else(|| self.problem("needs credentials, and no pull Secret has any for it"))?;
                let pair = format!("{}:{}", credentials.username, credentials.password);
                Ok(format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair)))
            }
            "bearer" => {
                let realm = parameters
                    .get("realm")
                    .ok_or_else(|| self.problem("asked for a token without saying where to get one"))?;
                let mut query: Vec<(&str, String)> = Vec::new();
                if let Some(service) = parameters.get("service") {
                    query.push(("service", service.clone()));
                }
                // The scope a registry names, or the one a pull needs
                let scope = parameters
                    .get("scope")
                    .cloned()
                    .unwrap_or_else(|| format!("repository:{}:pull", self.image.repository));
                query.push(("scope", scope));

                let encoded: Vec<String> = query
                    .iter()
                    .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
                    .collect();
                let separator = if realm.contains('?') { '&' } else { '?' };
                let mut request = self.http.get(format!("{realm}{separator}{}", encoded.join("&")));
                if let Some(credentials) = &self.credentials {
                    request = request.basic_auth(&credentials.username, Some(&credentials.password));
                }
                let response = request
                    .send()
                    .await
                    .map_err(|error| self.problem(&format!("has a token service that couldn't be reached: {error}")))?;
                if !response.status().is_success() {
                    return Err(self.problem(if self.credentials.is_some() {
                        "refused the pull Secret's credentials"
                    } else {
                        "needs credentials, and no pull Secret has any for it"
                    }));
                }

                #[derive(Deserialize)]
                struct Token {
                    token: Option<String>,
                    access_token: Option<String>,
                }
                let token: Token = serde_json::from_slice(&read_limited(response).await?)
                    .map_err(|_| self.problem("gave a token Cirrus couldn't read"))?;
                let token = token
                    .token
                    .or(token.access_token)
                    .ok_or_else(|| self.problem("gave no token"))?;
                Ok(format!("Bearer {token}"))
            }
            _ => Err(self.problem("refused, without saying how to sign in")),
        }
    }

    // "the registry for registry.gitlab.com/acme/shop:main doesn't have it"
    fn problem(&self, what: &str) -> Error {
        Error::Registry(format!("the registry for {} {what}", self.image))
    }
}

// The body, refusing one that's far too big to be what was asked for
async fn read_limited(response: Response) -> Result<Vec<u8>> {
    let bytes = response
        .bytes()
        .await
        .map_err(|error| Error::Registry(format!("the registry's answer was cut off: {error}")))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(Error::Registry(
            "the registry sent far more than a manifest or config".to_string(),
        ));
    }
    Ok(bytes.to_vec())
}

/// Take a WWW-Authenticate header apart: its scheme, lower-cased, and
/// its parameters, e.g. `Bearer realm="…",service="…"`.
pub fn parse_challenge(header: &str) -> (String, BTreeMap<String, String>) {
    let header = header.trim();
    let (scheme, rest) = header.split_once(' ').unwrap_or((header, ""));
    let mut parameters = BTreeMap::new();

    // Values are quoted and can contain commas (a scope with several
    // actions), so this walks the string rather than splitting it
    let mut chars = rest.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| *c == ',' || c.is_whitespace()) {
            chars.next();
        }
        let key: String = chars.by_ref().take_while(|c| *c != '=').collect();
        if key.is_empty() {
            break;
        }
        let value = if chars.peek() == Some(&'"') {
            chars.next();
            let mut value = String::new();
            while let Some(c) = chars.next() {
                match c {
                    '\\' => value.extend(chars.next()),
                    '"' => break,
                    _ => value.push(c),
                }
            }
            value
        } else {
            chars.by_ref().take_while(|c| *c != ',').collect::<String>().trim().to_string()
        };
        parameters.insert(key.trim().to_lowercase(), value);
    }
    (scheme.to_lowercase(), parameters)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn reads_references_as_docker_does() {
        let read = |image: &str| {
            let parsed = ImageReference::parse(image).unwrap();
            (parsed.registry, parsed.repository, parsed.reference)
        };
        assert_eq!(
            read("registry.gitlab.com/acme/shop:main"),
            ("registry.gitlab.com".into(), "acme/shop".into(), "main".into())
        );
        assert_eq!(
            read("registry.gitlab.com/acme/shop@sha256:feed"),
            ("registry.gitlab.com".into(), "acme/shop".into(), "sha256:feed".into())
        );
        assert_eq!(read("nginx"), ("docker.io".into(), "library/nginx".into(), "latest".into()));
        assert_eq!(read("bitnami/redis:7"), ("docker.io".into(), "bitnami/redis".into(), "7".into()));
        assert_eq!(
            read("registry.local:5000/team/app"),
            ("registry.local:5000".into(), "team/app".into(), "latest".into())
        );
    }

    #[test]
    fn finds_credentials_by_registry_in_either_form() {
        let config = json!({"auths": {
            "https://registry.gitlab.com": {"auth": base64::engine::general_purpose::STANDARD.encode("deploy:secret")},
            "https://index.docker.io/v1/": {"username": "me", "password": "pw"}
        }})
        .to_string();
        assert_eq!(
            credentials_for(config.as_bytes(), "registry.gitlab.com"),
            Some(Credentials {
                username: "deploy".into(),
                password: "secret".into()
            })
        );
        assert_eq!(credentials_for(config.as_bytes(), "docker.io").unwrap().username, "me");
        assert_eq!(credentials_for(config.as_bytes(), "ghcr.io"), None);
    }

    #[test]
    fn reads_exposed_ports() {
        let config = json!({"config": {"ExposedPorts": {"9443/tcp": {}, "9000/tcp": {}, "53/udp": {}, "8080": {}}}});
        let ports: Vec<String> = read_exposed_ports(&config).iter().map(ToString::to_string).collect();
        assert_eq!(ports, ["53/udp", "8080/tcp", "9000/tcp", "9443/tcp"]);
        assert!(read_exposed_ports(&json!({"config": {}})).is_empty());
    }

    #[test]
    fn takes_challenges_apart() {
        let (scheme, parameters) = parse_challenge(
            r#"Bearer realm="https://gitlab.com/jwt/auth",service="container_registry",scope="repository:acme/shop:pull,push""#,
        );
        assert_eq!(scheme, "bearer");
        assert_eq!(parameters["realm"], "https://gitlab.com/jwt/auth");
        assert_eq!(parameters["scope"], "repository:acme/shop:pull,push");
        assert_eq!(parse_challenge(r#"Basic realm="Registry""#).0, "basic");
    }

    // A registry wanting a token, holding a two-platform image whose
    // amd64 config exposes 3000
    async fn registry() -> MockServer {
        let server = MockServer::start().await;
        let realm = format!("{}/token", server.uri());
        Mock::given(method("GET"))
            .and(path("/v2/acme/shop/manifests/main"))
            .and(header("authorization", "Bearer t0ken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [
                    {"digest": "sha256:arm", "platform": {"os": "linux", "architecture": "arm64"}},
                    {"digest": "sha256:amd", "platform": {"os": "linux", "architecture": "amd64"}},
                    {"digest": "sha256:att", "platform": {"os": "unknown", "architecture": "unknown"}}
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v2/acme/shop/manifests/main"))
            .respond_with(ResponseTemplate::new(401).insert_header(
                "www-authenticate",
                format!(r#"Bearer realm="{realm}",service="container_registry",scope="repository:acme/shop:pull""#),
            ))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/token"))
            .and(query_param("service", "container_registry"))
            .and(query_param("scope", "repository:acme/shop:pull"))
            .and(header("authorization", "Basic ZGVwbG95OnNlY3JldA=="))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"token": "t0ken"})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v2/acme/shop/manifests/sha256:amd"))
            .and(header("authorization", "Bearer t0ken"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": {"digest": "sha256:cfg"}
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v2/acme/shop/blobs/sha256:cfg"))
            .and(header("authorization", "Bearer t0ken"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"config": {"ExposedPorts": {"3000/tcp": {}}}})),
            )
            .mount(&server)
            .await;
        server
    }

    fn image_on(server: &MockServer) -> ImageReference {
        let host = server.uri().trim_start_matches("http://").to_string();
        ImageReference::parse(&format!("{host}/acme/shop:main")).unwrap()
    }

    #[tokio::test]
    async fn signs_in_for_a_token_and_reads_the_amd64_config() {
        let server = registry().await;
        let credentials = Credentials {
            username: "deploy".into(),
            password: "secret".into(),
        };
        let ports = Registry::new(image_on(&server), Some(credentials)).exposed_ports().await.unwrap();
        assert_eq!(
            ports,
            [ExposedPort {
                port: 3000,
                protocol: "tcp".into()
            }]
        );
    }

    #[tokio::test]
    async fn says_when_it_needs_credentials_it_hasnt_got() {
        let server = registry().await;
        let error = Registry::new(image_on(&server), None).exposed_ports().await.unwrap_err();
        assert!(error.to_string().contains("no pull Secret has any"), "{error}");
    }
}
