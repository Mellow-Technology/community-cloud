//! @file
//! The ways a reconcile or a webhook can fail.
//!
//! Most failures are worth retrying and say nothing to the person who
//! wrote the WebApplication. A few are about their cluster or their
//! resource — a service that isn't installed, a namespace not let in
//! to the Gateway — and those are kept apart so they can be written
//! into a condition, where `kubectl describe` shows them.

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Kubernetes API: {0}")]
    Kube(#[from] kube::Error),

    #[error("{0}")]
    MissingService(String),

    #[error("{0}")]
    NotPermitted(String),

    #[error("{0}")]
    Config(String),

    #[error("forge: {0}")]
    Forge(String),

    #[error("finalizer: {0}")]
    Finalizer(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl From<reqwest::Error> for Error {
    fn from(error: reqwest::Error) -> Self {
        Error::Forge(error.to_string())
    }
}
