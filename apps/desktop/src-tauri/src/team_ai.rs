use crate::servers;
use std::time::Duration;

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

fn models_url(value:&str)->Result<reqwest::Url,String>{
    let mut url=endpoint(value)?;
    let path=url.path().trim_end_matches('/');
    let base=path.strip_suffix("/responses").or_else(||path.strip_suffix("/chat/completions"))
        .ok_or("拉取列表需要以 /responses 或 /chat/completions 结尾的接口地址")?;
    let path=format!("{base}/models");url.set_path(&path);
    if url.host_str()==Some("api.siliconflow.cn"){url.set_query(Some("sub_type=chat"));}
    Ok(url)
}
fn parse_models(value:&serde_json::Value)->Result<Vec<String>,String>{
    let data=value["data"].as_array().ok_or("模型列表格式无效")?;
    let mut models:Vec<String>=data.iter().filter_map(|m|m["id"].as_str())
        .filter(|id|!id.trim().is_empty()&&id.len()<=200&&!id.chars().any(char::is_control)).map(str::to_string).collect();
    models.sort();models.dedup();models.truncate(5000);Ok(models)
}
async fn read_json(mut response:reqwest::Response,limit:usize)->Result<serde_json::Value,String>{
    if !response.status().is_success(){return Err(format!("模型接口返回 HTTP {}，请检查 Key、地址和协议",response.status().as_u16()));}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"模型响应读取失败")?{
        if bytes.len()+chunk.len()>limit{return Err("模型响应过大".into());}bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_|"模型响应格式无效".into())
}
#[tauri::command]
pub async fn team_ai_models(endpoint_url:String,key:Option<String>,profile_id:Option<String>)->Result<Vec<String>,String>{
    let url=models_url(&endpoint_url)?;
    let key=match key.filter(|k|!k.is_empty()){Some(k)=>k,None=>saved_key(&endpoint_url,profile_id.as_deref())?.ok_or("请先填写 API Key")?};
    if key.len()>4096||key.chars().any(char::is_control){return Err("API Key 格式无效".into());}
    let client=reqwest::Client::builder().timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none()).build().map_err(|_|"无法初始化模型连接")?;
    let response=client.get(url).bearer_auth(key).send().await.map_err(|_|"拉取模型列表失败或超时")?;
    parse_models(&read_json(response,4*1024*1024).await?)
}

pub(crate) fn endpoint(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "模型接口地址无效")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty()
        || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("请填写不含凭据或查询参数的 HTTPS 完整接口地址".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn team_ai_key(endpoint_url: String, key: Option<String>,profile_id:Option<String>) -> Result<bool, String> {
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
    #[test] fn models_and_responses_protocol(){
        assert_eq!(models_url("https://openrouter.ai/api/v1/responses").unwrap().as_str(),"https://openrouter.ai/api/v1/models");
        assert_eq!(models_url("https://api.deepseek.com/chat/completions").unwrap().as_str(),"https://api.deepseek.com/models");
        assert!(models_url("https://api.siliconflow.cn/v1/responses").unwrap().as_str().ends_with("models?sub_type=chat"));
        assert!(models_url("https://custom.test/unknown").is_err());
        assert_eq!(sibling(&endpoint("https://custom.test/proxy/v1/responses").unwrap()).unwrap().as_str(),"https://custom.test/proxy/v1/chat/completions");
        assert_eq!(parse_models(&serde_json::json!({"data":[{"id":"z"},{"id":"a"},{"id":"z"},{"id":""},{"name":"bad"}]})).unwrap(),vec!["a","z"]);
        assert!(parse_models(&serde_json::json!({"error":"failed"})).is_err());
    }
    #[test] fn rejects_unsafe_endpoints(){
        assert!(endpoint("http://example.test/v1/chat/completions").is_err());
        assert!(endpoint("https://key@example.test/v1/chat/completions").is_err());
        assert!(endpoint("https://example.test/v1/chat/completions").is_ok());
    }
}
