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
//! afterwards which of its tags is that pipeline's, and the digest
//! behind it. GitLab doesn't record what a pipeline pushed, so the tag
//! is matched back to the pipeline by its name, which usually has the
//! commit in it, or failing that by when it was pushed. Rolling out by
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

use std::time::Duration;

use k8s_openapi::jiff::{SignedDuration, Timestamp};
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

// A tag's details. The list of tags has only names; the digest and
// when it was pushed take a request per tag.
#[derive(Debug, Deserialize)]
struct Tag {
    name: String,
    digest: Option<String>,
    created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TagName {
    name: String,
}

// One pipeline, for when it ran
#[derive(Debug, Deserialize)]
struct PipelineTimes {
    created_at: Option<String>,
    started_at: Option<String>,
    updated_at: Option<String>,
    finished_at: Option<String>,
}

/// What became of looking for a pipeline's image.
#[derive(Debug, PartialEq)]
pub enum Image {
    /// The repository isn't one of the project's own, so the registry
    /// can't be asked through GitLab
    Elsewhere,

    /// The image, by the tag it was found under, with its digest when
    /// the registry gave one
    Found { tag: String, digest: Option<String> },

    /// The repository is the project's, but nothing in it is this
    /// pipeline's: why, with the tags it does have, so whoever reads it
    /// can see what CI actually pushes
    Missing(String),
}

/// How to find a pipeline's image among the registry's tags.
pub struct Finding<'a> {
    /// The registry repository, e.g. registry.gitlab.com/group/app
    pub repository: &'a str,

    /// `imageTag`, when it's set; otherwise each of LIKELY_TEMPLATES
    pub template: Option<&'a str>,

    /// Whether to fall back to whatever was pushed while the pipeline ran
    pub by_push_time: bool,
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

// How long a request to GitLab may take, connecting included, and how
// long connecting may. Without them a request whose connection goes
// quiet waits forever: no answer, and no error either. One reconcile of
// an application at a time, so that application would be stuck until
// Cirrus restarts, its later changes never seen, while every other one
// carried on. A connection cut off mid-request by a network outage did
// exactly that. A timeout makes it an error, logged and tried again.
//
// Thirty seconds is far longer than any of these requests takes, long
// lists of tags and pipelines included, so it only ends one that has
// stopped.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// How many of the registry's tags an error lists
const TAGS_SHOWN: usize = 5;

// How much of an answer that isn't GitLab's JSON goes in an error
const BODY_SHOWN: usize = 200;

impl GitLab {
    pub fn new(base: &str, token: &str) -> Self {
        Self::with_timeout(base, token, REQUEST_TIMEOUT)
    }

    /// As `new`, with requests given `timeout` to finish.
    ///
    /// @param base
    /// @param token
    /// @param timeout
    /// @returns
    fn with_timeout(base: &str, token: &str, timeout: Duration) -> Self {
        crate::install_crypto_provider();
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(CONNECT_TIMEOUT.min(timeout))
                .timeout(timeout)
                .build()
                .expect("a reqwest client builds"),
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

    /// The image `pipeline` published, looked for as `finding` says:
    /// by the tag `imageTag` makes or, without one, by each of the
    /// usual ways of tagging with the commit, then, when asked for, by
    /// when it was pushed. A tag a template makes is looked up
    /// directly rather than searched for in the listing, which is a
    /// page per hundred tags in name order, not newest first.
    pub async fn find_image(&self, project: &str, pipeline: &Pipeline, finding: &Finding<'_>) -> Result<Image> {
        let Some(repository) = self.registry_repository(project, finding.repository).await? else {
            return Ok(Image::Elsewhere);
        };
        let templates = finding
            .template
            .map_or(LIKELY_TEMPLATES.to_vec(), |template| vec![template]);
        let mut tried = Vec::new();
        for template in templates {
            let name = render_tag(template, &pipeline.sha, &pipeline.git_ref);
            if let Some(tag) = self.tag(project, repository, &name).await? {
                return Ok(Image::Found {
                    tag: tag.name,
                    digest: tag.digest,
                });
            }
            tried.push(name);
        }

        let names = self.tag_names(project, repository).await?;
        let mut pushed = None;
        if finding.by_push_time {
            match self
                .pushed_during(project, repository, pipeline, &names, &tried)
                .await?
            {
                Pushed::One(tag) => {
                    return Ok(Image::Found {
                        tag: tag.name,
                        digest: tag.digest,
                    });
                }
                other => pushed = Some(other),
            }
        }
        Ok(Image::Missing(missing_tag_message(
            finding,
            pipeline,
            &names,
            pushed.as_ref(),
        )))
    }

    /// The id of `location` among the project's registry repositories,
    /// if it's one of them.
    async fn registry_repository(&self, project: &str, location: &str) -> Result<Option<u64>> {
        let repositories: Vec<Repository> = self
            .get(
                self.project_url(project, "/registry/repositories?per_page=100"),
                &format!("reading the container registry of {project}"),
                &READ,
            )
            .await?;
        Ok(repositories.iter().find(|r| r.location == location).map(|r| r.id))
    }

    /// A tag's details, or None when there's no such tag.
    async fn tag(&self, project: &str, repository: u64, name: &str) -> Result<Option<Tag>> {
        let url = self.project_url(
            project,
            &format!("/registry/repositories/{repository}/tags/{}", urlencoding::encode(name)),
        );
        match self
            .get::<Tag>(url, &format!("reading the container registry of {project}"), &READ)
            .await
        {
            Ok(tag) => Ok(Some(tag)),
            Err(Error::GitLab { status, .. }) if status == StatusCode::NOT_FOUND => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The first page of a repository's tag names.
    async fn tag_names(&self, project: &str, repository: u64) -> Result<Vec<String>> {
        let url = self.project_url(
            project,
            &format!("/registry/repositories/{repository}/tags?per_page=100"),
        );
        let tags: Vec<TagName> = self
            .get(url, &format!("reading the container registry of {project}"), &READ)
            .await?;
        Ok(tags.into_iter().map(|tag| tag.name).collect())
    }

    /// When a pipeline ran: from its start (or creation) to its finish
    /// (or last update), with PUSH_SLACK added to the end.
    async fn pipeline_window(&self, project: &str, id: u64) -> Result<Option<(Timestamp, Timestamp)>> {
        let times: PipelineTimes = self
            .get(
                self.project_url(project, &format!("/pipelines/{id}")),
                &format!("looking up pipeline {id} on {project}"),
                &READ,
            )
            .await?;
        let parse = |text: Option<String>| text.and_then(|text| text.parse::<Timestamp>().ok());
        let start = parse(times.started_at).or(parse(times.created_at));
        let end = parse(times.finished_at).or(parse(times.updated_at));
        Ok(start.zip(end).map(|(start, end)| (start, end + PUSH_SLACK)))
    }

    /// The image pushed while `pipeline` ran, among the tags not
    /// already `tried` by name. Tags that look like another commit's
    /// are skipped: had the pipeline tagged its image with its own
    /// commit, a template would have found it.
    async fn pushed_during(
        &self,
        project: &str,
        repository: u64,
        pipeline: &Pipeline,
        names: &[String],
        tried: &[String],
    ) -> Result<Pushed> {
        let Some((start, end)) = self.pipeline_window(project, pipeline.id).await? else {
            return Ok(Pushed::Nothing);
        };
        let candidates = names
            .iter()
            .filter(|name| !tried.contains(name) && !names_a_commit(name))
            .take(PUSH_TIME_LOOKUPS);
        let mut found: Vec<Tag> = Vec::new();
        for name in candidates {
            let Some(tag) = self.tag(project, repository, name).await? else {
                continue;
            };
            let pushed = tag
                .created_at
                .as_deref()
                .and_then(|text| text.parse::<Timestamp>().ok());
            if pushed.is_some_and(|pushed| start <= pushed && pushed <= end) {
                found.push(tag);
            }
        }
        let mut digests: Vec<&Option<String>> = found.iter().map(|tag| &tag.digest).collect();
        digests.sort();
        digests.dedup();
        Ok(match digests.len() {
            0 => Pushed::Nothing,
            // Several tags on one image, like latest and v1.2: any will
            // do, since the digest is what's rolled out
            1 => Pushed::One(found.swap_remove(0)),
            _ => Pushed::Several(found.into_iter().map(|tag| tag.name).collect()),
        })
    }
}

// What was pushed while a pipeline ran
enum Pushed {
    Nothing,
    One(Tag),
    Several(Vec<String>),
}

// How long after a pipeline finishes a push still counts as its own:
// GitLab and its registry keep separate clocks
const PUSH_SLACK: SignedDuration = SignedDuration::from_secs(60);

// The most tags whose details are fetched looking for one pushed while
// a pipeline ran. Each is a request, on every poll that hasn't found
// the image yet.
const PUSH_TIME_LOOKUPS: usize = 20;

/// Whether a tag looks like one made from a commit: 7 to 40 hex
/// digits, perhaps after a ref and a dash.
fn names_a_commit(name: &str) -> bool {
    let last = name.rsplit('-').next().unwrap_or(name);
    (7..=40).contains(&last.len()) && last.chars().all(|c| c.is_ascii_hexdigit())
}

/// GitLab's refusal of `what`, as an error that says what to change.
fn refusal(what: &str, needs: &Needs, status: StatusCode, body: &str) -> Error {
    let (code, said) = gitlab_says(body);
    let advice = match status {
        StatusCode::UNAUTHORIZED => Some("the token wasn't accepted; it may have expired or been revoked".to_string()),
        // A classic token without the scope, or a fine-grained one
        // without the permission (GitLab names the one it wanted)
        StatusCode::FORBIDDEN
            if matches!(
                code.as_deref(),
                Some("insufficient_scope" | "insufficient_granular_scope")
            ) =>
        {
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

// The templates tried when imageTag isn't set, and checked against a
// missing tag for suggesting one when it is.
// The usual ways a GitLab pipeline tags its image: $CI_COMMIT_SHA,
// $CI_COMMIT_SHORT_SHA, and either with the branch in front.
const LIKELY_TEMPLATES: [&str; 4] = ["{commit_sha}", "{short_sha}", "{ref}-{commit_sha}", "{ref}-{short_sha}"];

/// Why a pipeline's image couldn't be found, and what to set instead,
/// from the tags the registry does have and, when it was looked at,
/// what was pushed while the pipeline ran.
fn missing_tag_message(finding: &Finding<'_>, pipeline: &Pipeline, tags: &[String], pushed: Option<&Pushed>) -> String {
    let (sha, git_ref, repository) = (&pipeline.sha, &pipeline.git_ref, finding.repository);
    let short = &sha[..sha.len().min(8)];
    let mut message = match finding.template {
        Some(template) => format!(
            "pipeline {short} on {git_ref} published no image {repository}:{} (imageTag is \"{template}\")",
            render_tag(template, sha, git_ref)
        ),
        None => format!(
            "pipeline {short} on {git_ref} published no image to {repository} tagged with its commit (its SHA or the \
             first 8 characters of it, with or without \"{}-\" in front)",
            render_tag("{ref}", sha, git_ref)
        ),
    };
    // Only for a set imageTag: without one, these were all looked for
    let suggestion = finding.template.and_then(|_| {
        LIKELY_TEMPLATES
            .iter()
            .find(|candidate| tags.contains(&render_tag(candidate, sha, git_ref)))
    });
    if let Some(candidate) = suggestion {
        message.push_str(&format!(
            ". The registry has it as {}, so imageTag should probably be \"{candidate}\", or left out to have it found",
            render_tag(candidate, sha, git_ref)
        ));
        return message;
    }
    if tags.is_empty() {
        message.push_str(". The repository has no tags at all, so CI may not be pushing to it");
        return message;
    }
    let shown: Vec<&str> = tags.iter().take(TAGS_SHOWN).map(String::as_str).collect();
    let more = tags.len().saturating_sub(TAGS_SHOWN);
    message.push_str(&format!(". Its tags include {}", shown.join(", ")));
    if more > 0 {
        message.push_str(&format!(" and {more} more"));
    }
    message.push_str(&match pushed {
        None => ". If CI tags images some other way, set imageTag to match, or findImageByPushTime to take the \
                  image pushed while the pipeline ran"
            .to_string(),
        Some(Pushed::Nothing) => ". Nothing was pushed to it while the pipeline ran either".to_string(),
        Some(Pushed::Several(names)) => format!(
            ". Different images were pushed while the pipeline ran ({}), so which is its can't be told; set imageTag",
            names.join(", ")
        ),
        Some(Pushed::One(_)) => String::new(),
    });
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn gives_up_on_a_gitlab_that_never_answers() {
        let server = MockServer::start().await;
        // Takes the request and says nothing, as a connection gone quiet
        // mid-request does
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(60)))
            .mount(&server)
            .await;
        let gitlab = GitLab::with_timeout(&server.uri(), "token", Duration::from_millis(200));

        let started = std::time::Instant::now();
        let result = gitlab.successful_pipelines("group/project", "main", 1).await;
        assert!(
            result.is_err(),
            "expected a timeout, got {:?}",
            result.map(|each| each.len())
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

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

    fn pipeline() -> Pipeline {
        Pipeline {
            id: 5,
            sha: "0123456789abcdef".into(),
            git_ref: "main".into(),
            status: "success".into(),
        }
    }

    fn finding(template: Option<&str>, by_push_time: bool) -> Finding<'_> {
        Finding {
            repository: "registry.gitlab.com/acme/shop",
            template,
            by_push_time,
        }
    }

    fn names(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|tag| tag.to_string()).collect()
    }

    #[test]
    fn suggests_the_template_the_registry_matches() {
        let message = missing_tag_message(
            &finding(Some("{commit_sha}"), false),
            &pipeline(),
            &names(&["latest", "01234567"]),
            None,
        );
        assert!(
            message.contains("no image registry.gitlab.com/acme/shop:0123456789abcdef"),
            "{message}"
        );
        assert!(
            message.contains("imageTag should probably be \"{short_sha}\", or left out"),
            "{message}"
        );
    }

    #[test]
    fn lists_tags_when_nothing_matches() {
        let tags = names(&["latest", "a", "b", "c", "d", "e"]);
        let message = missing_tag_message(&finding(None, false), &pipeline(), &tags, None);
        assert!(message.contains("tagged with its commit"), "{message}");
        assert!(message.contains("with or without \"main-\""), "{message}");
        assert!(
            message.contains("tags include latest, a, b, c, d and 1 more"),
            "{message}"
        );
        assert!(message.contains("findImageByPushTime"), "{message}");

        let message = missing_tag_message(&finding(None, true), &pipeline(), &tags, Some(&Pushed::Nothing));
        assert!(
            message.contains("Nothing was pushed to it while the pipeline ran"),
            "{message}"
        );

        let several = Pushed::Several(names(&["latest", "v2"]));
        let message = missing_tag_message(&finding(None, true), &pipeline(), &tags, Some(&several));
        assert!(
            message.contains("Different images were pushed while the pipeline ran (latest, v2)"),
            "{message}"
        );

        let message = missing_tag_message(&finding(None, false), &pipeline(), &[], None);
        assert!(message.contains("no tags at all"), "{message}");
    }

    #[test]
    fn knows_a_commit_tag() {
        assert!(names_a_commit("a61df038"));
        assert!(names_a_commit("main-a61df038bcfc0b979fdffbff5b8abd9400d3f243"));
        assert!(!names_a_commit("latest"));
        assert!(!names_a_commit("v1.2.3"));
        assert!(!names_a_commit("cafe"));
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

        // What a fine-grained token without the permission gets
        let granular = refusal(
            "saving the webhook on acme/shop",
            &HOOKS,
            StatusCode::FORBIDDEN,
            r#"{"error":"insufficient_granular_scope","error_description":"Access denied: This operation requires a fine-grained personal access token with the following project permissions: [Webhook: Create]."}"#,
        )
        .to_string();
        assert!(granular.contains("it needs the api scope"), "{granular}");
        assert!(!granular.contains("Maintainer"), "{granular}");
        assert!(granular.contains("[Webhook: Create]"), "{granular}");

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

    // The project's one registry repository, id 7
    async fn registry() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories"))
            .and(header("PRIVATE-TOKEN", "t"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!([{"id": 7, "location": "registry.gitlab.com/acme/shop"}])),
            )
            .mount(&server)
            .await;
        server
    }

    async fn tag(server: &MockServer, name: &str, digest: &str, created_at: &str) {
        Mock::given(method("GET"))
            .and(path(format!(
                "/api/v4/projects/acme%2Fshop/registry/repositories/7/tags/{name}"
            )))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"name": name, "digest": digest, "created_at": created_at})),
            )
            .mount(server)
            .await;
    }

    async fn tag_list(server: &MockServer, tags: &[&str]) {
        let tags: Vec<_> = tags.iter().map(|name| json!({"name": name})).collect();
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories/7/tags"))
            .respond_with(ResponseTemplate::new(200).set_body_json(tags))
            .mount(server)
            .await;
    }

    // Pipeline 5 ran from 10:00 to 10:10
    async fn pipeline_times(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/pipelines/5"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": 5,
                "created_at": "2026-11-23T09:59:00Z",
                "started_at": "2026-11-23T10:00:00Z",
                "finished_at": "2026-11-23T10:10:00Z",
                "updated_at": "2026-11-23T10:10:00Z"
            })))
            .mount(server)
            .await;
    }

    // Anything not mounted is a 404, which is what GitLab says of a
    // tag that isn't there
    #[tokio::test]
    async fn finds_the_tag_by_the_usual_templates_when_image_tag_is_unset() {
        let server = registry().await;
        tag(&server, "01234567", "sha256:feed", "2026-11-23T10:05:00Z").await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let found = gitlab
            .find_image("acme/shop", &pipeline(), &finding(None, false))
            .await
            .unwrap();
        assert_eq!(
            found,
            Image::Found {
                tag: "01234567".into(),
                digest: Some("sha256:feed".into())
            }
        );
    }

    // Several images built from one project, as a bake group pushes
    // them: each application names its own repository, and finds its
    // pipeline's tag there and not in the others
    #[tokio::test]
    async fn each_image_from_one_project_is_found_in_its_own_repository() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v4/projects/acme%2Fshop/registry/repositories"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": 7, "location": "registry.gitlab.com/acme/shop"},
                {"id": 8, "location": "registry.gitlab.com/acme/shop/api"}
            ])))
            .mount(&server)
            .await;
        for (repository, digest) in [(7, "sha256:web"), (8, "sha256:api")] {
            Mock::given(method("GET"))
                .and(path(format!(
                    "/api/v4/projects/acme%2Fshop/registry/repositories/{repository}/tags/01234567"
                )))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(
                        json!({"name": "01234567", "digest": digest, "created_at": "2026-11-23T10:05:00Z"}),
                    ),
                )
                .mount(&server)
                .await;
        }

        let gitlab = GitLab::new(&server.uri(), "t");
        for (repository, digest) in [
            ("registry.gitlab.com/acme/shop", "sha256:web"),
            ("registry.gitlab.com/acme/shop/api", "sha256:api"),
        ] {
            let found = gitlab
                .find_image(
                    "acme/shop",
                    &pipeline(),
                    &Finding {
                        repository,
                        ..finding(None, false)
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                found,
                Image::Found {
                    tag: "01234567".into(),
                    digest: Some(digest.into())
                }
            );
        }
    }

    #[tokio::test]
    async fn a_set_image_tag_is_the_only_one_tried() {
        let server = registry().await;
        tag(&server, "01234567", "sha256:feed", "2026-11-23T10:05:00Z").await;
        tag_list(&server, &["01234567"]).await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let found = gitlab
            .find_image("acme/shop", &pipeline(), &finding(Some("{commit_sha}"), false))
            .await
            .unwrap();
        let Image::Missing(why) = found else {
            panic!("{found:?}")
        };
        assert!(why.contains("imageTag should probably be \"{short_sha}\""), "{why}");

        let elsewhere = Finding {
            repository: "ghcr.io/acme/shop",
            ..finding(None, false)
        };
        assert_eq!(
            gitlab.find_image("acme/shop", &pipeline(), &elsewhere).await.unwrap(),
            Image::Elsewhere
        );
    }

    #[tokio::test]
    async fn falls_back_to_what_was_pushed_while_the_pipeline_ran() {
        let server = registry().await;
        pipeline_times(&server).await;
        tag_list(&server, &["0aaaaaaa", "latest", "old", "v1.2"]).await;
        tag(&server, "latest", "sha256:new", "2026-11-23T10:08:00Z").await;
        tag(&server, "v1.2", "sha256:new", "2026-11-23T10:08:01Z").await;
        tag(&server, "old", "sha256:old", "2026-11-22T08:00:00Z").await;
        // Another commit's: never looked at
        Mock::given(method("GET"))
            .and(path(
                "/api/v4/projects/acme%2Fshop/registry/repositories/7/tags/0aaaaaaa",
            ))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let found = gitlab
            .find_image("acme/shop", &pipeline(), &finding(None, true))
            .await
            .unwrap();
        assert_eq!(
            found,
            Image::Found {
                tag: "latest".into(),
                digest: Some("sha256:new".into())
            }
        );

        // Without being asked to, it doesn't
        let missing = gitlab
            .find_image("acme/shop", &pipeline(), &finding(None, false))
            .await
            .unwrap();
        assert!(matches!(missing, Image::Missing(_)), "{missing:?}");
    }

    #[tokio::test]
    async fn different_images_pushed_while_it_ran_are_not_guessed_between() {
        let server = registry().await;
        pipeline_times(&server).await;
        tag_list(&server, &["latest", "v2"]).await;
        tag(&server, "latest", "sha256:one", "2026-11-23T10:04:00Z").await;
        tag(&server, "v2", "sha256:two", "2026-11-23T10:06:00Z").await;

        let gitlab = GitLab::new(&server.uri(), "t");
        let found = gitlab
            .find_image("acme/shop", &pipeline(), &finding(None, true))
            .await
            .unwrap();
        let Image::Missing(why) = found else {
            panic!("{found:?}")
        };
        assert!(why.contains("Different images"), "{why}");
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
