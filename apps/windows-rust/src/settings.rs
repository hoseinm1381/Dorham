use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};

const MAX_SETTINGS: u64 = 12 * 1024 * 1024;
const MAX_PLAINTEXT: usize = 8 * 1024 * 1024;

#[repr(C)]
struct Blob { len: u32, data: *mut u8 }
#[link(name = "crypt32")]
unsafe extern "system" {
    fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob, reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32, output: *mut Blob) -> i32;
    fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob, reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32, output: *mut Blob) -> i32;
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LocalFree(data: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
}

pub fn protect(bytes: &[u8]) -> Result<String, String> {
    let output = crypt(bytes, true)?; Ok(STANDARD.encode(output))
}
pub fn unprotect(encoded: &str) -> Result<Vec<u8>, String> {
    let bytes = STANDARD.decode(encoded).map_err(|_| "Invalid protected data")?; crypt(&bytes, false)
}
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_SETTINGS as usize { return Err("Protected data exceeds limit".into()); }
    let input = Blob { len: bytes.len() as u32, data: bytes.as_ptr() as *mut u8 };
    let mut output = Blob { len: 0, data: std::ptr::null_mut() };
    let success = unsafe {
        if encrypt { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), 1, &mut output) }
        else { CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), 1, &mut output) }
    };
    if success == 0 { return Err("Windows credential protection failed".into()); }
    if output.data.is_null() { return Err("Windows credential protection returned no data".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() };
    unsafe { LocalFree(output.data.cast()); }
    Ok(result)
}

pub fn bounded_json(path: &Path) -> Result<Value, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_SETTINGS { return Err("Settings exceed limit".into()); }
    let mut data = Vec::new(); file.take(MAX_SETTINGS + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_SETTINGS { return Err("Settings exceed limit".into()); }
    serde_json::from_slice(&data).map_err(|_| "Invalid settings JSON".into())
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid settings directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!("settings-{}.tmp", std::process::id()));
    let data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_SETTINGS { return Err("Settings exceed limit".into()); }
    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?; file.sync_all().map_err(|e| e.to_string())?; drop(file);
        let from: Vec<u16> = temporary.to_string_lossy().encode_utf16().chain(Some(0)).collect();
        let to: Vec<u16> = path.to_string_lossy().encode_utf16().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 1 | 8) } == 0 { return Err("Cannot replace settings file".into()); }
        Ok(())
    })();
    if temporary.exists() { let _ = fs::remove_file(temporary); }
    result
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)] pub schema: u32,
    #[serde(default)] pub server: String,
    #[serde(default)] pub secret: Option<String>,
    #[serde(default = "default_overlay")] pub voice_overlay: Value,
    #[serde(default)] pub migration_complete: bool,
    #[serde(default)] pub pending_storage: BTreeMap<String, String>,
}
fn default_overlay() -> Value { json!({"enabled":false,"position":"top-left"}) }
pub fn valid_server(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid server URL")?;
    if !url.username().is_empty() || url.password().is_some() || (url.scheme() != "https" && !(url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))) { return Err("HTTPS is required".into()); }
    Ok(url.origin().ascii_serialization())
}
pub struct SettingsStore { pub path: PathBuf, pub value: Settings }
impl SettingsStore {
    pub fn load(root: &Path, migration: &Path) -> Result<Self, String> {
        let path = root.join("settings.json");
        let value = if path.exists() { serde_json::from_value(bounded_json(&path)?).map_err(|_| "Invalid native settings")? }
                    else { Settings { schema: 1, voice_overlay: default_overlay(), ..Settings::default() } };
        let mut result = Self { path, value };
        if !result.value.migration_complete && migration.exists() { result.import_legacy(migration)?; }
        Ok(result)
    }
    pub fn save(&self) -> Result<(), String> { atomic_json(&self.path, &self.value) }
    pub fn get_secret(&self) -> Result<Option<String>, String> {
        self.value.secret.as_deref().map(|v| unprotect(v).and_then(|bytes| String::from_utf8(bytes).map_err(|_| "Invalid credential".into()))).transpose()
    }
    pub fn set_secret(&mut self, secret: Option<&str>) -> Result<(), String> {
        if secret.is_some_and(|s| s.len() > 32768) { return Err("Credential exceeds limit".into()); }
        let encoded = secret.filter(|s| !s.is_empty()).map(|s| protect(s.as_bytes())).transpose()?;
        let old = std::mem::replace(&mut self.value.secret, encoded);
        if let Err(e) = self.save() { self.value.secret = old; return Err(e); } Ok(())
    }
    fn import_legacy(&mut self, file: &Path) -> Result<(), String> {
        let envelope = bounded_json(file)?;
        if envelope["schema"] != 1 || envelope["appId"] != "com.dorham.chat" { return Err("Unrecognized migration envelope".into()); }
        let encoded = envelope["protectedPayload"].as_str().ok_or("Missing protected migration")?;
        let plaintext = unprotect(encoded)?;
        if plaintext.len() > MAX_PLAINTEXT { return Err("Migration exceeds limit".into()); }
        let payload: Value = serde_json::from_slice(&plaintext).map_err(|_| "Invalid migration data")?;
        if payload["schema"] != 1 || payload["appId"] != "com.dorham.chat" { return Err("Invalid migration identity".into()); }
        let parts: Vec<u32> = payload["sourceVersion"].as_str().unwrap_or("").split('.').map(str::parse).collect::<Result<_,_>>().map_err(|_| "Invalid legacy version")?;
        if parts.len() != 3 || parts.as_slice() > [1,1,0].as_slice() || parts.as_slice() < [0,7,6].as_slice() { return Err("Unsupported legacy migration version".into()); }
        let mut storage = BTreeMap::new();
        for (key, value) in payload["localStorage"].as_object().ok_or("Invalid legacy preferences")? {
            if !(key.starts_with("dorham.") || key.starts_with("dorham-")) || key.len() > 512 { return Err("Unexpected legacy preference".into()); }
            let value = value.as_str().ok_or("Invalid legacy preference value")?;
            if value.len() > 2 * 1024 * 1024 { return Err("Legacy preference exceeds limit".into()); }
            storage.insert(key.clone(), value.to_owned());
        }
        let server = payload["settings"]["server"].as_str().unwrap_or("");
        if !server.is_empty() { self.value.server = valid_server(server)?; }
        self.value.voice_overlay = payload["settings"]["voiceOverlay"].clone();
        self.value.pending_storage = storage;
        let secret = payload["secret"].as_str();
        if secret.is_some_and(|s| s.len() > 32768) { return Err("Invalid legacy credential".into()); }
        self.value.secret = secret.map(|s| protect(s.as_bytes())).transpose()?;
        self.value.migration_complete = true; self.save()?;
        // Keep the independently protected export and old profile as rollback
        // evidence. Refresh-token rotation is handled by the ordinary API.
        Ok(())
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn rejects_untrusted_server() { for s in ["file:///private", "http://example.org", "https://user:pass@host", "javascript:1"] { assert!(valid_server(s).is_err()); } assert_eq!(valid_server("https://dorhamapp.ir/path").unwrap(), "https://dorhamapp.ir"); }
    #[test] fn windows_dpapi_round_trip_and_tampering() { let value = "native migration سلام"; let p = protect(value.as_bytes()).unwrap(); assert_eq!(unprotect(&p).unwrap(), value.as_bytes()); let mut bytes = STANDARD.decode(&p).unwrap(); bytes[20] ^= 1; assert!(unprotect(&STANDARD.encode(bytes)).is_err()); }
}
