//! @file
//! What Cirrus asks of GitLab: a webhook, the newest good pipelines,
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
//! When GitLab refuses, what it says is kept. A bare "403 Forbidden"
//! could be a token with too narrow a scope or one whose user has too
//! low a role, and the fix for each is in a different place, so the
//! error says which, and what the request needed.
//!
//! Only the handful of endpoints Cirrus needs are here, through
//! reqwest; a GitLab client crate would bring far more than that.

use reqwest::StatusCode;
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

#[derive(Debug, Deserialize)]
struct TagName {
    name: String,
}

/// What became of looking up an image tag.
#[derive(Debug, PartialEq)]
pub enum ImageTag {
    /// The repository isn't one of the project's own, so the registry
    /// can't be asked through GitLab and the image is rolled out by tag
    Elsewhere,

    /// The tag is there, with its digest when the registry gave one
    Found(Option<String>),

    /// The repository is the project's, but has no such tag. With the
    /// tags it does have, or the first page of them, so whoever reads
    /// the error can see what CI actually pushes.
    Missing(Vec<String>),
}

/// What a request needs of the token, for saying so when GitLab
/// refuses it.
struct Needs {
    scope: &'static str,
    role: &'static str,
}

// Pipelines and the registry
const READ: Needs = Needs {
    scope: "the read_api or api scope (on a fine-grained token, Pipeline: Read and Container Repository: Read)",
    role: "Reporter",
};

// Anything to do with the project's webhooks, listing them included
const HOOKS: Needs = Needs {
    scope: "the api scope (on a fine-grained token, Webhook: Read, Create, Update and Delete)",
    role: "Maintainer",
};

// How many of the registry's tags an error lists
const TAGS_SHOWN: usize = 5;

// How much of an answer that isn't GitLab's JSON goes in an error
const BODY_SHOWN: usize = 200;

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

    /// Send a request, and turn anything but success into an error
    /// that says what was being done and why GitLab refused.
    async fn send(&self, request: reqwest::RequestBuilder, what: &str, needs: &Needs) -> Result<reqwest::Response> {
        let response = request.header("PRIVATE-TOKEN", &self.token).send().await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        Err(refusal(what, needs, status, &body))
    }

    async fn get<T: serde::de::DeserializeOwned>(&self, url: String, what: &str, needs: &Needs) -> Result<T> {
        Ok(self.send(self.http.get(url), what, needs).await?.json().await?)
    }

    /// Make sure the project has a hook at `url` for pipeline events,
    /// with `token` as its secret, and return its id. An existing hook
    /// at the same address is updated rather than duplicated, since
    /// GitLab never reveals a hook's token to check it.
    pub async fn ensure_hook(&self, project: &str, url: &str, token: &str) -> Result<u64> {
        let hooks: Vec<Hook> = self
            .get(
                self.project_url(project, "/hooks?per_page=100"),
                &format!("listing the webhooks on {project}"),
                &HOOKS,
            )
            .await?;
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
        let response = self
            .send(request.json(&body), &format!("saving the webhook on {project}"), &HOOKS)
            .await?;
        let hook: Hook = response.json().await?;
        Ok(hook.id)
    }

    /// Remove a hook. One already gone counts as removed.
    pub async fn delete_hook(&self, project: &str, id: u64) -> Result<()> {
        let request = self.http.delete(self.project_url(project, &format!("/hooks/{id}")));
        match self
            .send(request, &format!("removing webhook {id} from {project}"), &HOOKS)
            .await
        {
            Ok(_) => Ok(()),
            Err(Error::GitLab { status, .. }) if status == StatusCode::NOT_FOUND => Ok(()),
            Err(error) => Err(error),
        }
    }

    /// The newest successful pipelines on a branch or tag, newest
    /// first, at most `count` of them.
    pub async fn successful_pipelines(&self, project: &str, git_ref: &str, count: u8) -> Result<Vec<Pipeline>> {
        let url = self.project_url(
            project,
            &format!(
                "/pipelines?ref={}&status=success&order_by=id&sort=desc&per_page={count}",
                urlencoding::encode(git_ref)
            ),
        );
        self.get(url, &format!("looking up the pipelines on {project}"), &READ)
            .await
    }

    /// Look up a tag in `repository`, when that's one of the project's
    /// own registry repositories.
    pub async fn image_tag(&self, project: &str, repository: &str, tag: &str) -> Result<ImageTag> {
        let what = format!("reading the container registry of {project}");
        let repositories: Vec<Repository> = self
            .get(
                self.project_url(project, "/registry/repositories?per_page=100"),
                &what,
                &READ,
            )
            .await?;
        let Some(found) = repositories.iter().find(|r| r.location == repository) else {
            return Ok(ImageTag::Elsewhere);
        };
        let url = self.project_url(
            project,
            &format!("/registry/repositories/{}/tags/{}", found.id, urlencoding::encode(tag)),
        );
        match self.get::<Tag>(url, &what, &READ).await {
            Ok(tag) => Ok(ImageTag::Found(tag.digest)),
            Err(Error::GitLab { status, .. }) if status == StatusCode::NOT_FOUND => {
                let url = self.project_url(
                    project,
                    &format!("/registry/repositories/{}/tags?per_page=100", found.id),
                );
                let tags: Vec<TagName> = self.get(url, &what, &READ).await?;
                Ok(ImageTag::Missing(tags.into_iter().map(|tag| tag.name).collect()))
            }
            Err(error) => Err(error),
        }
    }
}

/// GitLab's refusal of `what`, as an error that says what to change.
fn refusal(what: &str, needs: &Needs, status: StatusCode, body: &str) -> Error {
    let (code, said) = gitlab_says(body);
    let advice = match status {
        StatusCode::UNAUTHORIZED => Some("the token wasn't accepted; it may have expired or been revoked".to_string()),
        StatusCode::FORBIDDEN if code.as_deref() == Some("insufficient_scope") => {
            Some(format!("the token's scope doesn't allow it: it needs {}", needs.scope))
        }
        StatusCode::FORBIDDEN => Some(format!(
            "the token's scope allows it, but its user doesn't: it needs the {} role on the project, or above",
            needs.role
        )),
        _ => None,
    };
    let message = match advice {
        Some(advice) => format!("{what} was refused ({status}): {advice}. GitLab said: {said}"),
        None => format!("{what} answered {status}: {said}"),
    };
    Error::GitLab { status, message }
}

/// What GitLab said, from one of the shapes of its error bodies: an
/// OAuth-style `error`, with its description, or a `message`. The
/// first is returned again on its own, since it's the code that tells
/// a scope apart from a role.
fn gitlab_says(body: &str) -> (Option<String>, String) {
    let text = || body.trim().chars().take(BODY_SHOWN).collect::<String>();
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return (None, text());
    };
    let code = parsed["error"].as_str().map(str::to_string);
    let said = match (&code, parsed["error_description"].as_str(), &parsed["message"]) {
        (Some(code), Some(description), _) => format!("{code}: {description}"),
        (Some(code), None, _) => code.clone(),
        (None, _, serde_json::Value::String(message)) => message.clone(),
        // GitLab's validation errors are an object of field names
        (None, _, message) if !message.is_null() => message.to_string(),
        _ => text(),
    };
    (code, said)
}

/// Fill in an image tag template from a pipeline.
pub fn render_tag(template: &str, sha: &str, git_ref: &str) -> String {
    let short = &sha[..sha.len().min(8)];
    template
        .replace("{commit_sha}", sha)
        .replace("{short_sha}", short)
        .replace("{ref}", &git_ref.replace('/', "-"))
}

// The templates a missing tag is checked against, for suggesting one.
// The usual ways a GitLab pipeline tags its image: $CI_COMMIT_SHA,
// $CI_COMMIT_SHORT_SHA, and either with the branch in front.
const LIKELY_TEMPLATES: [&str; 4] = ["{commit_sha}", "{short_sha}", "{ref}-{commit_sha}", "{ref}-{short_sha}"];

/// Why a pipeline's image couldn't be found, and what `imageTag` might
/// be instead, from the tags the registry does have.
pub fn missing_tag_message(repository: &str, template: &str, sha: &str, git_ref: &str, tags: &[String]) -> String {
    let tag = render_tag(template, sha, git_ref);
    let short = &sha[..sha.len().min(8)];
    let mut message =
        format!("pipeline {short} on {git_ref} published no image {repository}:{tag} (imageTag is \"{template}\")");
    let suggestion = LIKELY_TEMPLATES
        .iter()
        .find(|candidate| tags.contains(&render_tag(candidate, sha, git_ref)));
    if let Some(candidate) = suggestion {
        message.push_str(&format!(
            ". The registry has it as {}, so imageTag should probably be \"{candidate}\"",
            render_tag(candidate, sha, git_ref)
        ));
    } else if tags.is_empty() {
        message.push_str(". The repository has no tags at all, so CI may not be pushing to it");
    } else {
        let shown: Vec<&str> = tags.iter().take(TAGS_SHOWN).map(String::as_str).collect();
        let more = tags.len().saturating_sub(TAGS_SHOWN);
        message.push_str(&format!(". Its tags include {}", shown.join(", ")));
        if more > 0 {
            message.push_str(&format!(" and {more} more"));
        }
        if tags.iter().any(|tag| tag == "latest") {
            message.push_str(". If CI only pushes latest, set imageTag to \"latest\"");
        }
    }
    message
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

    #[test]
    fn suggests_the_template_the_registry_matches() {
        let tags = vec!["latest".to_string(), "01234567".to_string()];
        let message = missing_tag_message("r/shop", "{commit_sha}", "0123456789abcdef", "main", &tags);
        assert!(message.contains("no image r/shop:0123456789abcdef"), "{message}");
        assert!(
            message.contains("imageTag should probably be \"{short_sha}\""),
            "{message}"
        );
    }

    #[test]
    fn lists_tags_when_nothing_matches() {
        let tags: Vec<String> = ["latest", "a", "b", "c", "d", "e"]
            .iter()
            .map(|t| t.to_string())
            .collect();
        let message = missing_tag_message("r/shop", "{commit_sha}", "0123456789abcdef", "main", &tags);
        assert!(
            message.contains("tags include latest, a, b, c, d and 1 more"),
            "{message}"
        );
        assert!(message.contains("set imageTag to \"latest\""), "{message}");

        let message = missing_tag_message("r/shop", "{commit_sha}", "0123456789abcdef", "main", &[]);
        assert!(message.contains("no tags at all"), "{message}");
    }

    #[test]
    fn tells_a_scope_from_a_role() {
        let scope = refusal(
            "saving the webhook on acme/shop",
            &HOOKS,
            StatusCode::FORBIDDEN,
            r#"{"error":"insufficient_scope","error_description":"The request requires higher privileges than provided by the access token.","scope":"api"}"#,
        )
        .to_string();
        assert!(scope.contains("saving the webhook on acme/shop was refused"), "{scope}");
        assert!(scope.contains("it needs the api scope"), "{scope}");
        assert!(scope.contains("GitLab said: insufficient_scope"), "{scope}");

        let role = refusal(
            "saving the webhook on acme/shop",
            &HOOKS,
            StatusCode::FORBIDDEN,
            r#"{"message":"403 Forbidden"}"#,
        )
        .to_string();
        assert!(role.contains("the Maintainer role"), "{role}");
        assert!(role.contains("GitLab said: 403 Forbidden"), "{role}");

        let expired = refusal(
            "x",
            &READ,
            StatusCode::UNAUTHORIZED,
            r#"{"message":"401 Unauthorized"}"#,
        )
        .to_string();
        assert!(expired.contains("expired or been revoked"), "{expired}");

        let other = refusal("x", &READ, StatusCode::BAD_GATEWAY, "<html>bad gateway</html>").to_string();
        assert_eq!(other, "forge: x answered 502 Bad Gateway: <html>bad gateway</html>");
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
        let found = gitlab
            .image_tag("acme/shop", "registry.gitlab.com/acme/shop", "abc")
            .await
            .unwrap();
        assert_eq!(found, ImageTag::Found(Some("sha256:feed".into())));
        let elsewhere = gitlab.image_tag("acme/shop", "ghcr.io/acme/shop", "abc").await.unwrap();
        assert_eq!(elsewhere, ImageTag::Elsewhere);
    }

    #[tokio::test]
    async fn a_missing_tag_comes_back_with_the_tags_there_are() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!([{"id": 7, "location": "registry.gitlab.com/acme/shop"}])),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories/7/tags/abc"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({"message": "404 Tag Not Found"})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories/7/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{"name": "latest"}])))
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let missing = gitlab
            .image_tag("acme/shop", "registry.gitlab.com/acme/shop", "abc")
            .await
            .unwrap();
        assert_eq!(missing, ImageTag::Missing(vec!["latest".into()]));
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
    async fn a_refused_hook_says_why() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/hooks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/v4/projects/acme%2Fshop/hooks"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({"message": "403 Forbidden"})))
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let error = gitlab
            .ensure_hook("acme/shop", "https://c/hooks/gitlab/ns/shop", "secret")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("saving the webhook on acme/shop was refused"), "{error}");
        assert!(error.contains("Maintainer"), "{error}");
    }

    #[tokio::test]
    async fn finds_the_newest_successful_pipelines() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/pipelines"))
            .and(query_param("ref", "main"))
            .and(query_param("status", "success"))
            .and(query_param("per_page", "5"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": 99, "sha": "abc", "ref": "main", "status": "success"},
                {"id": 98, "sha": "abb", "ref": "main", "status": "success"}
            ])))
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let pipelines = gitlab.successful_pipelines("acme/shop", "main", 5).await.unwrap();
        assert_eq!(pipelines.len(), 2);
        assert_eq!(pipelines[0].sha, "abc");
    }
}
