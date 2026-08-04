// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod device_info;
mod screenshot;
mod sync;
mod tracker;

use std::sync::Arc;

use chrono::Utc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;

use config::AgentConfig;
use sync::SyncClient;
use tracker::Tracker;

/// Everything the background loop and the UI both touch.
struct AgentState {
    config: Mutex<AgentConfig>,
    tracker: Mutex<Tracker>,
    /// Events held until the API confirms it stored them.
    pending_activity: Mutex<Vec<tracker::ActivityEvent>>,
    pending_idle: Mutex<Vec<tracker::IdleEvent>>,
    work_session_id: Mutex<Option<i64>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    enrolled: bool,
    collecting: bool,
    policy_version: Option<String>,
    consent_required: bool,
}

#[tauri::command]
async fn get_status(state: State<'_, Arc<AgentState>>) -> Result<AgentStatus, String> {
    let config = state.config.lock().await;

    Ok(AgentStatus {
        enrolled: config.device_token.is_some(),
        collecting: config.may_collect(),
        policy_version: config.policy.as_ref().map(|p| p.version.clone()),
        consent_required: config.device_token.is_some() && !config.may_collect(),
    })
}

/// Called by the consent window once the employee signs in.
#[tauri::command]
async fn enroll(
    access_token: String,
    state: State<'_, Arc<AgentState>>,
) -> Result<AgentStatus, String> {
    let info = device_info::collect();
    let base_url = { state.config.lock().await.api_url() };
    let client = SyncClient::new(base_url);

    let response = client
        .enroll(&access_token, &info)
        .await
        .map_err(|e| e.to_string())?;

    let mut config = state.config.lock().await;
    config.device_id = Some(response.device_id);
    config.company_id = Some(response.company_id);
    config.profile_id = Some(response.profile_id);
    config.device_token = Some(response.device_token);
    config.policy = Some(response.policy);
    // Enrolling is not consenting. Collection stays blocked until the employee
    // accepts the policy in the consent window.
    config.consented_policy_version = None;

    Ok(AgentStatus {
        enrolled: true,
        collecting: false,
        policy_version: config.policy.as_ref().map(|p| p.version.clone()),
        consent_required: true,
    })
}

/// Records that the employee accepted the policy shown to them.
#[tauri::command]
async fn accept_consent(state: State<'_, Arc<AgentState>>) -> Result<AgentStatus, String> {
    let mut config = state.config.lock().await;

    let Some(policy) = config.policy.clone() else {
        return Err("No policy has been fetched yet".to_string());
    };

    config.consented_policy_version = Some(policy.version.clone());

    Ok(AgentStatus {
        enrolled: true,
        collecting: true,
        policy_version: Some(policy.version),
        consent_required: false,
    })
}

/// The collection loop.
///
/// Every iteration re-reads `may_collect()`. Consent withdrawn from the dashboard,
/// a revoked device, or a policy bump all stop collection on the next tick without
/// needing the agent restarted.
async fn run_collection_loop(app: AppHandle, state: Arc<AgentState>) {
    let mut ticks: u64 = 0;

    loop {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        ticks += 5;

        let (may_collect, screenshot_interval, idle_threshold, base_url) = {
            let config = state.config.lock().await;
            let policy = config.policy.clone();
            (
                config.may_collect(),
                policy.as_ref().map(|p| p.screenshot_interval_seconds).unwrap_or(300),
                policy.as_ref().map(|p| p.idle_threshold_seconds).unwrap_or(120),
                config.api_url(),
            )
        };

        if !may_collect {
            continue;
        }

        let now = Utc::now();
        let client = SyncClient::new(base_url);

        // -- active window ------------------------------------------------
        if let Ok(windows) = xcap::Window::all() {
            if let Some(window) = windows.into_iter().find(|w| w.is_focused().unwrap_or(false)) {
                let app_name = window.app_name().unwrap_or_else(|_| "unknown".to_string());
                let title = window.title().ok();

                let mut tracker = state.tracker.lock().await;
                if let Some(event) = tracker.observe_focus(&app_name, title.as_deref(), now) {
                    state.pending_activity.lock().await.push(event);
                }
            }
        }

        // -- idle ---------------------------------------------------------
        if let Ok(idle) = user_idle::UserIdle::get_time() {
            let mut tracker = state.tracker.lock().await;
            if let Some(event) =
                tracker.observe_idle(idle.as_seconds(), idle_threshold, now)
            {
                state.pending_idle.lock().await.push(event);
            }
        }

        // -- screenshot ---------------------------------------------------
        if ticks % screenshot_interval == 0 {
            match screenshot::capture_primary() {
                Ok(image) => {
                    let config = state.config.lock().await.clone();
                    if let Err(err) = client
                        .upload_screenshot(&config, &Uuid::new_v4().to_string(), &now.to_rfc3339(), image)
                        .await
                    {
                        tracing::warn!(?err, "screenshot upload failed");
                    }
                }
                Err(err) => tracing::warn!(?err, "screenshot capture failed"),
            }
        }

        // -- flush --------------------------------------------------------
        if ticks % 60 == 0 {
            let config = state.config.lock().await.clone();
            let session = *state.work_session_id.lock().await;

            let activity = state.pending_activity.lock().await.clone();
            let idle = state.pending_idle.lock().await.clone();

            match client.push_events(&config, session, &activity, &idle).await {
                Ok(()) => {
                    // Only clear once the server has them. A failed flush keeps the
                    // buffer so nothing is lost to a dropped connection.
                    state.pending_activity.lock().await.clear();
                    state.pending_idle.lock().await.clear();
                }
                Err(sync::SyncError::ConsentRequired) | Err(sync::SyncError::Revoked) => {
                    tracing::info!("collection stopped by server");
                    let mut config = state.config.lock().await;
                    config.consented_policy_version = None;
                }
                Err(err) => tracing::warn!(?err, "event flush failed, will retry"),
            }

            if let Err(err) = client.heartbeat(&config, session).await {
                tracing::warn!(?err, "heartbeat failed");
            }
        }

        let _ = app.emit_to("main", "agent://tick", ticks);
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "aems_desktop_agent=info".into()),
        )
        .init();

    let state = Arc::new(AgentState {
        config: Mutex::new(AgentConfig::default()),
        tracker: Mutex::new(Tracker::new()),
        pending_activity: Mutex::new(Vec::new()),
        pending_idle: Mutex::new(Vec::new()),
        work_session_id: Mutex::new(None),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![get_status, enroll, accept_consent])
        .setup(move |app| {
            // The tray icon is a compliance requirement, not a convenience: docs
            // require a visible indicator whenever monitoring is running. It is
            // built unconditionally and has no "hide" option.
            let open = MenuItem::with_id(app, "open", "Open AEMS Agent", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            TrayIconBuilder::with_id("aems-tray")
                .menu(&menu)
                .tooltip("AEMS — monitoring active")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            let loop_state = state.clone();
            tauri::async_runtime::spawn(async move {
                run_collection_loop(handle, loop_state).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AEMS agent");
}
