//! Headless backend transport. stdin/stdout carry newline-delimited JSON only.
use std::{path::PathBuf, sync::Arc};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

pub type State<'a, T> = &'a T;

#[derive(Clone)]
pub struct AppHandle {
    config_dir: PathBuf,
    output: mpsc::UnboundedSender<Value>,
}
impl AppHandle {
    pub fn path(&self) -> &Self { self }
    pub fn app_config_dir(&self) -> Result<PathBuf, std::io::Error> { Ok(self.config_dir.clone()) }
    pub fn emit<T: Serialize>(&self, event: &str, payload: T) -> Result<(), String> {
        let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
        self.output.send(json!({"event": event, "payload": payload})).map_err(|e| e.to_string())
    }
}

pub(crate) struct Context {
    pub app: AppHandle,
    pub ssh: crate::ssh::SshState,
    pub monitor: crate::monitor::MonitorState,
    pub forward: crate::forward::ForwardState,
}

#[derive(serde::Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = PathBuf::from(std::env::var_os("DSSH_CONFIG_DIR").ok_or("DSSH_CONFIG_DIR is required")?);
    if !config_dir.is_absolute() { return Err("DSSH_CONFIG_DIR must be absolute".into()); }
    let (output, mut messages) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = messages.recv().await {
            let mut bytes = serde_json::to_vec(&message)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    });
    let ctx = Arc::new(Context {
        app: AppHandle { config_dir, output: output.clone() },
        ssh: Default::default(), monitor: Default::default(), forward: Default::default(),
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut requests = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                let request: Request = match serde_json::from_str(&line) {
                    Ok(request) => request,
                    Err(_) => { eprintln!("Invalid backend request"); continue; }
                };
                let ctx = ctx.clone();
                requests.spawn(async move {
                    let result = crate::dispatch::dispatch(&ctx, &request.command, request.args).await;
                    let message = match result {
                        Ok(value) => json!({"id": request.id, "result": value}),
                        Err(error) => json!({"id": request.id, "error": error}),
                    };
                    let _ = ctx.app.output.send(message);
                });
            }
            result = requests.join_next(), if !requests.is_empty() => {
                // A panicked request must fail the service, so the parent rejects all pending calls.
                if result.is_some_and(|r| r.is_err()) { return Err("Backend request panicked".into()); }
            }
        }
    }
    requests.abort_all();
    drop(requests);
    drop(ctx);
    drop(output);
    // Session tasks own event senders; dropping the runtime terminates all connections on EOF.
    writer.abort();
    Ok(())
}
