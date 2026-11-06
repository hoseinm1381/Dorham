use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::PathBuf, process::{Command, Stdio}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use std::os::windows::process::CommandExt;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const ORIGIN: &str = "https://dorhamapp.ir";
const MAX_INSTALLER: u64 = 300 * 1024 * 1024;
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReleaseFile { pub version: String, pub url: String, pub sha256: String, pub size: u64, #[serde(rename="appId")] pub app_id: String }
#[derive(Deserialize)] struct Manifest { schema: u32, version: String, windows: ReleaseFile }
fn version(value: &str) -> Option<[u64; 3]> {
    let p = value.split('.').collect::<Vec<_>>();
    if p.len() != 3 || p.iter().any(|s| s.is_empty() || s.len()>16 || (s.starts_with('0') && s.len()!=1) || !s.bytes().all(|c|c.is_ascii_digit())) { return None; }
    Some([p[0].parse().ok()?, p[1].parse().ok()?, p[2].parse().ok()?])
}
pub fn newer(candidate: &str, current: &str) -> bool { match (version(candidate),version(current)) { (Some(a),Some(b))=>a>b,_=>false } }
pub fn validate_manifest(data: &[u8]) -> Result<ReleaseFile, String> {
    if data.len()>16384 { return Err("Invalid update response".into()); }
    let m: Manifest=serde_json::from_slice(data).map_err(|_|"Invalid release manifest")?;
    let f=m.windows;
    if m.schema!=1 || version(&m.version).is_none() || f.version!=m.version || f.app_id!="com.dorham.chat" || f.size<1024 || f.size>MAX_INSTALLER || f.sha256.len()!=64 || !f.sha256.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)) || f.url!=format!("{ORIGIN}/downloads/{}/Dorham-{}-Windows-x64.exe",f.version,f.version) { return Err("Untrusted release manifest".into()); }
    Ok(f)
}
#[derive(Clone)]
pub struct Updater { directory: PathBuf, busy: Arc<AtomicBool>, in_call: Arc<AtomicBool> }
struct Busy(Arc<AtomicBool>);
impl Drop for Busy { fn drop(&mut self) { self.0.store(false,Ordering::Release); } }
impl Updater {
    pub fn new(directory: PathBuf, in_call: Arc<AtomicBool>) -> Self { Self { directory,busy:Arc::new(AtomicBool::new(false)),in_call } }
    fn client(timeout: u64) -> Result<reqwest::blocking::Client,String> { reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(timeout)).build().map_err(|_|"Update network unavailable".into()) }
    pub fn latest(&self) -> Result<ReleaseFile,String> {
        let response=Self::client(15)?.get(format!("{ORIGIN}/downloads/windows.json")).header("Cache-Control","no-cache").send().map_err(|_|"Update check unavailable")?;
        if !response.status().is_success() || response.content_length().is_some_and(|v|v>16384) { return Err("Invalid update response".into()); }
        let mut data=Vec::new();response.take(16385).read_to_end(&mut data).map_err(|_|"Update response unavailable")?;
        validate_manifest(&data)
    }
    pub fn check(&self) -> Result<Value,String> { let f=self.latest()?;Ok(json!({"current":VERSION,"latest":f.version,"available":newer(&f.version,VERSION)})) }
    pub fn install(&self) -> Result<Value,String> {
        if self.in_call.load(Ordering::Acquire) { return Err("Disconnect voice before installing an update.".into()); }
        if self.busy.swap(true,Ordering::AcqRel) { return Err("An update is already downloading".into()); }
        let _busy=Busy(self.busy.clone());let f=self.latest()?;
        if !newer(&f.version,VERSION) { return Err("This app is already up to date".into()); }
        fs::create_dir_all(&self.directory).map_err(|_|"Cannot create update directory")?;
        let partial=self.directory.join("installer.exe.download");let installer=self.directory.join("installer.exe");
        if partial.exists() { fs::remove_file(&partial).map_err(|_|"Cannot replace partial update")?; }
        let result=(|| {
            let mut response=Self::client(600)?.get(&f.url).send().map_err(|_|"Update download unavailable")?;
            if !response.status().is_success() || response.content_length()!=Some(f.size) { return Err("Invalid update size".into()); }
            let mut output=OpenOptions::new().write(true).create_new(true).open(&partial).map_err(|_|"Cannot save update")?;
            let mut digest=Sha256::new();let mut total=0u64;let mut buffer=[0u8;65536];
            loop { let n=response.read(&mut buffer).map_err(|_|"Update download interrupted")?;if n==0 { break; }total+=n as u64;if total>f.size { return Err("Invalid update size".into()); }digest.update(&buffer[..n]);output.write_all(&buffer[..n]).map_err(|_|"Cannot save update")?; }
            if total!=f.size || format!("{:x}",digest.finalize())!=f.sha256 { return Err("Update verification failed".into()); }
            output.sync_all().map_err(|_|"Cannot save update")?;drop(output);
            if self.in_call.load(Ordering::Acquire) { return Err("Disconnect voice before installing an update.".into()); }
            if installer.exists() { fs::remove_file(&installer).map_err(|_|"Cannot replace previous installer")?; }
            fs::rename(&partial,&installer).map_err(|_|"Cannot prepare installer")?;
            Command::new(installer).arg("--updated").creation_flags(0x00000008|0x00000200).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"Cannot start installer")?;
            Ok(json!({"started":true}))
        })();
        if partial.exists() { let _=fs::remove_file(partial); }result
    }
}
#[cfg(test)]mod tests {
    use super::*;
    #[test]fn version_order_is_strict(){assert!(newer("1.1.1","1.1.0"));assert!(!newer("1.1.1","1.1.1"));for x in ["01.1.1","1.1.1.0","v1.1.1","1.1.-1","1.1.99999999999999999999999"]{assert!(!newer(x,"1.1.0"));}}
    #[test]fn rejects_url_and_identity_substitution(){let base=json!({"schema":1,"version":"1.1.1","windows":{"version":"1.1.1","appId":"com.dorham.chat","url":"https://dorhamapp.ir/downloads/1.1.1/Dorham-1.1.1-Windows-x64.exe","size":4096,"sha256":"a".repeat(64)}});assert!(validate_manifest(&serde_json::to_vec(&base).unwrap()).is_ok());for(k,v)in [("url",json!("https://evil.invalid/i.exe")),("appId",json!("wrong")),("sha256",json!("A".repeat(64))),("size",json!(MAX_INSTALLER+1))]{let mut bad=base.clone();bad["windows"][k]=v;assert!(validate_manifest(&serde_json::to_vec(&bad).unwrap()).is_err());}}
}
