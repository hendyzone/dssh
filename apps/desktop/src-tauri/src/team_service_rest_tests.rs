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
                let header = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
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
