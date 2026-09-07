use std::{fs, path::PathBuf, process::Command};
use crate::runtime::AppHandle;

fn config_value(value: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().any(|c| c.is_control() || c == '"') {
        return Err("SSH 配置包含不支持的字符".into());
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "/").replace('%', "%%")
    ))
}

fn folder_uri(alias: &str, path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err("请选择远程目录的绝对路径".into());
    }
    let encoded: String = path
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"/-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    Ok(format!("vscode-remote://ssh-remote+{alias}{encoded}"))
}

fn executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    for (env, suffix) in [
        ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
        ("ProgramFiles", "Microsoft VS Code/Code.exe"),
    ] {
        if let Some(root) = std::env::var_os(env) {
            candidates.push(PathBuf::from(root).join(suffix));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            candidates.push(path.join("Code.exe"));
            if path.file_name().is_some_and(|s| s == "bin") {
                candidates.push(path.join("../Code.exe"));
            }
            #[cfg(not(target_os = "windows"))]
            candidates.push(path.join("code"));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "未找到 VS Code。请安装正式版，或将其安装目录加入 PATH 后重启 dssh。".into())
}

pub async fn vscode_open(app: AppHandle, server_id: String, path: String) -> Result<(), String> {
    let exe = executable()?;
    let server = crate::servers::read_all(&app)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or("连接不存在，请先保存连接")?;
    let alias = format!(
        "dssh-{}",
        server
            .id
            .bytes()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let uri = folder_uri(&alias, &path)?;
    let mut entry = format!(
        "Host {alias}\n  HostName {}\n  User {}\n  Port {}\n",
        config_value(&server.host)?,
        config_value(&server.username)?,
        server.port
    );
    if server.auth_method == "publicKey" {
        if let Some(key) = server.key_path.as_deref().filter(|p| !p.is_empty()) {
            entry.push_str(&format!(
                "  IdentityFile {}\n  IdentitiesOnly yes\n",
                config_value(key)?
            ));
        }
    }
    // Restore global matching so an included Host block does not scope the
    // user's existing directives to the last dssh connection.
    entry.push_str("Host *\n");
    let home = std::env::home_dir().ok_or("无法确定用户主目录")?;
    let ssh = home.join(".ssh");
    let managed = ssh.join("dssh-vscode");
    fs::create_dir_all(&managed).map_err(|e| e.to_string())?;
    fs::write(managed.join(format!("{alias}.conf")), entry).map_err(|e| e.to_string())?;
    let config = ssh.join("config");
    let previous = match fs::read_to_string(&config) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("读取 SSH 配置失败：{e}")),
    };
    let include = "Include ~/.ssh/dssh-vscode/*.conf";
    if !previous.lines().any(|line| line.trim() == include) {
        if config.exists() {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos();
            fs::copy(&config, ssh.join(format!("config.dssh-backup-{stamp}")))
                .map_err(|e| e.to_string())?;
        }
        fs::write(
            &config,
            format!("# dssh: VS Code Remote-SSH connections\n{include}\n\n{previous}"),
        )
        .map_err(|e| e.to_string())?;
    }
    let mut command = Command::new(exe);
    command.args(["--new-window", "--folder-uri", &uri]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 VS Code 失败：{e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encodes_remote_folder_without_shell_interpretation() {
        assert_eq!(
            folder_uri("dssh-test", "/a b/#?中").unwrap(),
            "vscode-remote://ssh-remote+dssh-test/a%20b/%23%3F%E4%B8%AD"
        );
        assert!(folder_uri("test", "relative").is_err());
        assert!(config_value("host\nProxyCommand bad").is_err());
        assert_eq!(config_value("C:\\keys\\a b").unwrap(), "\"C:/keys/a b\"");
    }
}
