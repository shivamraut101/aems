use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

/// Active-window tracking.
///
/// Emits closed intervals: a new focus does not become an event until focus moves
/// away from it, so every event has a real duration rather than a guess.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEvent {
    pub client_event_id: String,
    pub app_name: String,
    pub window_title: Option<String>,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub category: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleEvent {
    pub client_event_id: String,
    pub idle_start_at: String,
    pub idle_end_at: Option<String>,
}

#[derive(Debug, Clone)]
struct Focus {
    app_name: String,
    window_title: Option<String>,
    started_at: DateTime<Utc>,
}

#[derive(Default)]
pub struct Tracker {
    current: Option<Focus>,
    idle_since: Option<DateTime<Utc>>,
}

impl Tracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records the currently focused window. Returns an event when focus *changed*,
    /// closing off the interval that just ended.
    pub fn observe_focus(
        &mut self,
        app_name: &str,
        window_title: Option<&str>,
        now: DateTime<Utc>,
    ) -> Option<ActivityEvent> {
        let unchanged = self
            .current
            .as_ref()
            .is_some_and(|focus| focus.app_name == app_name);

        if unchanged {
            return None;
        }

        let previous = self.current.replace(Focus {
            app_name: app_name.to_string(),
            window_title: window_title.map(str::to_string),
            started_at: now,
        });

        previous.map(|focus| ActivityEvent {
            client_event_id: Uuid::new_v4().to_string(),
            app_name: focus.app_name,
            window_title: focus.window_title,
            url: None,
            domain: None,
            category: None,
            started_at: focus.started_at.to_rfc3339(),
            ended_at: Some(now.to_rfc3339()),
        })
    }

    /// Feeds in seconds-since-last-input. Returns an idle event when a stretch ends.
    pub fn observe_idle(
        &mut self,
        idle_seconds: u64,
        threshold_seconds: u64,
        now: DateTime<Utc>,
    ) -> Option<IdleEvent> {
        let is_idle = idle_seconds >= threshold_seconds;

        match (is_idle, self.idle_since) {
            // Idle stretch begins. Backdate to when input actually stopped, not to
            // when we noticed — otherwise every idle period loses the threshold.
            (true, None) => {
                self.idle_since =
                    Some(now - chrono::Duration::seconds(idle_seconds as i64));
                None
            }
            // Input resumed: close the stretch.
            (false, Some(started)) => {
                self.idle_since = None;
                Some(IdleEvent {
                    client_event_id: Uuid::new_v4().to_string(),
                    idle_start_at: started.to_rfc3339(),
                    idle_end_at: Some(now.to_rfc3339()),
                })
            }
            _ => None,
        }
    }

    /// Closes any open interval — called at clock-out and on shutdown so the last
    /// stretch of the day is not lost.
    pub fn flush(&mut self, now: DateTime<Utc>) -> Option<ActivityEvent> {
        self.current.take().map(|focus| ActivityEvent {
            client_event_id: Uuid::new_v4().to_string(),
            app_name: focus.app_name,
            window_title: focus.window_title,
            url: None,
            domain: None,
            category: None,
            started_at: focus.started_at.to_rfc3339(),
            ended_at: Some(now.to_rfc3339()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_754_380_800 + seconds, 0).expect("valid timestamp")
    }

    #[test]
    fn first_focus_emits_nothing() {
        let mut tracker = Tracker::new();
        assert!(tracker.observe_focus("code", None, at(0)).is_none());
    }

    #[test]
    fn focus_change_closes_the_previous_interval() {
        let mut tracker = Tracker::new();
        tracker.observe_focus("code", None, at(0));

        let event = tracker
            .observe_focus("chrome", None, at(60))
            .expect("focus change should emit the interval that ended");

        assert_eq!(event.app_name, "code");
        assert_eq!(event.started_at, at(0).to_rfc3339());
        assert_eq!(event.ended_at, Some(at(60).to_rfc3339()));
    }

    #[test]
    fn repeated_focus_on_the_same_app_does_not_split_the_interval() {
        let mut tracker = Tracker::new();
        tracker.observe_focus("code", None, at(0));
        assert!(tracker.observe_focus("code", None, at(30)).is_none());

        let event = tracker.observe_focus("chrome", None, at(90)).expect("interval");
        assert_eq!(event.started_at, at(0).to_rfc3339());
    }

    #[test]
    fn idle_start_is_backdated_to_when_input_stopped() {
        let mut tracker = Tracker::new();
        assert!(tracker.observe_idle(120, 120, at(300)).is_none());

        let event = tracker
            .observe_idle(0, 120, at(400))
            .expect("resuming input should close the idle stretch");

        assert_eq!(event.idle_start_at, at(180).to_rfc3339());
        assert_eq!(event.idle_end_at, Some(at(400).to_rfc3339()));
    }

    #[test]
    fn activity_below_the_threshold_is_not_idle() {
        let mut tracker = Tracker::new();
        assert!(tracker.observe_idle(30, 120, at(0)).is_none());
        assert!(tracker.observe_idle(0, 120, at(60)).is_none());
    }
}
