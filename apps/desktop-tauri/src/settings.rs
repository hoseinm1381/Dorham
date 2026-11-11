use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use url::Url;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};
use windows_core::PCWSTR;

const APP_ID: &str = "com.dorham.chat";
const MAX_PLAINTEXT: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT: usize = 12 * 1024 * 1024;
const MAX_SECRET: usize = 32768;

fn crypt(input: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    if input.is_empty() || input.len() > MAX_DOCUMENT {
        return Err("Invalid credential protection input".into());
    }
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        if protect {
            CryptProtectData(
                &source,
                PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
        .map_err(|_| "Windows credential protection failed")?;
        if output.pbData.is_null() {
            return Err("Windows credential protection returned no data".into());
        }
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = bytes.to_vec();
        if !protect {
            for byte in bytes {
                std::ptr::write_volatile(byte, 0);
            }
        }
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}

fn protect(data: &str) -> Result<String, String> {
    crypt(data.as_bytes(), true).map(|value| STANDARD.encode(value))
}

fn decrypt(data: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid protected data")?;
    crypt(&bytes, false)
}

fn read_json<T: DeserializeOwned>(file: File) -> Result<T, String> {
    let mut bytes = Vec::new();
    file.take((MAX_DOCUMENT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read Dorham settings")?;
    if bytes.len() > MAX_DOCUMENT {
        return Err("Dorham settings exceed the supported size".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Dorham settings document".into())
}

pub fn server_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Invalid server URL")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() != "https" && !(loopback && url.scheme() == "http"))
    {
        return Err("HTTPS is required for the Dorham server".into());
    }
    Ok(url.origin().ascii_serialization())
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OverlayPosition {
    #[default]
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OverlayPreferences {
    pub enabled: bool,
    pub position: OverlayPosition,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub server: String,
    secret: Option<String>,
    pub voice_overlay: OverlayPreferences,
    migrated: bool,
}

impl Settings {
    pub fn get_secret(&self) -> Result<Option<String>, String> {
        self.secret
            .as_deref()
            .map(|value| {
                String::from_utf8(decrypt(value)?).map_err(|_| "Invalid stored credential".into())
            })
            .transpose()
    }

    pub fn set_secret(&mut self, secret: Option<&str>) -> Result<(), String> {
        if secret.is_some_and(|value| value.len() > MAX_SECRET) {
            return Err("Credential exceeds the supported size".into());
        }
        self.secret = secret
            .filter(|value| !value.is_empty())
            .map(protect)
            .transpose()?;
        Ok(())
    }
}

pub struct Store {
    file: PathBuf,
    pub value: Settings,
    legacy: Option<LegacyPayload>,
}

impl Store {
    pub fn load(root: &Path, migration_file: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|_| "Could not create the Dorham profile")?;
        let file = root.join("settings.json");
        let value: Settings = match File::open(&file) {
            Ok(file) => read_json(file)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(_) => return Err("Could not open Dorham settings".into()),
        };
        let legacy = if !value.migrated && migration_file.exists() {
            Some(validate_legacy(migration_file)?)
        } else {
            None
        };
        Ok(Self {
            file,
            value,
            legacy,
        })
    }

    pub fn change(
        &mut self,
        change: impl FnOnce(&mut Settings) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut next = self.value.clone();
        change(&mut next)?;
        let data = serde_json::to_vec(&next).map_err(|_| "Could not encode Dorham settings")?;
        let temporary = self.file.with_extension("json.tmp");
        {
            let mut file =
                File::create(&temporary).map_err(|_| "Could not save Dorham settings")?;
            file.write_all(&data)
                .and_then(|_| file.sync_all())
                .map_err(|_| "Could not save Dorham settings")?;
        }
        fs::rename(temporary, &self.file).map_err(|_| "Could not replace Dorham settings")?;
        self.value = next;
        Ok(())
    }

    pub fn pending_storage(&self) -> Option<&BTreeMap<String, String>> {
        self.legacy.as_ref().map(|legacy| &legacy.local_storage)
    }

    pub fn finish_migration(&mut self) -> Result<(), String> {
        let Some(legacy) = self.legacy.take() else {
            return Ok(());
        };
        let result = self.change(|settings| {
            settings.server.clone_from(&legacy.settings.server);
            settings.voice_overlay = legacy.settings.voice_overlay;
            settings.set_secret(legacy.secret.as_deref())?;
            settings.migrated = true;
            Ok(())
        });
        if result.is_err() {
            self.legacy = Some(legacy);
        }
        result
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    schema: u32,
    app_id: String,
    protected_payload: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPayload {
    schema: u32,
    app_id: String,
    source_version: String,
    settings: Settings,
    secret: Option<String>,
    local_storage: BTreeMap<String, String>,
}

pub fn validate_legacy(path: &Path) -> Result<LegacyPayload, String> {
    let envelope: Envelope =
        read_json(File::open(path).map_err(|_| "Could not open the protected Electron export")?)?;
    if envelope.schema != 1 || envelope.app_id != APP_ID {
        return Err("Invalid Electron export identity".into());
    }
    let mut plaintext = decrypt(&envelope.protected_payload)?;
    let parsed = if plaintext.len() <= MAX_PLAINTEXT {
        serde_json::from_slice::<LegacyPayload>(&plaintext)
            .map_err(|_| "Invalid Electron migration document")
    } else {
        Err("Electron migration document exceeds the supported size")
    };
    plaintext.fill(0);
    let mut payload = parsed?;
    let version: Vec<_> = payload
        .source_version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<_, _>>()
        .map_err(|_| "Invalid Electron version")?;
    if payload.schema != 1
        || payload.app_id != APP_ID
        || version.len() != 3
        || version.as_slice() >= [1, 3, 0].as_slice()
        || payload
            .secret
            .as_ref()
            .is_some_and(|value| value.len() > MAX_SECRET)
    {
        return Err("Unsupported Electron migration document".into());
    }
    if !payload.settings.server.is_empty() {
        payload.settings.server = server_origin(&payload.settings.server)?;
    }
    for (key, value) in &payload.local_storage {
        if !(key.starts_with("dorham.") || key.starts_with("dorham-"))
            || key.len() > 512
            || value.len() > 2 * 1024 * 1024
        {
            return Err("Invalid Electron preference".into());
        }
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_configuration_enforces_secure_or_loopback_origins() {
        assert_eq!(
            server_origin("https://dorhamapp.ir/folder").unwrap(),
            "https://dorhamapp.ir"
        );
        assert_eq!(
            server_origin("http://127.0.0.1:3434").unwrap(),
            "http://127.0.0.1:3434"
        );
        for value in [
            "https://user:pass@dorhamapp.ir",
            "http://localhost.example",
            "file:///Dorham",
            "https://",
        ] {
            assert!(server_origin(value).is_err());
        }
    }

    #[test]
    fn credential_is_protected_for_the_windows_user() {
        let secret = "owned-fixture-سرور";
        let encrypted = protect(secret).unwrap();
        assert_ne!(encrypted, secret);
        assert_eq!(decrypt(&encrypted).unwrap(), secret.as_bytes());
    }
}
