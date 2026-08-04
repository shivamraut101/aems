use serde::Serialize;
use sysinfo::System;

/// Hardware facts collected once at enrolment (scope §7, Device Inventory).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub platform: &'static str,
    pub label: String,
    pub device_name: String,
    pub os_version: String,
    pub agent_version: String,
    pub model: Option<String>,
    pub cpu: Option<String>,
    pub ram_mb: Option<u64>,
    pub storage_mb: Option<u64>,
}

pub fn collect() -> DeviceInfo {
    let mut system = System::new_all();
    system.refresh_all();

    let host = System::host_name().unwrap_or_else(|| "Unknown device".to_string());

    DeviceInfo {
        platform: if cfg!(target_os = "windows") {
            "windows"
        } else {
            "macos"
        },
        label: host.clone(),
        device_name: host,
        os_version: System::long_os_version().unwrap_or_else(|| "unknown".to_string()),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        model: System::cpu_arch().map(|arch| arch.to_string()),
        cpu: system.cpus().first().map(|cpu| cpu.brand().trim().to_string()),
        // sysinfo reports bytes; the API stores megabytes.
        ram_mb: Some(system.total_memory() / 1024 / 1024),
        storage_mb: None,
    }
}
