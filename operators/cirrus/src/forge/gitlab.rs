//! @file
//! What Cirrus asks of GitLab: a webhook, the newest good pipeline,
//! and the digest behind an image tag.
//!
//! GitLab has no webhook for "an image was pushed to the registry" —
//! the registry's own notifications are an instance-wide setting on a
//! self-managed GitLab, out of reach on gitlab.com. What a project can
//! subscribe to is its pipelines, and a successful pipeline on the
//! tracked branch is the point at which its image has been built and
//! pushed. So that's the signal, and the registry API is asked
//! afterwards which digest the tag now points at. Rolling out by
//! digest means a tag pushed again later can't change what's running
//! underneath a Deployment that hasn't been told.
//!
//! Only the handful of endpoints Cirrus needs are here, through
//! reqwest; a GitLab client crate would bring far more than that.

use serde::Deserialize;
use serde_json::json;

use crate::error::{Error, Result};

/// A GitLab instance, with a token for one project.
#[derive(Clone)]
pub struct GitLab {
    http: reqwest::Client,
    base: String,
    token: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Pipeline {
    pub id: u64,
    pub sha: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub status: String,
}

#[derive(Debug, Deserialize)]
struct Hook {
    id: u64,
    url: String,
}

#[derive(Debug, Deserialize)]
struct Repository {
    id: u64,
    location: String,
}

#[derive(Debug, Deserialize)]
struct Tag {
    digest: Option<String>,
}

impl GitLab {
    pub fn new(base: &str, token: &str) -> Self {
        crate::install_crypto_provider();
        Self {
            http: reqwest::Client::new(),
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    // A project is addressed by its numeric id or its URL-encoded
    // path, and either is accepted here
    fn project_url(&self, project: &str, rest: &str) -> String {
        format!("{}/api/v4/projects/{}{}", self.base, urlencoding::encode(project), rest)
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, url: String) -> Result<T> {
        let response = self.http.get(&url).header("PRIVATE-TOKEN", &self.token).send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Forge(format!("GET {url} answered {status}")));
        }
        Ok(response.json().await?)
    }

    /// Make sure the project has a hook at `url` for pipeline events,
    /// with `token` as its secret, and return its id. An existing hook
    /// at the same address is updated rather than duplicated, since
    /// GitLab never reveals a hook's token to check it.
    pub async fn ensure_hook(&self, project: &str, url: &str, token: &str) -> Result<u64> {
        let hooks: Vec<Hook> = self.get(self.project_url(project, "/hooks?per_page=100")).await?;
        let body = json!({
            "url": url,
            "token": token,
            "pipeline_events": true,
            "push_events": false,
            "enable_ssl_verification": true,
        });
        let request = match hooks.iter().find(|hook| hook.url == url) {
            Some(hook) => self.http.put(self.project_url(project, &format!("/hooks/{}", hook.id))),
            None => self.http.post(self.project_url(project, "/hooks")),
        };
        let response = request.header("PRIVATE-TOKEN", &self.token).json(&body).send().await?;
        let status = response.status();
        if !status.is_success() {
            return Err(Error::Forge(format!(
                "saving the webhook on {project} answered {status}"
            )));
        }
        let hook: Hook = response.json().await?;
        Ok(hook.id)
    }

    /// Remove a hook. One already gone counts as removed.
    pub async fn delete_hook(&self, project: &str, id: u64) -> Result<()> {
        let response = self
            .http
            .delete(self.project_url(project, &format!("/hooks/{id}")))
            .header("PRIVATE-TOKEN", &self.token)
            .send()
            .await?;
        let status = response.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(Error::Forge(format!(
                "removing webhook {id} from {project} answered {status}"
            )))
        }
    }

    /// The newest successful pipeline on a branch or tag.
    pub async fn latest_successful_pipeline(&self, project: &str, git_ref: &str) -> Result<Option<Pipeline>> {
        let url = self.project_url(
            project,
            &format!(
                "/pipelines?ref={}&status=success&order_by=id&sort=desc&per_page=1",
                urlencoding::encode(git_ref)
            ),
        );
        let pipelines: Vec<Pipeline> = self.get(url).await?;
        Ok(pipelines.into_iter().next())
    }

    /// The digest a tag points at, when `repository` is one of the
    /// project's own registry repositories. None when it isn't — an
    /// image kept somewhere else is then rolled out by tag.
    pub async fn resolve_digest(&self, project: &str, repository: &str, tag: &str) -> Result<Option<String>> {
        let repositories: Vec<Repository> = self
            .get(self.project_url(project, "/registry/repositories?per_page=100"))
            .await?;
        let Some(found) = repositories.iter().find(|r| r.location == repository) else {
            return Ok(None);
        };
        let url = self.project_url(
            project,
            &format!("/registry/repositories/{}/tags/{}", found.id, urlencoding::encode(tag)),
        );
        let tag: Tag = self.get(url).await?;
        Ok(tag.digest)
    }
}

/// Fill in an image tag template from a pipeline.
pub fn render_tag(template: &str, sha: &str, git_ref: &str) -> String {
    let short = &sha[..sha.len().min(8)];
    template
        .replace("{commit_sha}", sha)
        .replace("{short_sha}", short)
        .replace("{ref}", &git_ref.replace('/', "-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn renders_tags() {
        assert_eq!(
            render_tag("{commit_sha}", "0123456789abcdef", "main"),
            "0123456789abcdef"
        );
        assert_eq!(
            render_tag("{ref}-{short_sha}", "0123456789abcdef", "release/2"),
            "release-2-01234567"
        );
    }

    #[tokio::test]
    async fn resolves_a_digest_from_the_project_registry() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories"))
            .and(header("PRIVATE-TOKEN", "t"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": 7, "location": "registry.gitlab.com/acme/shop"},
                {"id": 8, "location": "registry.gitlab.com/acme/shop/worker"}
            ])))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories/7/tags/abc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"name": "abc", "digest": "sha256:feed"})))
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let digest = gitlab
            .resolve_digest("acme/shop", "registry.gitlab.com/acme/shop", "abc")
            .await
            .unwrap();
        assert_eq!(digest.as_deref(), Some("sha256:feed"));
        let elsewhere = gitlab
            .resolve_digest("acme/shop", "ghcr.io/acme/shop", "abc")
            .await
            .unwrap();
        assert_eq!(elsewhere, None);
    }

    #[tokio::test]
    async fn updates_an_existing_hook_instead_of_adding_one() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/hooks"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!([{"id": 3, "url": "https://c/hooks/gitlab/ns/shop"}])),
            )
            .mount(&server)
            .await;
        Mock::given(method("PUT"))
            .and(path("/api/v4/projects/acme%2Fshop/hooks/3"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"id": 3, "url": "https://c/hooks/gitlab/ns/shop"})),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let id = gitlab
            .ensure_hook("acme/shop", "https://c/hooks/gitlab/ns/shop", "secret")
            .await
            .unwrap();
        assert_eq!(id, 3);
    }

    #[tokio::test]
    async fn finds_the_newest_successful_pipeline() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/pipelines"))
            .and(query_param("ref", "main"))
            .and(query_param("status", "success"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": 99, "sha": "abc", "ref": "main", "status": "success"}
            ])))
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let pipeline = gitlab
            .latest_successful_pipeline("acme/shop", "main")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pipeline.sha, "abc");
    }
}
