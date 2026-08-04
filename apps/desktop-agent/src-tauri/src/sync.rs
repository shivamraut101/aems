use serde::{Deserialize, Serialize};

use crate::config::{AgentConfig, AgentPolicy};
use crate::tracker::{ActivityEvent, IdleEvent};

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("not enrolled")]
    NotEnrolled,
    #[error("consent required")]
    ConsentRequired,
    #[error("device revoked")]
    Revoked,
    #[error("api error {status}: {message}")]
    Api { status: u16, message: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentResponse {
    pub device_id: String,
    pub company_id: String,
    pub profile_id: String,
    pub device_token: String,
    pub consent_required: bool,
    pub policy: AgentPolicy,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityBatch<'a> {
    device_id: &'a str,
    work_session_id: Option<i64>,
    activity: &'a [ActivityEvent],
    idle: &'a [IdleEvent],
}

/// Talks to the Fastify API. The agent holds no Supabase credentials of its own —
/// every write goes through the API, which is where consent and revocation are
/// enforced.
pub struct SyncClient {
    http: reqwest::Client,
    base_url: String,
}

impl SyncClient {
    pub fn new(base_url: String) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            base_url,
        }
    }

    /// Trades the employee's Supabase session for a long-lived device token.
    pub async fn enroll(
        &self,
        access_token: &str,
        info: &crate::device_info::DeviceInfo,
    ) -> Result<EnrollmentResponse, SyncError> {
        let response = self
            .http
            .post(format!("{}/api/devices/enroll", self.base_url))
            .bearer_auth(access_token)
            .json(info)
            .send()
            .await?;

        Self::parse(response).await
    }

    pub async fn heartbeat(&self, config: &AgentConfig, session: Option<i64>) -> Result<(), SyncError> {
        let (Some(token), Some(device_id)) = (&config.device_token, &config.device_id) else {
            return Err(SyncError::NotEnrolled);
        };

        let response = self
            .http
            .post(format!("{}/api/devices/heartbeat", self.base_url))
            .header("X-Device-Token", token)
            .json(&serde_json::json!({ "deviceId": device_id, "workSessionId": session }))
            .send()
            .await?;

        Self::check(response).await
    }

    /// Flushes buffered events. The caller keeps its buffer until this returns Ok,
    /// so a failed flush is retried rather than dropped — every event carries a
    /// stable clientEventId, which makes the retry safe.
    pub async fn push_events(
        &self,
        config: &AgentConfig,
        session: Option<i64>,
        activity: &[ActivityEvent],
        idle: &[IdleEvent],
    ) -> Result<(), SyncError> {
        if activity.is_empty() && idle.is_empty() {
            return Ok(());
        }

        let (Some(token), Some(device_id)) = (&config.device_token, &config.device_id) else {
            return Err(SyncError::NotEnrolled);
        };

        let response = self
            .http
            .post(format!("{}/api/activity/events", self.base_url))
            .header("X-Device-Token", token)
            .json(&ActivityBatch {
                device_id,
                work_session_id: session,
                activity,
                idle,
            })
            .send()
            .await?;

        Self::check(response).await
    }

    pub async fn upload_screenshot(
        &self,
        config: &AgentConfig,
        client_event_id: &str,
        captured_at: &str,
        image: Vec<u8>,
    ) -> Result<(), SyncError> {
        let Some(token) = &config.device_token else {
            return Err(SyncError::NotEnrolled);
        };

        let part = reqwest::multipart::Part::bytes(image)
            .file_name("capture.webp")
            .mime_str("image/webp")
            .map_err(SyncError::Network)?;

        let form = reqwest::multipart::Form::new()
            .text("clientEventId", client_event_id.to_string())
            .text("capturedAt", captured_at.to_string())
            .part("file", part);

        let response = self
            .http
            .post(format!("{}/api/screenshots", self.base_url))
            .header("X-Device-Token", token)
            .multipart(form)
            .send()
            .await?;

        Self::check(response).await
    }

    async fn check(response: reqwest::Response) -> Result<(), SyncError> {
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }

        let body = response.text().await.unwrap_or_default();

        // The API signals withdrawn consent and revocation explicitly so the agent
        // can stop collecting rather than retrying forever.
        if body.contains("consent_required") {
            return Err(SyncError::ConsentRequired);
        }
        if body.contains("device_revoked") || body.contains("monitoring_disabled") {
            return Err(SyncError::Revoked);
        }

        Err(SyncError::Api {
            status: status.as_u16(),
            message: body,
        })
    }

    async fn parse<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T, SyncError> {
        let status = response.status();
        if !status.is_success() {
            return Err(SyncError::Api {
                status: status.as_u16(),
                message: response.text().await.unwrap_or_default(),
            });
        }

        response.json::<T>().await.map_err(SyncError::Network)
    }
}
