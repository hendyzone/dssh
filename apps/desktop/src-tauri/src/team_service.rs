//! Authenticated team updates and native REST writes. Credentials never enter UI payloads.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message,
    },
};

#[path = "team_service_rest.rs"]
pub(crate) mod rest;

const SUBPROTOCOL: &str = "dssh-team.v1";
const CACHE_LIMIT: u64 = 16 * 1024 * 1024;
const FRAME_LIMIT: usize = 2 * 1024 * 1024;

pub trait Vault: Send + Sync {
    fn store(&self, endpoint: &str, token: &str) -> Result<(), String>;
    fn load(&self, endpoint: &str) -> Result<String, String>;
}
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

#[derive(Clone)]
pub struct Timing {
    pub connect_timeout: Duration,
    pub silence_timeout: Duration,
    pub retry_min: Duration,
    pub retry_max: Duration,
    pub jitter: fn() -> f64,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            silence_timeout: Duration::from_secs(60),
            retry_min: Duration::from_secs(1),
            retry_max: Duration::from_secs(30),
            jitter: rand::random::<f64>,
        }
    }
}

fn retry_delay(timing: &Timing, failures: u32) -> Duration {
    let cap = timing
        .retry_min
        .saturating_mul(1u32 << failures.min(10))
        .min(timing.retry_max);
    cap.mul_f64((timing.jitter)().clamp(0.0, 1.0))
}

/// Plaintext hosts must be literal addresses: no DNS rebinding or redirects.
pub fn validate_url(input: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(input).map_err(|_| "Invalid team service URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("Team service URL cannot contain credentials, query or fragment".into());
    }
    let secure = match url.scheme() {
        "https" | "wss" => true,
        "http" | "ws" => false,
        _ => return Err("Team service requires HTTP(S) or WS(S)".into()),
    };
    if !secure {
        let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
        let allowed = match host.parse::<IpAddr>() {
            Ok(IpAddr::V4(ip)) => {
                let octets = ip.octets();
                ip.is_private()
                    || ip.is_loopback()
                    || (octets[0] == 100 && (64..=127).contains(&octets[1]))
            }
            Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.segments()[0] & 0xfe00 == 0xfc00,
            Err(_) => false,
        };
        if !allowed {
            return Err("Plaintext team service requires a private or loopback IP address".into());
        }
    }
    url.set_scheme(if secure { "wss" } else { "ws" })
        .map_err(|_| "Invalid team service scheme")?;
    let base = url.path().trim_end_matches('/');
    let path = if base.ends_with("/api/v1/team/ws") {
        base.to_owned()
    } else if base.ends_with("/api/v1") {
        format!("{base}/team/ws")
    } else {
        format!("{base}/api/v1/team/ws")
    };
    url.set_path(&path);
    Ok(url.to_string())
}
fn project_valid(project: &str) -> bool {
    !project.is_empty()
        && project.len() <= 64
        && project.as_bytes()[0].is_ascii_alphanumeric()
        && project
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn saved_at() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode team cache")?;
    if bytes.len() as u64 > CACHE_LIMIT {
        return Err("Team cache capacity exceeded".into());
    }
    let parent = path.parent().ok_or("Invalid team cache path")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create team cache directory")?;
    let temporary = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        use std::io::Write;
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Cannot write team cache")?;
        file.write_all(&bytes)
            .map_err(|_| "Cannot write team cache")?;
        file.sync_all()
            .map_err(|_| "Cannot synchronize team cache")?;
        fs::rename(&temporary, path).map_err(|_| "Cannot replace team cache")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn read_json(path: &Path) -> Option<Value> {
    if fs::metadata(path).ok()?.len() > CACHE_LIMIT {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

#[derive(Clone)]
pub struct TeamService {
    tx: mpsc::Sender<Command>,
    status: Arc<Mutex<Value>>,
}
enum Command {
    Configure(String, String, oneshot::Sender<Result<Value, String>>),
    Subscribe(Vec<String>, oneshot::Sender<Result<(), String>>),
    Shutdown(oneshot::Sender<()>),
    Read(oneshot::Sender<Value>),
    RestContext(
        String,
        oneshot::Sender<Result<rest::RestContext, rest::WriteError>>,
    ),
    Refresh(
        u64,
        String,
        Option<Value>,
        Value,
        oneshot::Sender<Result<(), rest::WriteError>>,
    ),
    #[cfg(test)]
    Inspect(String, oneshot::Sender<Option<Value>>),
}
enum CommandEffect {
    Keep,
    Restart,
    Stop,
}
struct Actor {
    endpoint: Option<String>,
    projects: BTreeSet<String>,
    snapshots: BTreeMap<String, Value>,
    lseq: BTreeMap<String, u64>,
    directory: PathBuf,
    vault: Arc<dyn Vault>,
    sink: Arc<dyn EventSink>,
    status: Arc<Mutex<Value>>,
    timing: Timing,
    configured: bool,
    generation: u64,
    halted: bool,
}
impl TeamService {
    pub fn new(
        directory: PathBuf,
        vault: Arc<dyn Vault>,
        sink: Arc<dyn EventSink>,
        timing: Timing,
    ) -> Self {
        let (tx, rx) = mpsc::channel(32);
        let status = Arc::new(Mutex::new(
            json!({"state":"offline", "since":timestamp(), "token_configured":false}),
        ));
        let actor = Actor {
            endpoint: None,
            projects: BTreeSet::new(),
            snapshots: BTreeMap::new(),
            lseq: BTreeMap::new(),
            directory,
            vault,
            sink,
            status: status.clone(),
            timing,
            configured: false,
            generation: 0,
            halted: false,
        };
        tauri::async_runtime::spawn(actor.run(rx));
        Self { tx, status }
    }
    pub async fn configure(&self, url: String, token: String) -> Result<Value, String> {
        let endpoint = validate_url(&url)?;
        if token.trim().is_empty() || HeaderValue::from_str(&format!("Bearer {token}")).is_err() {
            return Err("Invalid team service token".into());
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Configure(endpoint, token, tx))
            .await
            .map_err(|_| "Team service stopped")?;
        rx.await.map_err(|_| "Team service stopped")?
    }
    pub async fn subscribe(&self, projects: Vec<String>) -> Result<(), String> {
        if projects.len() > 64 || projects.iter().any(|p| !project_valid(p)) {
            return Err("Invalid team project selection".into());
        }
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Subscribe(projects, tx))
            .await
            .map_err(|_| "Team service stopped")?;
        rx.await.map_err(|_| "Team service stopped")?
    }
    pub fn status(&self) -> Value {
        self.status
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
    #[cfg(test)]
    pub async fn inspect(&self, project: &str) -> Option<Value> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Inspect(project.to_owned(), tx))
            .await
            .ok()?;
        rx.await.ok()?
    }
    pub async fn read(&self) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Read(tx))
            .await
            .map_err(|_| "Team service stopped")?;
        rx.await.map_err(|_| "Team service stopped".into())
    }
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Command::Shutdown(tx)).await.is_ok() {
            let _ = rx.await;
        }
    }
}
impl Actor {
    fn status(&self, state: &str) -> Value {
        let mut payload = json!({"state":state,"token_configured":self.configured});
        if state == "offline" {
            payload["since"] = json!(timestamp());
        }
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = payload.clone();
        self.sink.emit("team://status", payload.clone());
        payload
    }
    fn error(&self, code: &str) {
        let payload = json!({"state":"error","code":code,"token_configured":self.configured});
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = payload.clone();
        self.sink.emit("team://status", payload);
    }
    fn settings(&self) -> Result<(), String> {
        atomic_json(
            &self.directory.join("config.json"),
            &json!({"endpoint":self.endpoint,"projects":self.projects}),
        )
    }
    fn cache(&self) -> Result<(), String> {
        let snapshots: BTreeMap<_, _> = self
            .snapshots
            .iter()
            .map(|(project, snapshot)| {
                (
                    project.clone(),
                    json!({"project":project,"seq":snapshot["seq"],
                "members":snapshot["members"],"ai":snapshot["ai"],"savedAt":snapshot["savedAt"]}),
                )
            })
            .collect();
        atomic_json(
            &self.directory.join("snapshots.json"),
            &json!({"endpoint":self.endpoint,"projects":snapshots}),
        )
    }
    fn load(&mut self) {
        if let Some(config) = read_json(&self.directory.join("config.json")) {
            self.endpoint = config["endpoint"]
                .as_str()
                .and_then(|url| validate_url(url).ok());
            if let Some(projects) = config["projects"].as_array() {
                self.projects = projects
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|p| project_valid(p))
                    .take(64)
                    .map(str::to_owned)
                    .collect();
            }
        }
        self.configured = self
            .endpoint
            .as_ref()
            .is_some_and(|endpoint| self.vault.load(endpoint).is_ok());
        self.status("offline");
        if let Some(cache) = read_json(&self.directory.join("snapshots.json")) {
            if self.endpoint.is_some() && cache["endpoint"].as_str() == self.endpoint.as_deref() {
                if let Some(projects) = cache["projects"].as_object() {
                    for (project, snapshot) in projects {
                        if self.projects.contains(project)
                            && snapshot["seq"].as_u64().is_some()
                            && snapshot["members"].is_array()
                            && snapshot["ai"].is_object()
                        {
                            let value = json!({"type":"snapshot","project":project,"seq":snapshot["seq"],
                                "lseq":0,"members":snapshot["members"],"ai":snapshot["ai"],
                                "live":{},"machines":{},"offline":true,"savedAt":snapshot.get("savedAt").and_then(Value::as_u64)});
                            self.snapshots.insert(project.clone(), value.clone());
                            self.sink.emit("team://snapshot", value);
                        }
                    }
                }
            }
        }
    }
    // One actor serializes commands and network application, fencing old connections.
    fn command(&mut self, command: Option<Command>) -> CommandEffect {
        match command {
            Some(Command::Configure(endpoint, token, reply)) => {
                if self.vault.store(&endpoint, &token).is_err() {
                    let _ = reply.send(Err("Cannot save team service credential".into()));
                    return CommandEffect::Keep;
                }
                self.generation = self.generation.wrapping_add(1);
                self.endpoint = Some(endpoint);
                self.configured = true;
                self.halted = false;
                self.snapshots.clear();
                self.lseq.clear();
                let saved = self.cache().and_then(|_| self.settings());
                let result = saved.map(|_| self.status("offline"));
                let _ = reply.send(result);
            }
            Some(Command::Subscribe(projects, reply)) => {
                let projects: BTreeSet<_> = projects.into_iter().collect();
                if self.projects == projects {
                    let _ = reply.send(Ok(()));
                    return CommandEffect::Keep;
                }
                self.generation = self.generation.wrapping_add(1);
                self.projects = projects;
                self.lseq.clear();
                self.snapshots
                    .retain(|project, _| self.projects.contains(project));
                let saved = self.settings().and_then(|_| self.cache());
                self.status(if self.halted {
                    "unauthorized"
                } else {
                    "offline"
                });
                let _ = reply.send(saved);
            }
            #[cfg(test)]
            Some(Command::Inspect(project, reply)) => {
                let _ = reply.send(self.snapshots.get(&project).cloned());
                return CommandEffect::Keep;
            }
            Some(Command::RestContext(project, reply)) => {
                let _ = reply.send(self.rest_context(&project));
                return CommandEffect::Keep;
            }
            Some(Command::Refresh(generation, project, initial, value, reply)) => {
                let _ = reply.send(self.refresh_snapshot(generation, &project, initial, value));
                return CommandEffect::Keep;
            }
            Some(Command::Read(reply)) => {
                let status = self
                    .status
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                let _ = reply.send(json!({"url":self.endpoint,"projects":self.projects,
                    "status":status,"snapshots":self.snapshots}));
                return CommandEffect::Keep;
            }
            Some(Command::Shutdown(reply)) => {
                let _ = reply.send(());
                return CommandEffect::Stop;
            }
            None => return CommandEffect::Stop,
        }
        CommandEffect::Restart
    }
    fn subscription(&self, only: Option<&str>, fresh: bool) -> Vec<Message> {
        let mut chunks = Vec::new();
        let mut projects = Map::new();
        for project in &self.projects {
            if only.is_some_and(|name| name != project) {
                continue;
            }
            let seq = if fresh {
                Value::Null
            } else {
                self.snapshots
                    .get(project)
                    .map(|v| v["seq"].clone())
                    .unwrap_or(Value::Null)
            };
            projects.insert(project.clone(), seq.clone());
            if json!({"type":"sub","projects":projects}).to_string().len() > 4096 {
                projects.remove(project);
                chunks.push(Message::Text(
                    json!({"type":"sub","projects":projects}).to_string().into(),
                ));
                projects.clear();
                projects.insert(project.clone(), seq);
            }
        }
        if !projects.is_empty() {
            chunks.push(Message::Text(
                json!({"type":"sub","projects":projects}).to_string().into(),
            ));
        }
        chunks
    }
    fn apply(&mut self, value: Value) -> Vec<Message> {
        let kind = value["type"].as_str().unwrap_or("");
        if kind == "machine" {
            if let Some(name) = value["name"].as_str() {
                let machine = json!({"name":name,"online":value["online"],"seen":value["seen"],"version":value["version"]});
                for snapshot in self.snapshots.values_mut() {
                    snapshot["machines"][name] = machine.clone();
                }
                self.sink.emit(
                    "team://live",
                    json!({"type":"machine","name":name,
                    "online":value["online"],"seen":value["seen"],"version":value["version"]}),
                );
            }
            return Vec::new();
        }
        if kind == "error" {
            match value["code"].as_str() {
                Some("unauthorized") => {
                    self.halted = true;
                    self.status("unauthorized");
                }
                Some("resync") => { /* The protocol sends a replacement snapshot next. */ }
                Some("forbidden") => self.error("forbidden"),
                _ => self.error("server_error"),
            }
            return Vec::new();
        }
        let Some(project) = value["project"]
            .as_str()
            .filter(|p| self.projects.contains(*p))
            .map(str::to_owned)
        else {
            return Vec::new();
        };
        match kind {
            "snapshot" => {
                let (Some(seq), Some(lseq), Some(members), Some(ai), Some(live), Some(machines)) = (
                    value["seq"].as_u64(),
                    value["lseq"].as_u64(),
                    value["members"].as_array(),
                    value["ai"].as_object(),
                    value["live"].as_object(),
                    value["machines"].as_object(),
                ) else {
                    return self.subscription(Some(&project), true);
                };
                if members.len() > 100 {
                    return self.subscription(Some(&project), true);
                }
                let snapshot = json!({"type":"snapshot","project":project,"seq":seq,"lseq":lseq,
                    "members":members,"ai":ai,"live":live,"machines":machines,"savedAt":saved_at()});
                self.snapshots.insert(project.clone(), snapshot.clone());
                self.lseq.insert(project, lseq);
                if self.cache().is_err() {
                    self.error("cache_write_failed");
                }
                self.sink.emit("team://snapshot", snapshot);
            }
            "delta" => {
                let Some(seq) = value["seq"].as_u64() else {
                    return Vec::new();
                };
                let Some(snapshot) = self.snapshots.get(&project) else {
                    return self.subscription(Some(&project), true);
                };
                let local = snapshot["seq"].as_u64().unwrap_or(0);
                if seq <= local {
                    return Vec::new();
                }
                if local.checked_add(1) != Some(seq) {
                    return self.subscription(Some(&project), false);
                }
                let Some(ops) = value["ops"].as_array() else {
                    return self.subscription(Some(&project), true);
                };
                let mut next = snapshot.clone();
                for op in ops {
                    match op["op"].as_str() {
                        Some("upsert") => {
                            let Some(key) = op["member"]["key"].as_str() else {
                                return self.subscription(Some(&project), true);
                            };
                            let members = next["members"].as_array_mut().unwrap();
                            members.retain(|member| member["key"].as_str() != Some(key));
                            members.push(op["member"].clone());
                            if members.len() > 100 {
                                return self.subscription(Some(&project), true);
                            }
                        }
                        Some("remove") => {
                            let Some(key) = op["key"].as_str() else {
                                return self.subscription(Some(&project), true);
                            };
                            next["members"]
                                .as_array_mut()
                                .unwrap()
                                .retain(|member| member["key"].as_str() != Some(key));
                            next["ai"].as_object_mut().unwrap().remove(key);
                            next["live"].as_object_mut().unwrap().remove(key);
                        }
                        Some("ai") => {
                            let Some(key) = op["key"].as_str() else {
                                return self.subscription(Some(&project), true);
                            };
                            if op["ai"].is_null() {
                                next["ai"].as_object_mut().unwrap().remove(key);
                            } else if op["ai"].is_object() {
                                next["ai"][key] = op["ai"].clone();
                            } else {
                                return self.subscription(Some(&project), true);
                            }
                        }
                        _ => return self.subscription(Some(&project), true),
                    }
                }
                next["seq"] = json!(seq);
                let at = saved_at();
                next["savedAt"] = json!(at);
                next.as_object_mut().unwrap().remove("offline");
                self.snapshots.insert(project, next);
                if self.cache().is_err() {
                    self.error("cache_write_failed");
                }
                self.sink.emit(
                    "team://delta",
                    json!({"type":"delta","project":value["project"],"seq":seq,"ops":ops,"savedAt":at}),
                );
            }
            "live" => {
                let (Some(lseq), Some(full), Some(items)) = (
                    value["lseq"].as_u64(),
                    value["full"].as_bool(),
                    value["items"].as_array(),
                ) else {
                    return Vec::new();
                };
                if self.lseq.get(&project).is_some_and(|last| lseq <= *last) {
                    return Vec::new();
                }
                let Some(snapshot) = self.snapshots.get_mut(&project) else {
                    return Vec::new();
                };
                let mut live = if full {
                    Map::new()
                } else {
                    snapshot["live"].as_object().cloned().unwrap_or_default()
                };
                for item in items {
                    if let Some(key) = item["key"].as_str() {
                        live.insert(key.to_owned(), item.clone());
                    }
                }
                snapshot["live"] = Value::Object(live);
                snapshot["lseq"] = json!(lseq);
                self.lseq.insert(project, lseq);
                self.sink.emit("team://live", json!({"type":"live","project":value["project"],"lseq":lseq,"full":full,"items":items}));
            }
            _ => {}
        }
        Vec::new()
    }
    async fn run(mut self, mut rx: mpsc::Receiver<Command>) {
        self.load();
        let mut failures = 0u32;
        loop {
            if self.endpoint.is_none() || self.projects.is_empty() || self.halted {
                if matches!(self.command(rx.recv().await), CommandEffect::Stop) {
                    break;
                }
                failures = 0;
                continue;
            }
            let endpoint = self.endpoint.clone().unwrap();
            let token = match self.vault.load(&endpoint) {
                Ok(token) => token,
                Err(_) => {
                    self.configured = false;
                    self.halted = true;
                    self.status("unauthorized");
                    continue;
                }
            };
            let mut request = match endpoint.into_client_request() {
                Ok(request) => request,
                Err(_) => {
                    self.halted = true;
                    self.error("invalid_endpoint");
                    continue;
                }
            };
            let mut authorization = match HeaderValue::from_str(&format!("Bearer {token}")) {
                Ok(header) => header,
                Err(_) => {
                    self.halted = true;
                    self.status("unauthorized");
                    continue;
                }
            };
            authorization.set_sensitive(true);
            request.headers_mut().insert("Authorization", authorization);
            request.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_static(SUBPROTOCOL),
            );
            self.status("connecting");
            let config = WebSocketConfig::default()
                .max_message_size(Some(FRAME_LIMIT))
                .max_frame_size(Some(FRAME_LIMIT));
            let connection = tokio::time::timeout(
                self.timing.connect_timeout,
                connect_async_with_config(request, Some(config), false),
            );
            tokio::pin!(connection);
            let result = loop {
                tokio::select! {
                    biased;
                    command = rx.recv() => match self.command(command) {
                        CommandEffect::Stop => return,
                        CommandEffect::Keep => continue,
                        CommandEffect::Restart => { failures = 0; break None; }
                    },
                    result = &mut connection => break Some(result),
                }
            };
            let Some(result) = result else {
                continue;
            };
            match result {
                Ok(Ok((socket, response)))
                    if response
                        .headers()
                        .get("Sec-WebSocket-Protocol")
                        .is_some_and(|h| h == SUBPROTOCOL) =>
                {
                    self.lseq.clear();
                    self.status("online");
                    let (mut writer, mut reader) = socket.split();
                    let mut outbound: VecDeque<_> = self.subscription(None, false).into();
                    let mut deadline = tokio::time::Instant::now() + self.timing.silence_timeout;
                    let mut restart = false;
                    loop {
                        if outbound.len() > 64 {
                            break;
                        }
                        let next = outbound.front().cloned();
                        tokio::select! {
                            biased;
                            command = rx.recv() => {
                                match self.command(command) {
                                    CommandEffect::Stop => return,
                                    CommandEffect::Keep => continue,
                                    CommandEffect::Restart => { restart = true; break; }
                                }
                            }
                            _ = tokio::time::sleep_until(deadline) => break,
                            sent = async {
                                match next {
                                    Some(message) => writer.send(message).await,
                                    None => std::future::pending().await,
                                }
                            } => {
                                if sent.is_err() { break; }
                                outbound.pop_front();
                            }
                            frame = reader.next() => {
                                match frame {
                                    Some(Ok(message)) => {
                                        deadline = tokio::time::Instant::now() + self.timing.silence_timeout;
                                        if !message.is_close() { failures = 0; }
                                        match message {
                                            Message::Text(text) => {
                                                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                                                    outbound.extend(self.apply(value));
                                                    if self.halted { break; }
                                                }
                                            }
                                            Message::Close(close) => {
                                                if close.is_some_and(|frame| u16::from(frame.code) == 4401) {
                                                    self.halted = true;
                                                    self.status("unauthorized");
                                                }
                                                break;
                                            }
                                            Message::Ping(data) => outbound.push_back(Message::Pong(data)),
                                            _ => {},
                                        }
                                    }
                                    _ => break,
                                }
                            }
                        }
                    }
                    drop(writer);
                    drop(reader);
                    if restart {
                        failures = 0;
                        continue;
                    }
                }
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response)))
                    if response.status() == 401 || response.status() == 403 =>
                {
                    self.halted = true;
                    self.status("unauthorized");
                }
                _ => {}
            }
            if self.halted {
                continue;
            }
            self.status("offline");
            let delay = retry_delay(&self.timing, failures);
            failures = failures.saturating_add(1);
            let retry_deadline = tokio::time::Instant::now() + delay;
            loop {
                tokio::select! {
                    command = rx.recv() => match self.command(command) {
                        CommandEffect::Stop => return,
                        CommandEffect::Keep => continue,
                        CommandEffect::Restart => { failures = 0; break; }
                    },
                    _ = tokio::time::sleep_until(retry_deadline) => break,
                }
            }
        }
    }
}

struct SystemVault;
impl Vault for SystemVault {
    fn store(&self, endpoint: &str, token: &str) -> Result<(), String> {
        keyring::Entry::new("dssh-team-service", endpoint)
            .and_then(|e| e.set_password(token))
            .map_err(|_| "Cannot save team service credential".into())
    }
    fn load(&self, endpoint: &str) -> Result<String, String> {
        keyring::Entry::new("dssh-team-service", endpoint)
            .and_then(|e| e.get_password())
            .map_err(|_| "Team service credential unavailable".into())
    }
}
struct AppEvents(tauri::AppHandle);
impl EventSink for AppEvents {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit_to("main", event, payload);
    }
}
pub fn initialize(app: &tauri::AppHandle) -> Result<TeamService, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Team cache directory unavailable")?
        .join("team-service");
    Ok(TeamService::new(
        directory,
        Arc::new(SystemVault),
        Arc::new(AppEvents(app.clone())),
        Timing::default(),
    ))
}
#[tauri::command]
pub async fn team_service_configure(
    state: State<'_, TeamService>,
    url: String,
    token: String,
) -> Result<Value, String> {
    state.configure(url, token).await
}
#[tauri::command]
pub async fn team_service_subscribe(
    state: State<'_, TeamService>,
    projects: Vec<String>,
) -> Result<(), String> {
    state.subscribe(projects).await
}
#[tauri::command]
pub async fn team_service_read(state: State<'_, TeamService>) -> Result<Value, String> {
    state.read().await
}
#[tauri::command]
pub fn team_service_status(state: State<'_, TeamService>) -> Value {
    state.status()
}

#[cfg(test)]
#[path = "team_service_tests.rs"]
mod tests;
