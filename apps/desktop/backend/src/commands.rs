//! 与本地桌面环境交互的命令。

use std::{env, fs, path::PathBuf};

/// 列出用户 SSH 目录中常见的私钥文件名。
pub fn list_ssh_keys() -> Result<Vec<String>, SshKeysError> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| SshKeysError::Other("无法找到用户主目录".into()))?;
    let ssh_dir = home.join(".ssh");

    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }

    let mut keys = Vec::new();
    for entry in fs::read_dir(&ssh_dir).map_err(|e| SshKeysError::Other(e.to_string()))? {
        let entry = entry.map_err(|e| SshKeysError::Other(e.to_string()))?;
        if !entry
            .file_type()
            .map_err(|e| SshKeysError::Other(e.to_string()))?
            .is_file()
        {
            continue;
        }

        let name = entry.file_name().to_string_lossy().into_owned();
        let is_common_key = matches!(name.as_str(), "id_ed25519" | "id_rsa" | "id_ecdsa");
        let is_pem = name.ends_with(".pem") && !name.ends_with(".pub");
        if is_common_key || is_pem {
            keys.push(name);
        }
    }

    keys.sort();
    Ok(keys)
}

#[derive(Debug, thiserror::Error)]
pub enum SshKeysError {
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for SshKeysError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
