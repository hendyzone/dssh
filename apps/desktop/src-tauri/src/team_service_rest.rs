//! REST writes use native credentials and never optimistically update roster state.
use super::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct WriteError {
    pub code: &'static str,
    pub status: u16,
}
impl WriteError {
    pub(super) fn new(code: &'static str, status: u16) -> Self {
        Self { code, status }
    }
    pub(super) fn stopped() -> Self {
        Self::new("service_stopped", 0)
    }
}
pub(super) struct RestContext {
    pub endpoint: String,
    pub token: String,
    pub generation: u64,
    pub initial: Option<Value>,
}

pub(super) fn key_valid(key: &str) -> bool {
    !key.is_empty() && key.len() <= 1024 && !key.chars().any(char::is_control)
}
pub(super) fn response_error(status: u16, value: &Value) -> WriteError {
    let code = match value["error"]["code"].as_str() {
        Some("rev_mismatch") => "rev_mismatch",
        Some("if_match_required") => "if_match_required",
        Some("tmux_mismatch") => "tmux_mismatch",
        Some("member_not_found") => "member_not_found",
        Some("not_found") => "not_found",
        Some("unauthorized") => "unauthorized",
        Some("forbidden") => "forbidden",
        Some("project_forbidden") => "project_forbidden",
        Some("source_forbidden") => "source_forbidden",
        Some("ai_fields_forbidden") => "ai_fields_forbidden",
        Some("validation_failed") => "validation_failed",
        Some("duplicate_member") => "duplicate_member",
        Some("roster_full") => "roster_full",
        Some("identity_immutable") => "identity_immutable",
        Some("payload_too_large") => "payload_too_large",
        Some("rate_limited") => "rate_limited",
        Some("overloaded") => "overloaded",
        _ => "request_failed",
    };
    WriteError::new(code, status)
}
pub(super) async fn response_json(mut response: reqwest::Response) -> Result<Value, WriteError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| WriteError::new("transport_error", 0))?
    {
        if bytes.len() + chunk.len() > FRAME_LIMIT {
            return Err(WriteError::new("invalid_response", 0));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| WriteError::new("invalid_response", 0))
}
impl TeamService {
    async fn rest_context(&self, project: &str) -> Result<RestContext, WriteError> {
        if !project_valid(project) {
            return Err(WriteError::new("validation_failed", 422));
        }
        self.native_context(project).await
    }
    pub(super) async fn native_context(&self, project: &str) -> Result<RestContext, WriteError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::RestContext(project.to_owned(), tx))
            .await
            .map_err(|_| WriteError::stopped())?;
        rx.await.map_err(|_| WriteError::stopped())?
    }
    async fn rest(
        &self,
        project: &str,
        method: reqwest::Method,
        key: Option<&str>,
        body: Option<Value>,
        rev: Option<u64>,
        tmux: Option<&str>,
    ) -> Result<(RestContext, Option<Value>), WriteError> {
        let context = self.rest_context(project).await?;
        let mut url = reqwest::Url::parse(&context.endpoint)
            .map_err(|_| WriteError::new("invalid_configuration", 0))?;
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(scheme)
            .map_err(|_| WriteError::new("invalid_configuration", 0))?;
        let path = url
            .path()
            .strip_suffix("/team/ws")
            .ok_or_else(|| WriteError::new("invalid_configuration", 0))?
            .to_owned();
        url.set_path(&path);
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| WriteError::new("invalid_configuration", 0))?;
            segments.push("projects").push(project).push("team");
            if method != reqwest::Method::GET {
                segments.push("members");
                if let Some(key) = key {
                    segments.push(key);
                }
            }
        }
        if let Some(tmux) = tmux {
            url.query_pairs_mut().append_pair("tmux", tmux);
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| WriteError::new("transport_error", 0))?;
        let mut authorization =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", context.token))
                .map_err(|_| WriteError::new("credential_unavailable", 0))?;
        authorization.set_sensitive(true);
        let refresh = method == reqwest::Method::GET;
        let mut request = client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, authorization);
        if let Some(rev) = rev {
            request = request.header(reqwest::header::IF_MATCH, format!("\"{rev}\""));
        }
        if let Some(body) = body {
            let bytes =
                serde_json::to_vec(&body).map_err(|_| WriteError::new("validation_failed", 422))?;
            if bytes.len() > 256 * 1024 {
                return Err(WriteError::new("payload_too_large", 413));
            }
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(bytes);
        }
        let response = request
            .send()
            .await
            .map_err(|_| WriteError::new("transport_error", 0))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            let value = response_json(response).await.unwrap_or(Value::Null);
            return Err(response_error(status, &value));
        }
        // A write's server body is not UI state. Only WS deltas apply successful writes.
        let snapshot = if refresh {
            Some(response_json(response).await?)
        } else {
            None
        };
        Ok((context, snapshot))
    }
    pub async fn member_patch(
        &self,
        project: String,
        key: String,
        patch: Value,
        rev: Option<u64>,
    ) -> Result<(), WriteError> {
        let fields = patch
            .as_object()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| WriteError::new("validation_failed", 422))?;
        if !key_valid(&key) {
            return Err(WriteError::new("validation_failed", 422));
        }
        if ["host", "port", "username", "workdir", "tmux"]
            .iter()
            .any(|key| fields.contains_key(*key))
            && rev.is_none()
        {
            return Err(WriteError::new("if_match_required", 412));
        }
        self.rest(
            &project,
            reqwest::Method::PATCH,
            Some(&key),
            Some(patch),
            rev,
            None,
        )
        .await?;
        Ok(())
    }
    pub async fn members_put(
        &self,
        project: String,
        members: Vec<Value>,
    ) -> Result<(), WriteError> {
        if members.is_empty() || members.len() > 100 || members.iter().any(|v| !v.is_object()) {
            return Err(WriteError::new("validation_failed", 422));
        }
        self.rest(
            &project,
            reqwest::Method::PUT,
            None,
            Some(json!(members)),
            None,
            None,
        )
        .await?;
        Ok(())
    }
    pub async fn member_delete(
        &self,
        project: String,
        key: String,
        tmux: String,
        rev: u64,
    ) -> Result<(), WriteError> {
        let valid = tmux.split_once(':').is_some_and(|(id, created)| {
            id.strip_prefix('$')
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
                && !created.is_empty()
                && created.bytes().all(|c| c.is_ascii_digit())
                && created
                    .parse::<u64>()
                    .is_ok_and(|v| v > 0 && v <= 9_007_199_254_740_991)
        });
        if !key_valid(&key) || !valid {
            return Err(WriteError::new("validation_failed", 422));
        }
        self.rest(
            &project,
            reqwest::Method::DELETE,
            Some(&key),
            None,
            Some(rev),
            Some(&tmux),
        )
        .await?;
        Ok(())
    }
    pub async fn refresh(&self, project: String) -> Result<(), WriteError> {
        let (context, value) = self
            .rest(&project, reqwest::Method::GET, None, None, None, None)
            .await?;
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Refresh(
                context.generation,
                project,
                context.initial,
                value.unwrap(),
                tx,
            ))
            .await
            .map_err(|_| WriteError::stopped())?;
        rx.await.map_err(|_| WriteError::stopped())?
    }
}
impl Actor {
    pub(super) fn rest_context(&self, project: &str) -> Result<RestContext, WriteError> {
        let endpoint = self
            .endpoint
            .clone()
            .ok_or_else(|| WriteError::new("not_configured", 0))?;
        let token = self
            .vault
            .load(&endpoint)
            .map_err(|_| WriteError::new("credential_unavailable", 0))?;
        Ok(RestContext {
            endpoint,
            token,
            generation: self.generation,
            initial: self.snapshots.get(project).cloned(),
        })
    }
    pub(super) fn refresh_snapshot(
        &mut self,
        generation: u64,
        project: &str,
        initial: Option<Value>,
        mut value: Value,
    ) -> Result<(), WriteError> {
        if generation != self.generation {
            return Err(WriteError::new("configuration_changed", 0));
        }
        if !self.projects.contains(project) {
            return Err(WriteError::new("project_not_subscribed", 0));
        }
        let valid = value["project"] == project
            && value["seq"].is_u64()
            && value["lseq"].is_u64()
            && value["members"].as_array().is_some_and(|v| v.len() <= 100)
            && value["ai"].is_object()
            && value["live"].is_object()
            && value["machines"].is_object();
        if !valid {
            return Err(WriteError::new("invalid_response", 0));
        }
        if let Some(current) = self.snapshots.get(project) {
            if current["seq"].as_u64() >= value["seq"].as_u64() {
                return Ok(());
            }
            // Preserve concurrent WS live/machine observations while refreshing durable data.
            if initial
                .as_ref()
                .map(|v| (&v["live"], &v["machines"], &v["lseq"]))
                != Some((&current["live"], &current["machines"], &current["lseq"]))
            {
                value["live"] = current["live"].clone();
                value["machines"] = current["machines"].clone();
                value["lseq"] = current["lseq"].clone();
            }
            let members: BTreeSet<_> = value["members"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m["key"].as_str().map(str::to_owned))
                .collect();
            value["live"]
                .as_object_mut()
                .unwrap()
                .retain(|key, _| members.contains(key));
        }
        value["type"] = json!("snapshot");
        let _ = self.apply(value);
        Ok(())
    }
}

#[tauri::command]
pub async fn team_service_member_patch(
    state: State<'_, TeamService>,
    project: String,
    key: String,
    patch: Value,
    rev: Option<u64>,
) -> Result<(), WriteError> {
    state.member_patch(project, key, patch, rev).await
}
#[tauri::command]
pub async fn team_service_members_put(
    state: State<'_, TeamService>,
    project: String,
    members: Vec<Value>,
) -> Result<(), WriteError> {
    state.members_put(project, members).await
}
#[tauri::command]
pub async fn team_service_member_delete(
    state: State<'_, TeamService>,
    project: String,
    key: String,
    tmux: String,
    rev: u64,
) -> Result<(), WriteError> {
    state.member_delete(project, key, tmux, rev).await
}
#[tauri::command]
pub async fn team_service_refresh(
    state: State<'_, TeamService>,
    project: String,
) -> Result<(), WriteError> {
    state.refresh(project).await
}
