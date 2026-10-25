//! Legacy encrypted-bundle credential compatibility; no frontend commands.
use crate::servers;

fn sibling(url: &reqwest::Url) -> Option<reqwest::Url> {
    let path=url.path().trim_end_matches('/');
    let next=if let Some(base)=path.strip_suffix("/responses") {format!("{base}/chat/completions")}
        else {format!("{}/responses",path.strip_suffix("/chat/completions")?)};
    let mut result=url.clone();result.set_path(&next);Some(result)
}
pub(crate) fn credential_ref(value:&str,profile_id:Option<&str>)->Result<String,String>{
    let url=endpoint(value)?;
    match profile_id {
        Some(id) if !id.is_empty()&&id.len()<=80&&id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')=>Ok(format!("profile:{id}:{url}")),
        Some(_)=>Err("模型配置身份无效".into()),
        None=>Ok(url.to_string()),
    }
}
pub(crate) fn saved_key(value:&str,profile_id:Option<&str>)->Result<Option<String>,String>{
    let url=endpoint(value)?;
    let reference=credential_ref(value,profile_id)?;
    let key=servers::export_secret(&format!("team-ai:{reference}"),"api-key").map_err(|_|"无法读取模型 API Key")?;
    if key.is_some(){return Ok(key);}
    match sibling(&url) {
        Some(other)=>servers::export_secret(&format!("team-ai:{}",credential_ref(other.as_str(),profile_id)?),"api-key").map_err(|_|"无法读取模型 API Key".into()),
        None=>Ok(None),
    }
}

pub(crate) fn endpoint(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "模型接口地址无效")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("请填写不含凭据或查询参数的 HTTPS 完整接口地址".into());
    }
    Ok(url)
}

// Kept only for legacy encrypted-bundle credential isolation tests.
#[cfg(test)]
pub(crate) fn team_ai_key(endpoint_url: String, key: Option<String>,profile_id:Option<String>) -> Result<bool, String> {
    let url = endpoint(&endpoint_url)?.to_string();
    let account = format!("team-ai:{}",credential_ref(&url,profile_id.as_deref())?);
    if let Some(key) = key {
        if key.is_empty() {
            servers::delete_secret(&account, "api-key");
            if let Some(other)=sibling(&endpoint(&url)?){servers::delete_secret(&format!("team-ai:{}",credential_ref(other.as_str(),profile_id.as_deref())?),"api-key");}
        }
        else {
            if key.len() > 4096 || key.chars().any(char::is_control) { return Err("API Key 格式无效".into()); }
            servers::set_secret(&account, "api-key", &key).map_err(|_| "无法保存 API Key")?;
        }
    }
    Ok(saved_key(&url,profile_id.as_deref())?.is_some())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_unsafe_endpoints(){
        assert!(endpoint("http://example.test/v1/chat/completions").is_err());
        assert!(endpoint("https://key@example.test/v1/chat/completions").is_err());
        assert!(endpoint("https://example.test/v1/chat/completions").is_ok());
    }
}
