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
use gitlab::{Finding, GitLab, Image, Pipeline};

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

/// What a pipeline left to roll out.
pub enum Lookup {
    Release(Release),

    /// The pipeline succeeded but its image can't be found in the
    /// registry, with why, and what to set instead. Not a failure to
    /// retry: asking again won't make the image appear.
    NoImage(String),
}

/// The release `pipeline` produced.
pub async fn release_for(
    gitlab: &GitLab,
    app: &WebApplication,
    source: &GitLabSource,
    pipeline: &Pipeline,
) -> Result<Lookup> {
    let repository = app.spec.image.repository.clone();
    let finding = Finding {
        repository: &repository,
        template: source.image_tag.as_deref(),
        by_push_time: source.find_image_by_push_time,
    };
    let (tag, digest) = match gitlab.find_image(&source.project, pipeline, &finding).await? {
        Image::Found { tag, digest } => (tag, digest),
        Image::Missing(why) => return Ok(Lookup::NoImage(why)),
        // Rolled out by the tag alone, since there's no asking what's
        // behind it; and with nothing to look through, the tag has to
        // be given
        Image::Elsewhere => match &source.image_tag {
            Some(template) => (gitlab::render_tag(template, &pipeline.sha, &pipeline.git_ref), None),
            None => {
                return Ok(Lookup::NoImage(format!(
                    "{repository} isn't one of {}'s own registry repositories, so its tags can't be looked \
                     through; set imageTag to the tag CI pushes",
                    source.project
                )));
            }
        },
    };
    Ok(Lookup::Release(Release {
        commit: pipeline.sha.clone(),
        tag,
        digest,
        repository,
    }))
}
