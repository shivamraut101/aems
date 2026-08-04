use serde::{Deserialize, Serialize};

/// Agent state that survives a restart.
///
/// The device token is the only secret here. It is stored through the Tauri store
/// plugin rather than a plain file so it lands in the OS-appropriate app data
/// directory on both platforms.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentConfig {
    pub api_url: String,
    pub device_id: Option<String>,
    pub device_token: Option<String>,
    pub profile_id: Option<String>,
    pub company_id: Option<String>,
    /// Version the employee agreed to. Cleared when the policy changes, which forces
    /// a fresh consent prompt before collection resumes.
    pub consented_policy_version: Option<String>,
    pub policy: Option<AgentPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPolicy {
    pub version: String,
    pub name: String,
    pub screenshot_interval_seconds: u64,
    pub idle_threshold_seconds: u64,
    pub tracked_categories: Vec<String>,
}

impl AgentConfig {
    pub fn api_url(&self) -> String {
        if self.api_url.is_empty() {
            std::env::var("AEMS_API_URL").unwrap_or_else(|_| "http://localhost:3001".to_string())
        } else {
            self.api_url.clone()
        }
    }

    /// Whether the agent is allowed to collect anything at all.
    ///
    /// Enrolment alone is not enough — consent must be on file, and it must be for
    /// the policy version currently in force.
    pub fn may_collect(&self) -> bool {
        let (Some(_), Some(policy), Some(consented)) = (
            self.device_token.as_ref(),
            self.policy.as_ref(),
            self.consented_policy_version.as_ref(),
        ) else {
            return false;
        };

        &policy.version == consented
    }
}
