mod db;
mod frames;

use db::{now_ms, Db, DeviceRow, EventRow, GattRow, SessionRow};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, State};

struct AppState {
    db: Arc<Db>,
    cache_dir: PathBuf,
}

/// Handle to the Kotlin `BlePlugin` (Android only). Bluetooth itself lives in Kotlin because
/// Android's BLE stack must be driven through its Java APIs; Rust owns storage and analysis.
#[cfg(target_os = "android")]
struct Bridge(tauri::plugin::PluginHandle<tauri::Wry>);
#[cfg(not(target_os = "android"))]
struct Bridge;

type CmdResult<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

fn ble_plugin() -> TauriPlugin<tauri::Wry> {
    PluginBuilder::new("ble")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            app.manage(Bridge(_api.register_android_plugin("dev.swarnim.reride", "BlePlugin")?));
            #[cfg(not(target_os = "android"))]
            app.manage(Bridge);
            Ok(())
        })
        .build()
}

// ---------------------------------------------------------------- Bluetooth bridge

/// Start the Kotlin BLE engine; it pushes every event (devices, status, GATT, frames) over `on_event`.
#[tauri::command]
async fn ble_start(bridge: State<'_, Bridge>, on_event: Channel<Value>) -> CmdResult<Value> {
    #[cfg(target_os = "android")]
    return bridge.0.run_mobile_plugin_async("start", json!({ "onEvent": on_event })).await.map_err(err);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (bridge, on_event);
        Err("Bluetooth is only available in the Android build".into())
    }
}

/// Generic pass-through for the other Kotlin commands: scan_start, scan_stop, connect, disconnect, share.
#[tauri::command]
async fn ble_call(bridge: State<'_, Bridge>, cmd: String, args: Option<Value>) -> CmdResult<Value> {
    #[cfg(target_os = "android")]
    return bridge
        .0
        .run_mobile_plugin_async(&cmd, args.unwrap_or_else(|| json!({})))
        .await
        .map_err(err);
    #[cfg(not(target_os = "android"))]
    {
        let _ = (bridge, cmd, args);
        Err("Bluetooth is only available in the Android build".into())
    }
}

// ---------------------------------------------------------------- Storage + analysis

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIn {
    address: String,
    name: Option<String>,
    rssi: Option<i16>,
    tx_power: Option<i16>,
    #[serde(default)]
    services: Vec<String>,
    #[serde(default)]
    manufacturer_data: Vec<(u16, String)>,
    #[serde(default)]
    service_data: Vec<(String, String)>,
}

/// Persist one advertisement; returns the stored row (with `is_target` decided here, in Rust).
#[tauri::command]
fn record_device(st: State<'_, AppState>, device: DeviceIn) -> CmdResult<DeviceRow> {
    let now = now_ms();
    let mut row = DeviceRow {
        is_target: device.services.iter().any(|s| frames::is_target_service(s))
            || device.service_data.iter().any(|(u, _)| frames::is_target_service(u)),
        address: device.address,
        name: device.name,
        rssi: device.rssi,
        tx_power: device.tx_power,
        services: device.services,
        manufacturer_data: device.manufacturer_data,
        service_data: device.service_data,
        first_seen: now,
        last_seen: now,
    };
    row.manufacturer_data.sort();
    row.service_data.sort();
    st.db.upsert_device(&row).map_err(err)?;
    Ok(row)
}

#[tauri::command]
fn session_begin(st: State<'_, AppState>, address: String, name: Option<String>) -> CmdResult<i64> {
    st.db.start_session(&address, name.as_deref()).map_err(err)
}

#[tauri::command]
fn session_end(st: State<'_, AppState>, session_id: i64) -> CmdResult<()> {
    st.db.end_session(session_id).map_err(err)
}

#[tauri::command]
fn save_gatt(st: State<'_, AppState>, session_id: i64, rows: Vec<GattRow>) -> CmdResult<()> {
    rows.iter().try_for_each(|g| st.db.save_gatt(session_id, g)).map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn record_event(
    st: State<'_, AppState>,
    session_id: i64,
    kind: String,
    service_uuid: Option<String>,
    char_uuid: Option<String>,
    hex: String,
    note: Option<String>,
) -> CmdResult<EventRow> {
    let mut bytes = frames::from_hex(&hex);
    // Never persist a PIN: blank the digits of an outgoing PIN frame (this also makes its CRC check fail, hence the note).
    let mut redacted = None;
    if kind == "write" && bytes.first() == Some(&frames::OP_PIN) {
        bytes = frames::redact_pin(&bytes);
        redacted = Some("pinAuth, digits redacted".to_string());
    }
    // Keep the caller's note (e.g. an error message) and add our own frame analysis for data frames.
    let auto = if matches!(kind.as_str(), "notify" | "read" | "write") && redacted.is_none() {
        frames::analyze(&bytes)
    } else {
        redacted
    };
    let note = match (note, auto) {
        (Some(a), Some(b)) => Some(format!("{a}; {b}")),
        (a, b) => a.or(b),
    };
    st.db
        .add_event(session_id, &kind, service_uuid.as_deref(), char_uuid.as_deref(), &bytes, note.as_deref())
        .map_err(err)
}

/// Hex of the hello frame (makes the pod display its PIN).
#[tauri::command]
fn frame_hello() -> String {
    db::to_hex(&frames::hello_frame())
}

/// Hex of the clock-sync frame for a local time.
#[tauri::command]
fn frame_time(hour: u8, minute: u8) -> CmdResult<String> {
    frames::time_frame(hour, minute).map(|f| db::to_hex(&f))
}

/// Hex of one of the two official post-pairing queries (0x03 or 0x30); anything else is refused.
#[tauri::command]
fn frame_query(opcode: u8) -> CmdResult<String> {
    frames::query_frame(opcode).map(|f| db::to_hex(&f))
}

/// Hex of a PIN-auth frame; rejects anything but exactly six digits.
#[tauri::command]
fn frame_pin(pin: String) -> CmdResult<String> {
    frames::pin_frame(&pin).map(|f| db::to_hex(&f))
}

#[tauri::command]
fn list_devices(st: State<'_, AppState>) -> CmdResult<Vec<DeviceRow>> {
    st.db.list_devices().map_err(err)
}

#[tauri::command]
fn list_sessions(st: State<'_, AppState>) -> CmdResult<Vec<SessionRow>> {
    st.db.list_sessions().map_err(err)
}

#[tauri::command]
fn session_events(st: State<'_, AppState>, session_id: i64, limit: Option<i64>) -> CmdResult<Vec<EventRow>> {
    st.db.session_events(session_id, limit.unwrap_or(5000)).map_err(err)
}

#[tauri::command]
fn session_gatt(st: State<'_, AppState>, session_id: i64) -> CmdResult<Vec<GattRow>> {
    st.db.session_gatt(session_id).map_err(err)
}

/// Write one session (GATT table + every event) to JSON in the app cache dir and return the path;
/// the frontend then hands it to Android's share sheet.
#[tauri::command]
fn export_session(st: State<'_, AppState>, session_id: i64) -> CmdResult<String> {
    let session = st
        .db
        .list_sessions()
        .map_err(err)?
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or("no such session")?;
    let doc = json!({
        "session": session,
        "gatt": st.db.session_gatt(session_id).map_err(err)?,
        "events": st.db.session_events(session_id, i64::MAX).map_err(err)?,
    });
    let dir = st.cache_dir.join("exports");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join(format!("reride-session-{session_id}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).map_err(err)?).map_err(err)?;
    Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(ble_plugin())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            let db = Arc::new(Db::open(&data_dir.join("reride.sqlite3"))?);
            app.manage(AppState { db, cache_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ble_start,
            ble_call,
            record_device,
            session_begin,
            session_end,
            save_gatt,
            record_event,
            frame_hello,
            frame_pin,
            frame_time,
            frame_query,
            list_devices,
            list_sessions,
            session_events,
            session_gatt,
            export_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
