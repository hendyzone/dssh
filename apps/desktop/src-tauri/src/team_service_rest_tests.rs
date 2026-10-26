use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

#[derive(Debug)]
struct RequestRecord {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Value,
    reply: oneshot::Sender<(u16, Value)>,
}
async fn http_server() -> (
    String,
    mpsc::UnboundedReceiver<RequestRecord>,
    tokio::task::JoinHandle<()>,
) {
    let (url, rx, _ws, task) = http_ws_server().await;
    (url, rx, task)
}
async fn http_ws_server() -> (
    String,
    mpsc::UnboundedReceiver<RequestRecord>,
    mpsc::UnboundedReceiver<WebSocketStream<TcpStream>>,
    tokio::task::JoinHandle<()>,
) {
    http_ws_server_with_headers("").await
}
async fn http_ws_server_with_headers(
    response_headers: &'static str,
) -> (
    String,
    mpsc::UnboundedReceiver<RequestRecord>,
    mpsc::UnboundedReceiver<WebSocketStream<TcpStream>>,
    tokio::task::JoinHandle<()>,
) {
    let (listener, url) = listener().await;
    let (tx, rx) = mpsc::unbounded_channel();
    let (ws_tx, ws_rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let tx = tx.clone();
            let ws_tx = ws_tx.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let end = loop {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let text = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let mut lines = text.lines();
                let mut first = lines.next().unwrap().split_whitespace();
                let method = first.next().unwrap().to_owned();
                let path = first.next().unwrap().to_owned();
                let headers: HashMap<_, _> = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(key, value)| (key.to_ascii_lowercase(), value.trim().to_owned()))
                    .collect();
                if headers.contains_key("upgrade") {
                    if ws_tx.is_closed() {
                        stream.write_all(b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    } else {
                        let accept = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
                            headers["sec-websocket-key"].as_bytes(),
                        );
                        let response = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: dssh-team.v1\r\n\r\n");
                        stream.write_all(response.as_bytes()).await.unwrap();
                        let ws = WebSocketStream::from_raw_socket(
                            stream,
                            tokio_tungstenite::tungstenite::protocol::Role::Server,
                            None,
                        )
                        .await;
                        let _ = ws_tx.send(ws);
                    }
                    return;
                }
                let length = headers
                    .get("content-length")
                    .map(|v| v.parse::<usize>().unwrap())
                    .unwrap_or(0);
                while bytes.len() < end + length {
                    let mut buffer = [0; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&bytes[end..end + length]).unwrap()
                };
                let (reply, response) = oneshot::channel();
                tx.send(RequestRecord {
                    method,
                    path,
                    headers,
                    body,
                    reply,
                })
                .unwrap();
                let (status, body) = response.await.unwrap();
                let body = body.to_string();
                let header = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{response_headers}\r\n", body.len());
                stream.write_all(header.as_bytes()).await.unwrap();
                stream.write_all(body.as_bytes()).await.unwrap();
            });
        }
    });
    (url, rx, ws_rx, task)
}
async fn request(rx: &mut mpsc::UnboundedReceiver<RequestRecord>) -> RequestRecord {
    let request = timeout(WAIT, rx.recv()).await.unwrap().unwrap();
    assert_eq!(
        request.headers.get("authorization").unwrap(),
        &format!("Bearer {TOKEN}")
    );
    request
}
fn rest_timing() -> Timing {
    Timing {
        retry_min: Duration::from_secs(5),
        retry_max: Duration::from_secs(5),
        jitter: || 1.0,
        ..timing(WAIT)
    }
}

#[tokio::test]
async fn team_service_rest_position_patch_has_precondition_without_optimistic_state() {
    let directory = Directory::new();
    let (url, mut requests, server) = http_server().await;
    let (service, mut events) = client(&directory, Arc::default(), rest_timing());
    configure(&service, url, vec![PROJECT.into()]).await;
    let task = tokio::spawn({
        let service = service.clone();
        async move { service.refresh(PROJECT.into()).await }
    });
    let get = request(&mut requests).await;
    assert_eq!(get.method, "GET");
    assert_eq!(get.path, format!("/api/v1/projects/{PROJECT}/team"));
    get.reply.send((200, snapshot(7))).unwrap();
    task.await.unwrap().unwrap();
    event(&mut events, "team://snapshot", |v| v["seq"] == 7).await;
    let before = service.inspect(PROJECT).await.unwrap();
    for field in ["host", "port", "username", "workdir", "tmux"] {
        let patch = json!({(field): member("member-one", 7)[field].clone()});
        let error = service
            .member_patch(PROJECT.into(), "member-one".into(), patch.clone(), None)
            .await
            .unwrap_err();
        assert_eq!(error.status, 412);
        assert_eq!(error.code, "if_match_required");
        let task = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .member_patch(PROJECT.into(), "member-one".into(), patch, Some(7))
                    .await
            }
        });
        let received = request(&mut requests).await;
        assert_eq!(received.method, "PATCH");
        assert_eq!(
            received.path,
            format!("/api/v1/projects/{PROJECT}/team/members/member-one")
        );
        assert_eq!(
            received.headers.get("if-match").map(String::as_str),
            Some("\"7\"")
        );
        received.reply.send((200, json!({"echo":TOKEN}))).unwrap();
        task.await.unwrap().unwrap();
        assert_eq!(
            service.inspect(PROJECT).await.unwrap(),
            before,
            "Successful REST writes wait for WS state"
        );
    }
    assert!(requests.try_recv().is_err());
    service.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn team_service_rest_batch_revisions_and_fixed_delete_identity() {
    let directory = Directory::new();
    let (url, mut requests, server) = http_server().await;
    let (service, _) = client(&directory, Arc::default(), rest_timing());
    configure(&service, url, vec![PROJECT.into()]).await;
    let batch = vec![member("member-one", 7), member("member-two", 9)];
    let task = tokio::spawn({
        let service = service.clone();
        let batch = batch.clone();
        async move { service.members_put(PROJECT.into(), batch).await }
    });
    let received = request(&mut requests).await;
    assert_eq!(received.method, "PUT");
    assert_eq!(received.body, json!(batch));
    assert!(!received.headers.contains_key("if-match"));
    received.reply.send((200, json!({"members":[]}))).unwrap();
    task.await.unwrap().unwrap();
    let task = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .member_delete(
                    PROJECT.into(),
                    "worker@example.invalid".into(),
                    "$3:123".into(),
                    7,
                )
                .await
        }
    });
    let received = request(&mut requests).await;
    assert_eq!(received.method, "DELETE");
    let url = reqwest::Url::parse(&format!("http://localhost{}", received.path)).unwrap();
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("tmux".into(), "$3:123".into())]
    );
    assert_eq!(
        received.headers.get("if-match").map(String::as_str),
        Some("\"7\"")
    );
    received
        .reply
        .send((
            409,
            json!({"error":{"code":"tmux_mismatch","message":TOKEN}}),
        ))
        .unwrap();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.status, 409);
    assert_eq!(error.code, "tmux_mismatch");
    assert!(!serde_json::to_string(&error).unwrap().contains(TOKEN));
    assert!(
        requests.try_recv().is_err(),
        "Deletion must not retry with another identity"
    );
    service.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn team_service_rest_conflict_refreshes_real_snapshot_and_never_returns_error_text() {
    let directory = Directory::new();
    let (url, mut requests, server) = http_server().await;
    let (service, mut events) = client(&directory, Arc::default(), rest_timing());
    configure(&service, url, vec![PROJECT.into()]).await;
    for code in ["rev_mismatch", TOKEN] {
        let task = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .member_patch(
                        PROJECT.into(),
                        "member-one".into(),
                        json!({"notes":"edited"}),
                        Some(1),
                    )
                    .await
            }
        });
        let received = request(&mut requests).await;
        received
            .reply
            .send((
                412,
                json!({"error":{"code":code,"message":TOKEN,"field":TOKEN}}),
            ))
            .unwrap();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error.status, 412);
        assert_eq!(
            error.code,
            if code == "rev_mismatch" {
                "rev_mismatch"
            } else {
                "request_failed"
            }
        );
        assert!(!serde_json::to_string(&error).unwrap().contains(TOKEN));
    }
    let task = tokio::spawn({
        let service = service.clone();
        async move { service.refresh(PROJECT.into()).await }
    });
    let received = request(&mut requests).await;
    assert_eq!(received.method, "GET");
    let mut latest = snapshot(12);
    latest["token"] = json!(TOKEN);
    latest["debug"] = json!({"authorization":TOKEN});
    received.reply.send((200, latest)).unwrap();
    task.await.unwrap().unwrap();
    event(&mut events, "team://snapshot", |v| v["seq"] == 12).await;
    assert_eq!(
        service.read().await.unwrap()["snapshots"][PROJECT]["members"][0]["rev"],
        12
    );
    assert!(!service.read().await.unwrap().to_string().contains(TOKEN));
    let cache = std::fs::read_to_string(directory.0.join("snapshots.json")).unwrap();
    assert!(
        !cache.contains(TOKEN),
        "Unknown refresh fields must not enter the durable cache"
    );
    service.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn team_service_rest_stale_refresh_does_not_replace_newer_ws_snapshot() {
    let directory = Directory::new();
    let (url, mut requests, mut sockets, server) = http_ws_server().await;
    let (service, mut events) = client(&directory, Arc::default(), rest_timing());
    configure(&service, url, vec![PROJECT.into()]).await;
    let mut socket = timeout(WAIT, sockets.recv()).await.unwrap().unwrap();
    receive(&mut socket).await;
    send(&mut socket, snapshot(7)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 7).await;
    let old = tokio::spawn({
        let service = service.clone();
        async move { service.refresh(PROJECT.into()).await }
    });
    let request = request(&mut requests).await;
    send(&mut socket, snapshot(9)).await;
    event(&mut events, "team://snapshot", |v| v["seq"] == 9).await;
    let before = service.inspect(PROJECT).await.unwrap();
    request.reply.send((200, snapshot(8))).unwrap();
    old.await.unwrap().unwrap();
    assert_eq!(service.inspect(PROJECT).await.unwrap(), before);
    service.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn team_service_ai_refresh_statuses_retry_after_and_safe_outputs() {
    for (status, code, header, expected_code, expected_retry) in [
        (202, "ignored", "", "accepted", None),
        (409, "no_live_session", "", "no_live_session", None),
        (
            429,
            "rate_limited",
            "Retry-After: 17\r\n",
            "rate_limited",
            Some(17),
        ),
        (
            429,
            "budget_exhausted",
            "Retry-After: 86400\r\n",
            "budget_exhausted",
            Some(3600),
        ),
        (429, "rate_limited", "", "rate_limited", Some(30)),
        (
            429,
            "rate_limited",
            "Retry-After: 1\r\n",
            "rate_limited",
            Some(1),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: 3600\r\n",
            "rate_limited",
            Some(3600),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: 4000000000\r\n",
            "rate_limited",
            Some(3600),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: 99999999999999999999999999999999999999999999\r\n",
            "rate_limited",
            Some(3600),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: 0\r\n",
            "rate_limited",
            Some(30),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: -1\r\n",
            "rate_limited",
            Some(30),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: 1.5\r\n",
            "rate_limited",
            Some(30),
        ),
        (
            429,
            "rate_limited",
            "Retry-After: invalid-secret\r\n",
            "rate_limited",
            Some(30),
        ),
        (503, "ai_disabled", "", "ai_disabled", None),
    ] {
        let directory = Directory::new();
        let (url, mut requests, _ws, server) = http_ws_server_with_headers(header).await;
        let (service, _events) = client(&directory, Arc::default(), rest_timing());
        configure(&service, url, vec![PROJECT.into()]).await;
        let task = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .ai_refresh(PROJECT.into(), "member/one@example.invalid".into())
                    .await
            }
        });
        let received = request(&mut requests).await;
        assert_eq!(received.method, "POST");
        assert_eq!(
            received.path,
            format!(
                "/api/v1/projects/{PROJECT}/team/members/member%2Fone@example.invalid/ai/refresh"
            )
        );
        assert_eq!(received.body, Value::Null);
        received
            .reply
            .send((
                status,
                json!({"queued":true,"token":TOKEN,"debug":TOKEN,
            "error":{"code":code,"message":TOKEN}}),
            ))
            .unwrap();
        let output = serde_json::to_value(task.await.unwrap().unwrap()).unwrap();
        let mut expected = json!({"status":status,"code":expected_code});
        if let Some(retry) = expected_retry {
            expected["retry_after"] = json!(retry);
        }
        assert_eq!(
            output, expected,
            "Only controlled result fields may cross IPC"
        );
        assert!(!output.to_string().contains(TOKEN));
        assert!(!service.read().await.unwrap().to_string().contains(TOKEN));
        assert!(
            service.inspect(PROJECT).await.is_none(),
            "Refresh must wait for a WS delta"
        );
        service.shutdown().await;
        server.abort();
    }
}

#[tokio::test]
async fn team_service_capabilities_exposes_only_optional_boolean() {
    let directory = Directory::new();
    let (url, mut requests, server) = http_server().await;
    let (service, _) = client(&directory, Arc::default(), rest_timing());
    configure(&service, url, vec![PROJECT.into()]).await;
    for enabled in [json!(false), json!(true), Value::Null, json!(TOKEN)] {
        let task = tokio::spawn({
            let service = service.clone();
            async move { service.capabilities().await }
        });
        let received = request(&mut requests).await;
        assert_eq!(received.method, "GET");
        assert_eq!(received.path, "/api/v1/me");
        received
            .reply
            .send((
                200,
                json!({"ai_enabled":enabled,"token":TOKEN,"label":TOKEN,"debug":TOKEN}),
            ))
            .unwrap();
        let result = serde_json::to_value(task.await.unwrap().unwrap()).unwrap();
        assert_eq!(result, json!({"ai_enabled":enabled.as_bool()}));
        assert!(!result.to_string().contains(TOKEN));
    }
    let task = tokio::spawn({
        let service = service.clone();
        async move { service.ai_refresh(PROJECT.into(), "one".into()).await }
    });
    request(&mut requests)
        .await
        .reply
        .send((401, json!({"error":{"code":TOKEN,"message":TOKEN}})))
        .unwrap();
    let error = serde_json::to_value(task.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(error, json!({"status":401,"code":"request_failed"}));
    service.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn team_service_projects_candidates_are_read_only_and_safe() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (service, _events) = client(&directory, vault.clone(), rest_timing());
    let (url, mut requests, server) = http_server().await;
    for (status, body, expected) in [
        (
            200,
            json!({"projects":[{"project":PROJECT,"seq":1,"members":0,"token":TOKEN}],"debug":TOKEN}),
            Some(vec![PROJECT.to_owned()]),
        ),
        (200, json!({"projects":[]}), Some(vec![])),
        (
            403,
            json!({"error":{"code":"project_forbidden","message":TOKEN},"token":TOKEN}),
            None,
        ),
        (200, json!({"projects":[{"project":"bad/project"}]}), None),
    ] {
        let task = tokio::spawn({
            let service = service.clone();
            let url = url.clone();
            async move { service.projects(Some(url), Some(TOKEN.into())).await }
        });
        let request = request(&mut requests).await;
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/v1/projects");
        assert_eq!(request.headers["authorization"], format!("Bearer {TOKEN}"));
        request.reply.send((status, body)).unwrap();
        let result = task.await.unwrap();
        match expected {
            Some(projects) => assert_eq!(result.unwrap().projects, projects),
            None => assert!(!serde_json::to_string(&result.err().unwrap())
                .unwrap()
                .contains(TOKEN)),
        }
        assert!(vault.0.lock().unwrap().is_empty());
        assert!(!directory.0.join("config.json").exists());
        assert!(service.backup().await.unwrap().is_none());
    }
    configure(&service, url, vec![PROJECT.into()]).await;
    let task = tokio::spawn({
        let service = service.clone();
        async move { service.projects(None, None).await }
    });
    request(&mut requests)
        .await
        .reply
        .send((200, json!({"projects":[{"project":PROJECT}]})))
        .unwrap();
    assert_eq!(task.await.unwrap().unwrap().projects, vec![PROJECT]);
    service.shutdown().await;
    server.abort();
}

fn sync_test_bundle(backup: Option<sync_config::Backup>) -> crate::sync::bundle::Bundle {
    let mut bundle = crate::sync::bundle::sample_bundle();
    bundle.entries.clear();
    bundle.ui_state.clear();
    bundle.team_service = backup;
    bundle
}
#[tokio::test]
async fn team_service_sync_restores_keyring_config_and_reconnects_without_secret_files() {
    let source_dir = Directory::new();
    let target_dir = Directory::new();
    let (url, _requests, mut sockets, server) = http_ws_server().await;
    let (source, _) = client(&source_dir, Arc::default(), rest_timing());
    configure(&source, url, vec![PROJECT.into()]).await;
    let backup = source.backup().await.unwrap().unwrap();
    let endpoint = backup.endpoint.clone();
    source.shutdown().await;
    while sockets.try_recv().is_ok() {}
    let vault = Arc::new(MemoryVault::default());
    let (target, mut events) = client(&target_dir, vault.clone(), rest_timing());
    target
        .restore_sync(
            target_dir.0.join("servers.json"),
            sync_test_bundle(Some(backup)),
        )
        .await
        .unwrap();
    let changed = event(&mut events, "team://configuration", |v| {
        v["url"] == endpoint
    })
    .await;
    assert_eq!(changed, json!({"url":endpoint,"projects":[PROJECT]}));
    assert_eq!(vault.load(&endpoint), Ok(TOKEN.to_owned()));
    let mut ws = timeout(WAIT, sockets.recv()).await.unwrap().unwrap();
    let sub = receive(&mut ws).await;
    assert_eq!(sub, json!({"type":"sub","projects":{(PROJECT):null}}));
    let read = target.read().await.unwrap();
    assert!(!read.to_string().contains(TOKEN));
    let config = std::fs::read_to_string(target_dir.0.join("config.json")).unwrap();
    assert!(!config.contains(TOKEN));
    assert_eq!(
        serde_json::from_str::<Value>(&config).unwrap()["projects"],
        json!([PROJECT])
    );
    for file in std::fs::read_dir(&target_dir.0)
        .unwrap()
        .flatten()
        .filter(|f| f.path().is_file())
    {
        assert!(!std::fs::read_to_string(file.path())
            .unwrap()
            .contains(TOKEN));
    }
    let mut old = sync_test_bundle(None);
    old.ui_state
        .insert("dssh.team-ai.v1".into(), "broken-json".into());
    old.ai_keys.insert("old".into(), "old-secret".into());
    let result = target
        .restore_sync(target_dir.0.join("servers.json"), old)
        .await
        .unwrap();
    assert!(result.ui_state.is_empty());
    assert_eq!(vault.load(&endpoint).unwrap(), TOKEN);
    assert_eq!(target.backup().await.unwrap().unwrap().endpoint, endpoint);
    target.shutdown().await;
    server.abort();
}

#[tokio::test]
async fn team_service_sync_configuration_failure_rolls_back_keyring_and_keeps_actor() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (service, _) = client(&directory, vault.clone(), rest_timing());
    let (url, _requests, server) = http_server().await;
    configure(&service, url, vec![PROJECT.into()]).await;
    let backup = service.backup().await.unwrap().unwrap();
    let endpoint = backup.endpoint.clone();
    let config = std::fs::read(directory.0.join("config.json")).unwrap();
    // Block only atomic config staging; the existing committed config remains intact.
    std::fs::create_dir(directory.0.join("config.tmp")).unwrap();
    let mut changed = backup.clone();
    changed.token = "replacement-secret".into();
    changed.projects = vec!["other".into()];
    assert!(service
        .restore_sync(
            directory.0.join("servers.json"),
            sync_test_bundle(Some(changed))
        )
        .await
        .is_err());
    assert_eq!(vault.load(&endpoint).unwrap(), TOKEN);
    assert_eq!(
        std::fs::read(directory.0.join("config.json")).unwrap(),
        config
    );
    assert_eq!(
        service.backup().await.unwrap().unwrap().projects,
        vec![PROJECT]
    );
    assert!(!directory.0.join("servers.json").exists());
    service.shutdown().await;
    server.abort();
}

struct RejectingVault;
impl Vault for RejectingVault {
    fn existing(&self, _: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    fn store(&self, _: &str, _: &str) -> Result<(), String> {
        Err("unavailable".into())
    }
    fn load(&self, _: &str) -> Result<String, String> {
        Err("missing".into())
    }
    fn remove(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}
#[tokio::test]
async fn team_service_sync_keyring_failure_does_not_commit_files_or_actor() {
    let directory = Directory::new();
    let (tx, mut events) = mpsc::unbounded_channel();
    let service = TeamService::new(
        directory.0.clone(),
        Arc::new(RejectingVault),
        Arc::new(Events(tx)),
        rest_timing(),
    );
    let backup = sync_config::Backup {
        endpoint: "https://team.example.invalid".into(),
        projects: vec![PROJECT.into()],
        token: TOKEN.into(),
    };
    let error = service
        .restore_sync(
            directory.0.join("servers.json"),
            sync_test_bundle(Some(backup)),
        )
        .await
        .err()
        .unwrap();
    assert!(!error.to_string().contains(TOKEN));
    assert!(!directory.0.join("config.json").exists());
    assert!(!directory.0.join("servers.json").exists());
    assert!(service.backup().await.unwrap().is_none());
    while let Ok((name, _)) = events.try_recv() {
        assert_ne!(name, "team://configuration");
    }
    service.shutdown().await;
}
#[tokio::test]
async fn team_service_sync_invalid_other_bundle_data_never_changes_service() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (service, _) = client(&directory, vault.clone(), rest_timing());
    let mut bundle = sync_test_bundle(Some(sync_config::Backup {
        endpoint: "https://team.example.invalid".into(),
        projects: vec![PROJECT.into()],
        token: TOKEN.into(),
    }));
    bundle
        .ui_state
        .insert("unrecognized-setting".into(), "{}".into());
    assert!(service
        .restore_sync(directory.0.join("servers.json"), bundle)
        .await
        .is_err());
    assert!(vault.0.lock().unwrap().is_empty());
    assert!(!directory.0.join("config.json").exists());
    assert!(service.backup().await.unwrap().is_none());
    service.shutdown().await;
}

#[derive(Default)]
struct UnreadableVault(std::sync::atomic::AtomicUsize);
impl Vault for UnreadableVault {
    fn store(&self, _: &str, _: &str) -> Result<(), String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    fn load(&self, _: &str) -> Result<String, String> {
        Err("unavailable".into())
    }
    fn existing(&self, _: &str) -> Result<Option<String>, String> {
        Err("unavailable".into())
    }
}
#[tokio::test]
async fn team_service_sync_unreadable_old_credential_aborts_before_any_write() {
    let directory = Directory::new();
    let vault = Arc::new(UnreadableVault::default());
    let (tx, _) = mpsc::unbounded_channel();
    let service = TeamService::new(
        directory.0.clone(),
        vault.clone(),
        Arc::new(Events(tx)),
        rest_timing(),
    );
    let bundle = sync_test_bundle(Some(sync_config::Backup {
        endpoint: "https://team.example.invalid".into(),
        projects: vec![PROJECT.into()],
        token: TOKEN.into(),
    }));
    assert!(service
        .restore_sync(directory.0.join("servers.json"), bundle)
        .await
        .is_err());
    assert_eq!(vault.0.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(!directory.0.join("config.json").exists());
    assert!(!directory.0.join("servers.json").exists());
    assert!(service.backup().await.unwrap().is_none());
    service.shutdown().await;
}

#[tokio::test]
async fn team_service_sync_cache_failure_restores_exact_files_and_credential() {
    let directory = Directory::new();
    let vault = Arc::new(MemoryVault::default());
    let (service, mut events) = client(&directory, vault.clone(), rest_timing());
    let (url, _requests, server) = http_server().await;
    configure(&service, url, vec![PROJECT.into()]).await;
    let backup = service.backup().await.unwrap().unwrap();
    let old_config = b"  {\"endpoint\":\"previous\"}  \n";
    let old_cache = b"invalid historical cache bytes\n";
    std::fs::write(directory.0.join("config.json"), old_config).unwrap();
    std::fs::write(directory.0.join("snapshots.json"), old_cache).unwrap();
    std::fs::create_dir(directory.0.join("snapshots.tmp")).unwrap();
    let mut changed = backup.clone();
    changed.token = "replacement-secret".into();
    changed.projects = vec!["other".into()];
    assert!(service
        .restore_sync(
            directory.0.join("servers.json"),
            sync_test_bundle(Some(changed))
        )
        .await
        .is_err());
    assert_eq!(
        std::fs::read(directory.0.join("config.json")).unwrap(),
        old_config
    );
    assert_eq!(
        std::fs::read(directory.0.join("snapshots.json")).unwrap(),
        old_cache
    );
    assert_eq!(vault.load(&backup.endpoint).unwrap(), TOKEN);
    assert_eq!(
        service.backup().await.unwrap().unwrap().projects,
        vec![PROJECT]
    );
    assert!(!directory.0.join("servers.json").exists());
    while let Ok((name, _)) = events.try_recv() {
        assert_ne!(name, "team://configuration");
    }
    service.shutdown().await;
    server.abort();
}
