//! @file
//! Code forges: where new images come from.
//!
//! GitLab is the only forge so far. Everything outside this module
//! asks for a Release — a commit, the tag its image was published
//! under, and the digest if the registry could say — and never
//! touches a forge's API itself, so adding another forge means
//! another file here and another block under `spec.source`.

pub mod gitlab;

use k8s_openapi::api::core::v1::Secret;
use kube::{Api, Client};

use crate::crd::{GitLabSource, Release, WebApplication};
use crate::error::{Error, Result};
use gitlab::GitLab;

/// A GitLab client with the token the application's spec points at.
pub async fn gitlab_client(client: &Client, app: &WebApplication, source: &GitLabSource) -> Result<GitLab> {
    let namespace = app.metadata.namespace.as_deref().unwrap_or("default");
    let token = read_secret_key(client, namespace, &source.token_secret.name, &source.token_secret.key).await?;
    Ok(GitLab::new(&source.url, &token))
}

/// One key of a Secret, as text.
pub async fn read_secret_key(client: &Client, namespace: &str, name: &str, key: &str) -> Result<String> {
    let secret = Api::<Secret>::namespaced(client.clone(), namespace)
        .get_opt(name)
        .await?
        .ok_or_else(|| Error::Config(format!("the Secret {namespace}/{name} doesn't exist")))?;
    let value = secret
        .data
        .and_then(|mut data| data.remove(key))
        .ok_or_else(|| Error::Config(format!("the Secret {namespace}/{name} has no \"{key}\"")))?;
    String::from_utf8(value.0)
        .map(|text| text.trim().to_string())
        .map_err(|_| Error::Config(format!("\"{key}\" in {namespace}/{name} isn't text")))
}

/// The release a pipeline on `sha` produced.
pub async fn release_for(gitlab: &GitLab, app: &WebApplication, source: &GitLabSource, sha: &str) -> Result<Release> {
    let tag = gitlab::render_tag(&source.image_tag, sha, &source.git_ref);
    let repository = app.spec.image.repository.clone();
    let digest = gitlab.resolve_digest(&source.project, &repository, &tag).await?;
    Ok(Release {
        commit: sha.to_string(),
        tag,
        digest,
        repository,
    })
}
