//! SQLite persistence for everything we learn about the bike.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub struct Db(Mutex<Connection>);

#[derive(Serialize, Clone, Debug)]
pub struct DeviceRow {
    pub address: String,
    pub name: Option<String>,
    pub rssi: Option<i16>,
    pub tx_power: Option<i16>,
    pub services: Vec<String>,
    pub manufacturer_data: Vec<(u16, String)>,
    pub service_data: Vec<(String, String)>,
    pub is_target: bool,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct SessionRow {
    pub id: i64,
    pub address: String,
    pub name: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub event_count: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct EventRow {
    pub id: i64,
    pub session_id: i64,
    pub ts_ms: i64,
    pub kind: String,
    pub service_uuid: Option<String>,
    pub char_uuid: Option<String>,
    pub hex: String,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GattRow {
    pub service_uuid: String,
    pub char_uuid: String,
    pub properties: Vec<String>,
    pub descriptors: Vec<String>,
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS devices (
  address TEXT PRIMARY KEY,
  name TEXT,
  rssi INTEGER,
  tx_power INTEGER,
  services_json TEXT NOT NULL DEFAULT '[]',
  mfr_json TEXT NOT NULL DEFAULT '[]',
  svc_data_json TEXT NOT NULL DEFAULT '[]',
  is_target INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
-- Every time a device's advertised payload changes we keep a snapshot.
CREATE TABLE IF NOT EXISTS adverts (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  address TEXT NOT NULL,
  name TEXT,
  rssi INTEGER,
  services_json TEXT NOT NULL,
  mfr_json TEXT NOT NULL,
  svc_data_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,
  name TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS gatt (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  service_uuid TEXT NOT NULL,
  char_uuid TEXT NOT NULL,
  properties TEXT NOT NULL,
  descriptors TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (session_id, service_uuid, char_uuid)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- read | notify | error | info
  service_uuid TEXT,
  char_uuid TEXT,
  data BLOB,
  hex TEXT NOT NULL DEFAULT '',
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
"#;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// Upsert a device; returns true when the advertised payload (name/services/mfr/svc-data)
    /// differs from what we had stored, in which case an `adverts` snapshot is also written.
    pub fn upsert_device(&self, d: &DeviceRow) -> Result<bool> {
        let c = self.0.lock().unwrap();
        let services = serde_json::to_string(&d.services)?;
        let mfr = serde_json::to_string(&d.manufacturer_data)?;
        let svc = serde_json::to_string(&d.service_data)?;
        let prev: Option<(Option<String>, String, String, String)> = c
            .query_row(
                "SELECT name, services_json, mfr_json, svc_data_json FROM devices WHERE address=?1",
                [&d.address],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        let changed = match &prev {
            None => true,
            Some((n, s, m, sd)) => {
                // Keep the best name we've seen; a nameless update must not count as a change.
                let name_changed = d.name.is_some() && *n != d.name;
                name_changed || *s != services || *m != mfr || *sd != svc
            }
        };
        c.execute(
            "INSERT INTO devices (address,name,rssi,tx_power,services_json,mfr_json,svc_data_json,is_target,first_seen,last_seen)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
             ON CONFLICT(address) DO UPDATE SET
               name=COALESCE(?2,name), rssi=COALESCE(?3,rssi), tx_power=COALESCE(?4,tx_power),
               services_json=CASE WHEN ?5!='[]' THEN ?5 ELSE services_json END,
               mfr_json=CASE WHEN ?6!='[]' THEN ?6 ELSE mfr_json END,
               svc_data_json=CASE WHEN ?7!='[]' THEN ?7 ELSE svc_data_json END,
               is_target=MAX(is_target,?8), last_seen=?9",
            params![d.address, d.name, d.rssi, d.tx_power, services, mfr, svc, d.is_target as i32, d.last_seen],
        )?;
        if changed {
            c.execute(
                "INSERT INTO adverts (ts_ms,address,name,rssi,services_json,mfr_json,svc_data_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![d.last_seen, d.address, d.name, d.rssi, services, mfr, svc],
            )?;
        }
        Ok(changed)
    }

    pub fn list_devices(&self) -> Result<Vec<DeviceRow>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT address,name,rssi,tx_power,services_json,mfr_json,svc_data_json,is_target,first_seen,last_seen
             FROM devices ORDER BY is_target DESC, last_seen DESC",
        )?;
        let rows = st.query_map([], |r| {
            Ok(DeviceRow {
                address: r.get(0)?,
                name: r.get(1)?,
                rssi: r.get(2)?,
                tx_power: r.get(3)?,
                services: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                manufacturer_data: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                service_data: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
                is_target: r.get::<_, i32>(7)? != 0,
                first_seen: r.get(8)?,
                last_seen: r.get(9)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn start_session(&self, address: &str, name: Option<&str>) -> Result<i64> {
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT INTO sessions (address,name,started_at) VALUES (?1,?2,?3)",
            params![address, name, now_ms()],
        )?;
        Ok(c.last_insert_rowid())
    }

    pub fn end_session(&self, id: i64) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute("UPDATE sessions SET ended_at=?1 WHERE id=?2", params![now_ms(), id])?;
        Ok(())
    }

    pub fn save_gatt(&self, session_id: i64, g: &GattRow) -> Result<()> {
        let c = self.0.lock().unwrap();
        c.execute(
            "INSERT OR REPLACE INTO gatt (session_id,service_uuid,char_uuid,properties,descriptors) VALUES (?1,?2,?3,?4,?5)",
            params![
                session_id,
                g.service_uuid,
                g.char_uuid,
                g.properties.join(","),
                serde_json::to_string(&g.descriptors)?
            ],
        )?;
        Ok(())
    }

    pub fn add_event(
        &self,
        session_id: i64,
        kind: &str,
        service: Option<&str>,
        ch: Option<&str>,
        data: &[u8],
        note: Option<&str>,
    ) -> Result<EventRow> {
        let c = self.0.lock().unwrap();
        let ts = now_ms();
        let hex = to_hex(data);
        c.execute(
            "INSERT INTO events (session_id,ts_ms,kind,service_uuid,char_uuid,data,hex,note) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![session_id, ts, kind, service, ch, data, hex, note],
        )?;
        Ok(EventRow {
            id: c.last_insert_rowid(),
            session_id,
            ts_ms: ts,
            kind: kind.into(),
            service_uuid: service.map(Into::into),
            char_uuid: ch.map(Into::into),
            hex,
            note: note.map(Into::into),
        })
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRow>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT s.id,s.address,s.name,s.started_at,s.ended_at,(SELECT COUNT(*) FROM events e WHERE e.session_id=s.id)
             FROM sessions s ORDER BY s.id DESC",
        )?;
        let rows = st.query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                address: r.get(1)?,
                name: r.get(2)?,
                started_at: r.get(3)?,
                ended_at: r.get(4)?,
                event_count: r.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn session_events(&self, session_id: i64, limit: i64) -> Result<Vec<EventRow>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT id,session_id,ts_ms,kind,service_uuid,char_uuid,hex,note FROM events
             WHERE session_id=?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = st.query_map(params![session_id, limit], |r| {
            Ok(EventRow {
                id: r.get(0)?,
                session_id: r.get(1)?,
                ts_ms: r.get(2)?,
                kind: r.get(3)?,
                service_uuid: r.get(4)?,
                char_uuid: r.get(5)?,
                hex: r.get(6)?,
                note: r.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn session_gatt(&self, session_id: i64) -> Result<Vec<GattRow>> {
        let c = self.0.lock().unwrap();
        let mut st = c.prepare(
            "SELECT service_uuid,char_uuid,properties,descriptors FROM gatt WHERE session_id=?1 ORDER BY service_uuid,char_uuid",
        )?;
        let rows = st.query_map([session_id], |r| {
            Ok(GattRow {
                service_uuid: r.get(0)?,
                char_uuid: r.get(1)?,
                properties: r.get::<_, String>(2)?.split(',').filter(|s| !s.is_empty()).map(Into::into).collect(),
                descriptors: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}

pub fn to_hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}
