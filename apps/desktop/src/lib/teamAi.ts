export type AiProtocol="responses"|"chat";
export interface TeamAiConfig { endpoint:string; model:string; protocol?:AiProtocol; id?:string; name?:string }
export const protocolOf=(c:TeamAiConfig):AiProtocol=>c.protocol??(c.endpoint.includes("/chat/completions")?"chat":"responses");
export function protocolEndpoint(endpoint:string,protocol:AiProtocol){
  return endpoint.replace(/\/(?:chat\/completions|responses)\/?$/,protocol==="responses"?"/responses":"/chat/completions");
}
export const AI_PROVIDERS=[
  {id:"siliconflow",name:"硅基流动",endpoint:"https://api.siliconflow.cn/v1/chat/completions"},
  {id:"deepseek",name:"DeepSeek",endpoint:"https://api.deepseek.com/chat/completions"},
  {id:"openrouter",name:"OpenRouter",endpoint:"https://openrouter.ai/api/v1/chat/completions"},
  {id:"custom",name:"自定义",endpoint:""},
] as const;
export const TEAM_AI_CONFIG="dssh.team-ai.v1";
export const TEAM_AI_PROFILES="dssh.team-ai.profiles.v1";
function normalizeConfig(c:unknown):TeamAiConfig|undefined{
  if(!c||typeof c!=="object")return;
  const v=c as Record<string,unknown>;
  if(typeof v.endpoint!=="string"||typeof v.model!=="string")return;
  const config:TeamAiConfig={endpoint:v.endpoint,model:v.model};
  config.protocol=v.protocol==="chat"||v.protocol==="responses"?v.protocol:protocolOf(config);
  if(typeof v.id==="string"&&/^[a-zA-Z0-9-]{1,80}$/.test(v.id))config.id=v.id;
  if(typeof v.name==="string")config.name=v.name.slice(0,80);
  return config;
}
export const providerOf=(c:TeamAiConfig)=>AI_PROVIDERS.find(p=>p.id!=="custom"&&protocolEndpoint(p.endpoint,protocolOf(c))===c.endpoint)?.id??"custom";
export const configName=(c:TeamAiConfig)=>c.name||AI_PROVIDERS.find(p=>p.id===providerOf(c))!.name;
export function loadTeamAiProfiles():Record<string,TeamAiConfig>{
  try{
    const v=JSON.parse(localStorage.getItem(TEAM_AI_PROFILES)??"{}");
    const profiles:Record<string,TeamAiConfig>=Object.fromEntries(Object.entries(v??{}).slice(0,100).flatMap(([id,value])=>{
      const c=normalizeConfig(value);return c?[[id,c]]:[];
    }));
    const active=loadTeamAi();
    if(active.endpoint&&active.model&&!Object.values(profiles).some(c=>active.id?c.id===active.id:!c.id&&c.endpoint===active.endpoint))profiles[active.id??"legacy-active"]=active;
    return profiles;
  }catch{return {};}
}
export function loadTeamAi():TeamAiConfig {
  try {return normalizeConfig(JSON.parse(localStorage.getItem(TEAM_AI_CONFIG)??"{}"))??{endpoint:"",model:"",protocol:"responses"};}catch{return {endpoint:"",model:"",protocol:"responses"};}
}
/** Best-effort filtering; the preview remains necessary for project-specific secrets. */
export function redactTerminal(text:string):string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,"[私钥已隐藏]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{15,}|github_pat_[A-Za-z0-9_]{15,})\b/g,"[令牌已隐藏]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret|authorization)\s*[=:]\s*)(?:["']?)[^\s,;]+/gi,"$1[已隐藏]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi,"Bearer [已隐藏]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g,"").trim();
}
export async function excerptDigest(value:string){
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
}
