//! Native AI refresh requests and safe capability discovery.
use super::{
    rest::{self, RestContext, WriteError},
    *,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct AiRefreshResult {
    pub status: u16,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u32>,
}
#[derive(Debug, Serialize)]
pub struct Capabilities {
    pub ai_enabled: Option<bool>,
}

impl TeamService {
    async fn ai_request(
        &self,
        member: Option<(&str, &str)>,
    ) -> Result<(RestContext, reqwest::Response), WriteError> {
        if let Some((project, key)) = member {
            if !project_valid(project) || !rest::key_valid(key) {
                return Err(WriteError::new("validation_failed", 422));
            }
        }
        let context = self
            .native_context(member.map_or("", |(project, _)| project))
            .await?;
        let mut url = reqwest::Url::parse(&context.endpoint)
            .map_err(|_| WriteError::new("invalid_configuration", 0))?;
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(scheme)
            .map_err(|_| WriteError::new("invalid_configuration", 0))?;
        let base = url
            .path()
            .strip_suffix("/team/ws")
            .ok_or_else(|| WriteError::new("invalid_configuration", 0))?
            .to_owned();
        url.set_path(&base);
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| WriteError::new("invalid_configuration", 0))?;
            match member {
                Some((project, key)) => {
                    segments
                        .push("projects")
                        .push(project)
                        .push("team")
                        .push("members")
                        .push(key)
                        .push("ai")
                        .push("refresh");
                }
                None => {
                    segments.push("me");
                }
            }
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
        let method = if member.is_some() {
            reqwest::Method::POST
        } else {
            reqwest::Method::GET
        };
        let response = client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .send()
            .await
            .map_err(|_| WriteError::new("transport_error", 0))?;
        Ok((context, response))
    }

    pub async fn ai_refresh(
        &self,
        project: String,
        key: String,
    ) -> Result<AiRefreshResult, WriteError> {
        let (_context, response) = self.ai_request(Some((&project, &key))).await?;
        let status = response.status().as_u16();
        // The protocol defines Retry-After as seconds. A malformed/missing value
        // keeps the member cooldown rather than allowing an immediate retry.
        let retry_after = (status == 429).then(|| {
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
                .map(|v| {
                    v.bytes()
                        .fold(0u32, |seconds, digit| {
                            seconds
                                .saturating_mul(10)
                                .saturating_add(u32::from(digit - b'0'))
                        })
                        .min(3600)
                })
                .filter(|v| *v > 0)
                .unwrap_or(30)
        });
        if status == 202 {
            return Ok(AiRefreshResult {
                status,
                code: "accepted".to_owned(),
                retry_after: None,
            });
        }
        let value = rest::response_json(response).await.unwrap_or(Value::Null);
        let code = match (status, value["error"]["code"].as_str()) {
            (409, Some("no_live_session")) => "no_live_session",
            (429, Some("budget_exhausted")) => "budget_exhausted",
            (429, _) => "rate_limited",
            (503, Some("ai_disabled")) => "ai_disabled",
            _ => return Err(rest::response_error(status, &value)),
        };
        Ok(AiRefreshResult {
            status,
            code: code.to_owned(),
            retry_after,
        })
    }

    pub async fn capabilities(&self) -> Result<Capabilities, WriteError> {
        let (_context, response) = self.ai_request(None).await?;
        let status = response.status().as_u16();
        let value = rest::response_json(response).await?;
        if status != 200 {
            return Err(rest::response_error(status, &value));
        }
        if !value.is_object() {
            return Err(WriteError::new("invalid_response", 0));
        }
        Ok(Capabilities {
            ai_enabled: value["ai_enabled"].as_bool(),
        })
    }
}

#[tauri::command]
pub async fn team_service_ai_refresh(
    state: State<'_, TeamService>,
    project: String,
    key: String,
) -> Result<AiRefreshResult, WriteError> {
    state.ai_refresh(project, key).await
}
#[tauri::command]
pub async fn team_service_capabilities(
    state: State<'_, TeamService>,
) -> Result<Capabilities, WriteError> {
    state.capabilities().await
}
