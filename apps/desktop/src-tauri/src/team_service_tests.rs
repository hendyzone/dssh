use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::timeout,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{Request, Response},
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
    WebSocketStream,
};

const TOKEN: &str = "test-only-secret-value";
const PROJECT: &str = "example-project";
const WAIT: Duration = Duration::from_secs(3);

#[derive(Default)]
struct MemoryVault(Mutex<HashMap<String, String>>);
impl Vault for MemoryVault {
    fn store(&self, endpoint: &str, token: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(endpoint.to_owned(), token.to_owned());
        Ok(())
    }
    fn load(&self, endpoint: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(endpoint)
            .cloned()
            .ok_or_else(|| "No credential".to_owned())
    }
}
struct Events(mpsc::UnboundedSender<(String, Value)>);
impl EventSink for Events {
    fn emit(&self, event: &str, payload: Value) {
        assert!(
            !payload.to_string().contains(TOKEN),
            "Credential escaped through an event"
        );
        let _ = self.0.send((event.to_owned(), payload));
    }
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "team-service-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn timing(silence: Duration) -> Timing {
    Timing {
        connect_timeout: WAIT,
        silence_timeout: silence,
        retry_min: Duration::from_millis(10),
        retry_max: Duration::from_millis(30),
        jitter: || 0.0,
    }
}
fn client(
    dir: &Directory,
    vault: Arc<MemoryVault>,
    limits: Timing,
) -> (TeamService, mpsc::UnboundedReceiver<(String, Value)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        TeamService::new(dir.0.clone(), vault, Arc::new(Events(tx)), limits),
        rx,
    )
}
async fn listener() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    (listener, url)
}
async fn accept(listener: &TcpListener) -> WebSocketStream<TcpStream> {
    let (stream, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
    timeout(
        WAIT,
        accept_hdr_async(stream, |request: &Request, mut response: Response| {
            assert_eq!(request.uri().path(), "/api/v1/team/ws");
            assert!(
                request
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|value| value == format!("Bearer {TOKEN}")),
                "Missing expected authorization"
            );
            assert_eq!(
                request.headers().get("sec-websocket-protocol").unwrap(),
                "dssh-team.v1"
            );
            response
                .headers_mut()
                .insert("sec-websocket-protocol", "dssh-team.v1".parse().unwrap());
            Ok(response)
        }),
    )
    .await
    .unwrap()
    .unwrap()
}
async fn receive(socket: &mut WebSocketStream<TcpStream>) -> Value {
    timeout(WAIT, async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => break serde_json::from_str(&text).unwrap(),
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                other => panic!("Unexpected client frame: {other:?}"),
            }
        }
    })
    .await
    .unwrap()
}
async fn send(socket: &mut WebSocketStream<TcpStream>, value: Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}
async fn event(
    rx: &mut mpsc::UnboundedReceiver<(String, Value)>,
    name: &str,
    matches: impl Fn(&Value) -> bool,
) -> Value {
    timeout(WAIT, async {
        loop {
            let (kind, payload) = rx.recv().await.expect("Event channel closed");
            if kind == name && matches(&payload) {
                break payload;
            }
        }
    })
    .await
    .expect("Expected service event was not emitted")
}
async fn configure(service: &TeamService, url: String, projects: Vec<String>) {
    service.subscribe(projects).await.unwrap();
    let status = service.configure(url, TOKEN.to_owned()).await.unwrap();
    assert_eq!(status["token_configured"], true);
    assert!(
        !status.to_string().contains(TOKEN),
        "Credential escaped through configuration result"
    );
}
fn member(key: &str, revision: u64) -> Value {
    json!({"project":PROJECT,"key":key,"email":"","id":key,"role":"worker","host":"127.0.0.1","port":22,
        "username":"dev","workdir":"/srv/example-project","tmux":{"id":"$1","created":100,"name":"worker-example"},
        "updatedAt":"2026-01-01T00:00:00Z","rev":revision})
}
fn live(key: &str, state: &str) -> Value {
    json!({"key":key,"machine":"machine-a","session":"$1:100","match":"exact","state":state,
        "detail":"","since":"2026-01-01T00:00:00Z","ctx_pct":null,"model":"","last_line":"",
        "at":"2026-01-01T00:00:00Z","stale":false})
}
fn snapshot(seq: u64) -> Value {
    json!({"type":"snapshot","project":PROJECT,"seq":seq,"lseq":100,
        "members":[member("member-one",seq)],"ai":{},"live":{"member-one":live("member-one","idle")},"machines":{}})
}

#[tokio::test]
async fn team_service_initial_handshake_and_multi_project_subscription() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(
        &service,
        url,
        vec![PROJECT.to_owned(), "other-project".to_owned()],
    )
    .await;
    let mut socket = accept(&listener).await;
    assert_eq!(
        receive(&mut socket).await,
        json!({"type":"sub","projects":{(PROJECT):null,"other-project":null}})
    );
    send(&mut socket, snapshot(1)).await;
    let value = event(&mut events, "team://snapshot", |v| v["seq"] == 1).await;
    assert_eq!(value["members"][0]["key"], "member-one");
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_delta_order_and_gap_resubscribes_with_last_applied_sequence() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    send(&mut socket, snapshot(1)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 1).await;
    send(&mut socket,json!({"type":"delta","project":PROJECT,"seq":2,"ops":[{"op":"upsert","member":member("member-two",2)}]})).await;
    event(&mut events, "team://delta", |v| v["seq"] == 2).await;
    for seq in [1, 2] {
        send(&mut socket,json!({"type":"delta","project":PROJECT,"seq":seq,"ops":[{"op":"upsert","member":member("member-duplicate",seq)}]})).await;
    }
    send(
        &mut socket,
        json!({"type":"delta","project":PROJECT,"seq":4,"ops":[]}),
    )
    .await;
    // A later frame on this connection proves the actor has processed the gap.
    send(
        &mut socket,
        json!({"type":"machine","name":"gap-barrier","online":false,
            "seen":"2026-01-01T00:00:00Z","version":"0.1.0"}),
    )
    .await;
    event(&mut events, "team://live", |value| {
        value["type"] == "machine" && value["name"] == "gap-barrier"
    })
    .await;
    let before_recovery = service.inspect(PROJECT).await.unwrap();
    assert_eq!(
        before_recovery["seq"], 2,
        "A gap must not advance durable state"
    );
    assert_eq!(before_recovery["members"].as_array().unwrap().len(), 2);
    assert!(!before_recovery.to_string().contains("member-duplicate"));
    assert_eq!(
        receive(&mut socket).await,
        json!({"type":"sub","projects":{(PROJECT):2}})
    );
    send(&mut socket,json!({"type":"delta","project":PROJECT,"seq":3,"ops":[{"op":"remove","key":"member-one"}]})).await;
    let mut sequences = Vec::new();
    timeout(WAIT, async {
        while let Some((name, value)) = events.recv().await {
            if name == "team://delta" {
                sequences.push(value["seq"].as_u64().unwrap());
                if value["seq"] == 3 {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        sequences,
        vec![3],
        "Old and gap deltas must not be published"
    );
    let recovered = service.inspect(PROJECT).await.unwrap();
    assert_eq!(recovered["seq"], 3);
    assert_eq!(recovered["members"].as_array().unwrap().len(), 1);
    assert_eq!(recovered["members"][0]["key"], "member-two");
    assert_eq!(recovered["live"], json!({}));
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_disconnect_retains_durable_sequence_and_resets_live_sequence() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut first = accept(&listener).await;
    receive(&mut first).await;
    send(&mut first, snapshot(7)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 7).await;
    send(&mut first,json!({"type":"live","project":PROJECT,"lseq":101,"full":true,"items":[live("member-one","running")]})).await;
    event(&mut events, "team://live", |v| v["lseq"] == 101).await;
    first.close(None).await.unwrap();
    drop(first);
    let mut second = accept(&listener).await;
    assert_eq!(
        receive(&mut second).await,
        json!({"type":"sub","projects":{(PROJECT):7}})
    );
    send(&mut second,json!({"type":"live","project":PROJECT,"lseq":1,"full":true,"items":[live("member-one","idle")]})).await;
    let value = event(&mut events, "team://live", |v| v["lseq"] == 1).await;
    assert_eq!(value["items"][0]["state"], "idle");
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_live_order_machine_unknown_messages_and_resync_snapshot() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    send(&mut socket, snapshot(20)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 20).await;
    send(&mut socket, json!({"type":"future-message","unknown":true})).await;
    send(
        &mut socket,
        json!({"type":"live","project":PROJECT,"lseq":101,"full":true,"items":[]}),
    )
    .await;
    event(&mut events, "team://live", |v| v["lseq"] == 101).await;
    assert_eq!(service.inspect(PROJECT).await.unwrap()["live"], json!({}));

    send(&mut socket,json!({"type":"live","project":PROJECT,"lseq":100,"full":false,"items":[live("member-one","stuck")]})).await;
    send(&mut socket,json!({"type":"machine","name":"machine-a","online":false,"seen":"2026-01-01T00:00:00Z","version":"0.1.0"})).await;
    let machine = timeout(WAIT, async {
        loop {
            let (name, value) = events.recv().await.unwrap();
            if name == "team://live" {
                assert_ne!(value["lseq"], 100, "Older live state must be ignored");
                if value["type"] == "machine" {
                    break value;
                }
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(machine["online"], false);
    let state = service.inspect(PROJECT).await.unwrap();
    assert_eq!(
        state["live"],
        json!({}),
        "Old live updates must not repopulate a replaced map"
    );
    assert_eq!(state["machines"]["machine-a"]["online"], false);
    send(
        &mut socket,
        json!({"type":"error","code":"resync","project":PROJECT}),
    )
    .await;
    send(&mut socket, snapshot(2)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 2).await;
    send(
        &mut socket,
        json!({"type":"delta","project":PROJECT,"seq":3,"ops":[]}),
    )
    .await;
    event(&mut events, "team://delta", |v| v["seq"] == 3).await;
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_silence_timeout_reconnects_through_real_loop() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, _events) = client(
        &directory,
        Arc::default(),
        timing(Duration::from_millis(60)),
    );
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut first = accept(&listener).await;
    receive(&mut first).await;
    let mut second = accept(&listener).await;
    assert_eq!(
        receive(&mut second).await,
        json!({"type":"sub","projects":{(PROJECT):null}})
    );
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_unauthorized_close_stops_reconnecting() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    socket
        .close(Some(CloseFrame {
            code: CloseCode::from(4401),
            reason: "authorization revoked".into(),
        }))
        .await
        .unwrap();
    event(&mut events, "team://status", |v| {
        v["state"] == "unauthorized"
    })
    .await;
    assert!(
        timeout(Duration::from_millis(180), listener.accept())
            .await
            .is_err(),
        "Unauthorized connection must remain stopped"
    );
    service.shutdown().await;
}

#[test]
fn team_service_url_policy_checks_real_validator() {
    for url in [
        "http://203.0.113.1",
        "ws://203.0.113.1",
        "http://team.example.invalid",
        "http://localhost",
        "ftp://127.0.0.1",
        "https://user:secret@team.example.invalid",
    ] {
        assert!(validate_url(url).is_err(), "Unsafe URL was accepted: {url}");
    }
    for url in [
        "http://127.0.0.1",
        "http://10.0.0.1",
        "ws://172.16.0.1",
        "http://[::1]",
        "ws://[fc00::1]",
        "https://team.example.invalid",
        "wss://team.example.invalid",
    ] {
        assert!(validate_url(url).is_ok(), "Allowed URL was rejected: {url}");
    }
    assert_eq!(
        validate_url("http://127.0.0.1:8093/api/v1/").unwrap(),
        "ws://127.0.0.1:8093/api/v1/team/ws"
    );
}

#[tokio::test]
async fn team_service_restart_emits_offline_cache_before_authoritative_replacement() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let vault = Arc::new(MemoryVault::default());
    let (service, mut events) = client(&directory, vault.clone(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    send(&mut socket, snapshot(9)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 9).await;
    service.shutdown().await;
    drop(socket);
    for file in std::fs::read_dir(&directory.0).unwrap() {
        let bytes = std::fs::read(file.unwrap().path()).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains(TOKEN),
            "Credential escaped into cache"
        );
    }
    let (restarted, mut events) = client(&directory, vault, timing(WAIT));
    let cached = event(&mut events, "team://snapshot", |v| {
        v["seq"] == 9 && v["offline"] == true
    })
    .await;
    assert_eq!(cached["members"][0]["key"], "member-one");
    let mut next = accept(&listener).await;
    assert_eq!(
        receive(&mut next).await,
        json!({"type":"sub","projects":{(PROJECT):9}})
    );
    let mut replacement = snapshot(10);
    replacement["members"] = json!([]);
    send(&mut next, replacement).await;
    let fresh = event(&mut events, "team://snapshot", |v| v["seq"] == 10).await;
    assert_eq!(fresh["members"], json!([]));
    assert_ne!(fresh["offline"], true);
    restarted.shutdown().await;
}

#[tokio::test]
async fn team_service_pongs_refresh_silence_deadline() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, _events) = client(
        &directory,
        Arc::default(),
        timing(Duration::from_millis(150)),
    );
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut first = accept(&listener).await;
    receive(&mut first).await;
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(65)).await;
        send(
            &mut first,
            json!({"type":"pong","time":"2026-01-01T00:00:00Z"}),
        )
        .await;
    }
    assert!(
        timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "Pong activity must prevent a silence reconnect"
    );
    let mut second = accept(&listener).await;
    assert_eq!(
        receive(&mut second).await,
        json!({"type":"sub","projects":{(PROJECT):null}})
    );
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_delta_updates_are_persisted_and_removed_members_drop_ai() {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let vault = Arc::new(MemoryVault::default());
    let (service, mut events) = client(&directory, vault.clone(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    let mut initial = snapshot(1);
    initial["ai"] = json!({"member-one":{"status":"idle","summary":"Ready","evidence":"","digest":format!("sha256:{}","0".repeat(64)),"source":{"machine":"machine-a","session":"$1:100"},"model":"example-model","updatedAt":"2026-01-01T00:00:00Z"}});
    send(&mut socket, initial).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 1).await;
    send(&mut socket,json!({"type":"delta","project":PROJECT,"seq":2,"ops":[{"op":"remove","key":"member-one"}]})).await;
    event(&mut events, "team://delta", |v| v["seq"] == 2).await;
    let state = service.inspect(PROJECT).await.unwrap();
    assert_eq!(state["live"], json!({}));
    assert_eq!(state["ai"], json!({}));
    service.shutdown().await;
    drop(socket);
    let (restarted, mut events) = client(&directory, vault, timing(WAIT));
    let cached = event(&mut events, "team://snapshot", |v| v["offline"] == true).await;
    assert_eq!(cached["seq"], 2);
    assert_eq!(cached["members"], json!([]));
    assert_eq!(cached["ai"], json!({}));
    assert_eq!(cached["live"], json!({}));
    assert_eq!(cached["machines"], json!({}));
    restarted.shutdown().await;
}

#[tokio::test]
async fn team_service_reconfiguration_fences_old_socket_and_cache_endpoint() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (first_listener, first_url) = listener().await;
    let (second_listener, second_url) = listener().await;
    let (service, mut events) = client(&directory, vault.clone(), timing(WAIT));
    configure(&service, first_url, vec![PROJECT.to_owned()]).await;
    let mut first = accept(&first_listener).await;
    receive(&mut first).await;
    send(&mut first, snapshot(50)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 50).await;

    service
        .configure(second_url, TOKEN.to_owned())
        .await
        .unwrap();
    assert!(service.inspect(PROJECT).await.is_none());
    // The old peer may observe the disconnect before or after this write.
    let _ = first
        .send(Message::Text(snapshot(999).to_string().into()))
        .await;
    let mut second = accept(&second_listener).await;
    assert_eq!(
        receive(&mut second).await,
        json!({"type":"sub","projects":{(PROJECT):null}})
    );
    send(&mut second, snapshot(1)).await;
    timeout(WAIT, async {
        loop {
            let (name, value) = events.recv().await.unwrap();
            if name == "team://snapshot" {
                assert_ne!(value["seq"], 999, "Old connection leaked a snapshot");
                if value["seq"] == 1 {
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(service.inspect(PROJECT).await.unwrap()["seq"], 1);
    service.shutdown().await;
    drop(first);
    drop(second);

    let (restarted, mut events) = client(&directory, vault, timing(WAIT));
    let cached = event(&mut events, "team://snapshot", |v| v["offline"] == true).await;
    assert_eq!(cached["seq"], 1);
    let mut latest = accept(&second_listener).await;
    assert_eq!(
        receive(&mut latest).await,
        json!({"type":"sub","projects":{(PROJECT):1}})
    );
    restarted.shutdown().await;
}

#[tokio::test]
async fn team_service_wss_handshake_failure_keeps_actor_alive() {
    use tokio::io::AsyncReadExt;
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(
        &service,
        url.replacen("http:", "wss:", 1),
        vec![PROJECT.to_owned()],
    )
    .await;
    let (mut stream, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
    let mut record = [0u8; 5];
    timeout(WAIT, stream.read_exact(&mut record))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record[0], 22, "Expected a TLS handshake record");
    drop(stream);
    event(&mut events, "team://status", |v| v["state"] == "offline").await;
    // A panic in TLS provider selection would terminate the actor and this command.
    timeout(WAIT, service.subscribe(vec!["other-project".to_owned()]))
        .await
        .unwrap()
        .unwrap();
    service.shutdown().await;
}

#[test]
fn team_service_retry_jitter_has_exponential_ceiling_and_cap() {
    let mut limits = timing(WAIT);
    limits.retry_min = Duration::from_secs(1);
    limits.retry_max = Duration::from_secs(30);
    limits.jitter = || 1.0;
    assert_eq!(retry_delay(&limits, 0), Duration::from_secs(1));
    assert_eq!(retry_delay(&limits, 1), Duration::from_secs(2));
    assert_eq!(retry_delay(&limits, 4), Duration::from_secs(16));
    assert_eq!(retry_delay(&limits, 5), Duration::from_secs(30));
    assert_eq!(retry_delay(&limits, u32::MAX), Duration::from_secs(30));
    limits.jitter = || 0.5;
    assert_eq!(retry_delay(&limits, 5), Duration::from_secs(15));
    limits.jitter = || 0.0;
    assert_eq!(retry_delay(&limits, 5), Duration::ZERO);
}

#[tokio::test]
async fn team_service_read_preserves_cache_timestamp_and_never_returns_credential() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, vault.clone(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    send(&mut socket, snapshot(20)).await;
    let delivered = event(&mut events, "team://snapshot", |v| v["seq"] == 20).await;
    let timestamp = delivered["savedAt"].as_u64().unwrap();
    assert!(timestamp > 0);
    let read = service.read().await.unwrap();
    assert!(!read.to_string().contains(TOKEN));
    assert_eq!(read["status"]["token_configured"], true);
    assert_eq!(read["snapshots"][PROJECT]["savedAt"], timestamp);
    service
        .subscribe(vec![PROJECT.to_owned(), "another-project".into()])
        .await
        .unwrap();
    assert_eq!(
        service.read().await.unwrap()["snapshots"][PROJECT]["savedAt"],
        timestamp
    );
    service.shutdown().await;
    let (restarted, mut cached_events) = client(&directory, vault, timing(WAIT));
    let cached = event(&mut cached_events, "team://snapshot", |v| {
        v["offline"] == true
    })
    .await;
    assert_eq!(cached["savedAt"], timestamp);
    assert_eq!(
        restarted.read().await.unwrap()["snapshots"][PROJECT]["savedAt"],
        timestamp
    );
    restarted.shutdown().await;
}

#[tokio::test]
async fn team_service_legacy_cache_read_has_unknown_timestamp() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, vault.clone(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    receive(&mut socket).await;
    send(&mut socket, snapshot(1)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 1).await;
    service.shutdown().await;
    let path = directory.0.join("snapshots.json");
    let mut legacy: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    legacy["projects"][PROJECT]
        .as_object_mut()
        .unwrap()
        .remove("savedAt");
    std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    let (restarted, mut cached_events) = client(&directory, vault, timing(WAIT));
    let cached = event(&mut cached_events, "team://snapshot", |v| {
        v["offline"] == true
    })
    .await;
    assert!(cached["savedAt"].is_null());
    assert!(restarted.read().await.unwrap()["snapshots"][PROJECT]["savedAt"].is_null());
    restarted.shutdown().await;
}

async fn assert_old_delta_is_silent(sequence: u64) {
    let directory = Directory::new();
    let (listener, url) = listener().await;
    let (service, mut events) = client(&directory, Arc::default(), timing(WAIT));
    configure(&service, url, vec![PROJECT.to_owned()]).await;
    let mut socket = accept(&listener).await;
    assert_eq!(
        receive(&mut socket).await,
        json!({"type":"sub","projects":{(PROJECT):null}})
    );
    send(&mut socket, snapshot(5)).await;
    event(&mut events, "team://snapshot", |value| value["seq"] == 5).await;
    let before = service.inspect(PROJECT).await.unwrap();
    send(
        &mut socket,
        json!({"type":"delta","project":PROJECT,"seq":sequence,
            "ops":[{"op":"upsert","member":member("member-stale-write",sequence)}]}),
    )
    .await;
    let barrier = format!("old-delta-{sequence}").into_bytes();
    socket
        .send(Message::Ping(barrier.clone().into()))
        .await
        .unwrap();
    // The actor queues replies in order. A resubscription caused by the preceding
    // delta must arrive before this pong; no sleep-based absence check is needed.
    let response = timeout(WAIT, socket.next())
        .await
        .expect("Expected the processing barrier pong")
        .expect("Client closed before the processing barrier")
        .expect("Failed to read the processing barrier");
    assert_eq!(
        response,
        Message::Pong(barrier.into()),
        "Delta seq {sequence} <= local 5 must not send an extra subscription"
    );
    assert_eq!(
        service.inspect(PROJECT).await.unwrap(),
        before,
        "Delta seq {sequence} <= local 5 must leave roster, sequence and cache timestamp unchanged"
    );
    while let Ok((name, _)) = events.try_recv() {
        assert_ne!(
            name, "team://delta",
            "Discarded delta must not be published"
        );
    }
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_duplicate_delta_does_not_resubscribe_or_change_roster() {
    assert_old_delta_is_silent(5).await;
}

#[tokio::test]
async fn team_service_expired_delta_does_not_resubscribe_or_change_roster() {
    assert_old_delta_is_silent(4).await;
}

#[path = "team_service_rest_tests.rs"]
mod rest_tests;
