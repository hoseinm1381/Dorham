use crate::Host;
use reqwest::{Client, StatusCode, header};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::windows::{fs::OpenOptionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const ORIGIN: &str = "https://dorhamapp.ir";
const CURRENT: &str = env!("CARGO_PKG_VERSION");
const MAX_MANIFEST: usize = 16384;
const MAX_INSTALLER: u64 = 300 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct Status {
    current: &'static str,
    pub latest: String,
    pub available: bool,
    pub phase: &'static str,
    pub progress: u64,
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Release {
    version: String,
    app_id: String,
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    version: String,
    windows: Release,
}

fn version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split('.');
    let mut values = [0; 3];
    for value in &mut values {
        let part = parts.next()?;
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        *value = part.parse().ok()?;
    }
    parts.next().is_none().then_some(values)
}

fn parse_manifest(bytes: &[u8]) -> Result<Release, String> {
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| "Invalid Windows release manifest")?;
    let file = manifest.windows;
    let url = format!(
        "{ORIGIN}/downloads/{0}/Dorham-{0}-Windows-x64.exe",
        file.version
    );
    if manifest.schema != 1
        || version(&file.version).is_none()
        || manifest.version != file.version
        || file.app_id != "com.dorham.chat"
        || file.url != url
        || !(1024..=MAX_INSTALLER).contains(&file.size)
        || file.sha256.len() != 64
        || !file
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Untrusted Windows release manifest".into());
    }
    Ok(file)
}

pub struct Updater {
    client: Client,
    directory: PathBuf,
    candidate: Mutex<Option<Release>>,
    status: Mutex<Status>,
    operation: AtomicBool,
    pause_epoch: AtomicU64,
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Updater {
    pub fn new(directory: PathBuf) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(45))
                .timeout(Duration::from_secs(600))
                .build()?,
            directory,
            candidate: Mutex::new(None),
            status: Mutex::new(Status {
                current: CURRENT,
                latest: CURRENT.into(),
                available: false,
                phase: "idle",
                progress: 0,
            }),
            operation: AtomicBool::new(false),
            pause_epoch: AtomicU64::new(0),
        })
    }

    pub fn state(&self) -> Status {
        self.status.lock().expect("updater state").clone()
    }

    pub fn pause(&self) {
        self.pause_epoch.fetch_add(1, Ordering::AcqRel);
    }

    fn publish(&self, app: &AppHandle, change: impl FnOnce(&mut Status)) -> Status {
        let status = {
            let mut status = self.status.lock().expect("updater state");
            change(&mut status);
            status.clone()
        };
        let _ = app.emit_to("main", "desktop-update-state", &status);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || crate::render_tray(&handle));
        status
    }

    fn path(&self, release: &Release) -> PathBuf {
        self.directory.join(format!(
            "installer-{}-{}.exe",
            release.version, release.sha256
        ))
    }

    async fn latest(&self) -> Result<Release, String> {
        let mut response = self
            .client
            .get(format!("{ORIGIN}/downloads/windows.json"))
            .header(header::CACHE_CONTROL, "no-cache")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "Windows update check unavailable")?;
        if response.status() != StatusCode::OK {
            return Err("Windows update check unavailable".into());
        }
        let mut manifest = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Windows update response interrupted")?
        {
            if manifest.len() + chunk.len() > MAX_MANIFEST {
                return Err("Invalid Windows release manifest".into());
            }
            manifest.extend_from_slice(&chunk);
        }
        parse_manifest(&manifest)
    }

    pub async fn check(&self, app: &AppHandle) -> Result<Status, String> {
        if app.state::<Host>().benchmark {
            return Ok(self.state());
        }
        if self.operation.swap(true, Ordering::AcqRel) {
            return Ok(self.state());
        }
        let _busy = Busy(&self.operation);
        let file = match self.latest().await {
            Ok(file) => file,
            Err(error) => {
                self.publish(app, |state| {
                    if state.phase != "ready" {
                        state.phase = "error";
                    }
                });
                return Err(error);
            }
        };
        let available = version(&file.version) > version(CURRENT);
        let mut candidate = self.candidate.lock().expect("updater candidate");
        let unchanged = candidate.as_ref() == Some(&file);
        *candidate = available.then(|| file.clone());
        drop(candidate);
        Ok(self.publish(app, |state| {
            state.latest = file.version;
            state.available = available;
            if !available || !unchanged || state.phase != "ready" {
                state.phase = if available { "available" } else { "idle" };
                if !unchanged || !available {
                    state.progress = 0;
                }
            }
        }))
    }

    pub async fn prepare(&self, app: &AppHandle) -> Result<PathBuf, String> {
        if app.state::<Host>().benchmark {
            return Err("Windows updates are unavailable in benchmark mode".into());
        }
        let epoch = self.pause_epoch.load(Ordering::Acquire);
        self.outside_call(app, epoch)?;
        if self.operation.swap(true, Ordering::AcqRel) {
            return Err("Dorham is already checking or preparing an update".into());
        }
        let _busy = Busy(&self.operation);
        self.stage(app, epoch).await
    }

    async fn stage(&self, app: &AppHandle, epoch: u64) -> Result<PathBuf, String> {
        let release = self
            .candidate
            .lock()
            .expect("updater candidate")
            .clone()
            .ok_or("No newer Windows update is available")?;
        let installer = self.path(&release);
        let result = self.download(app, &release, &installer, epoch).await;
        self.publish(app, |state| {
            state.phase = if result.is_ok() {
                "ready"
            } else if self.outside_call(app, epoch).is_err() {
                "available"
            } else {
                "error"
            };
            if result.is_ok() {
                state.progress = 100;
            }
        });
        result.map(|_| installer)
    }

    fn outside_call(&self, app: &AppHandle, epoch: u64) -> Result<(), String> {
        if app.state::<Host>().in_call.load(Ordering::Acquire)
            || self.pause_epoch.load(Ordering::Acquire) != epoch
        {
            return Err("Disconnect voice before updating Dorham".into());
        }
        Ok(())
    }

    async fn download(
        &self,
        app: &AppHandle,
        file: &Release,
        installer: &Path,
        epoch: u64,
    ) -> Result<(), String> {
        if verified(installer, file).is_ok() {
            return self.outside_call(app, epoch);
        }
        fs::create_dir_all(&self.directory)
            .map_err(|_| "Could not create the Windows update cache")?;
        let partial = installer.with_extension("exe.download");
        let offset = match partial.symlink_metadata() {
            Ok(metadata) if metadata.is_file() && metadata.len() <= file.size => metadata.len(),
            Ok(_) => {
                fs::remove_file(&partial)
                    .map_err(|_| "Could not remove invalid Windows update data")?;
                0
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
            Err(_) => return Err("Could not read the Windows update cache".into()),
        };
        if offset != file.size {
            self.transfer(app, file, &partial, offset, epoch).await?;
        }
        self.outside_call(app, epoch)?;
        if verified(&partial, file).is_err() {
            let _ = fs::remove_file(&partial);
            return Err("Windows update verification failed".into());
        }
        self.outside_call(app, epoch)?;
        fs::rename(&partial, installer)
            .map_err(|_| "Could not stage the verified Windows update".into())
    }

    async fn transfer(
        &self,
        app: &AppHandle,
        file: &Release,
        partial: &Path,
        offset: u64,
        epoch: u64,
    ) -> Result<(), String> {
        let mut request = self
            .client
            .get(&file.url)
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(header::RANGE, format!("bytes={offset}-"));
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Windows update download unavailable")?;
        let append = response.status() == StatusCode::PARTIAL_CONTENT;
        let expected_range = format!("bytes {}-{}/{}", offset, file.size - 1, file.size);
        let mut size = if append { offset } else { 0 };
        if (response.status() != StatusCode::OK && !append)
            || (append
                && (offset == 0
                    || response
                        .headers()
                        .get(header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        != Some(expected_range.as_str())))
            || response
                .content_length()
                .is_some_and(|length| length != file.size - size)
        {
            return Err("Unexpected Windows update range or size".into());
        }
        self.outside_call(app, epoch)?;
        let mut output = OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(partial)
            .map_err(|_| "Could not save the Windows update")?;
        let mut previous = size * 100 / file.size;
        self.publish(app, |state| {
            state.phase = "downloading";
            state.progress = previous.min(99);
        });
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Windows update download interrupted; retry to resume")?
        {
            self.outside_call(app, epoch)?;
            size += chunk.len() as u64;
            if size > file.size {
                return Err("Windows update exceeded its advertised size".into());
            }
            output
                .write_all(&chunk)
                .map_err(|_| "Could not save the Windows update")?;
            let progress = (size * 100 / file.size).min(99);
            if progress != previous {
                self.publish(app, |state| state.progress = progress);
                previous = progress;
            }
        }
        if size != file.size {
            return Err("Windows update download interrupted; retry to resume".into());
        }
        output
            .sync_all()
            .map_err(|_| "Could not flush the Windows update".into())
    }

    pub async fn install(&self, app: &AppHandle) -> Result<(), String> {
        if app.state::<Host>().benchmark {
            return Err("Windows updates are unavailable in benchmark mode".into());
        }
        let epoch = self.pause_epoch.load(Ordering::Acquire);
        self.outside_call(app, epoch)?;
        if self.operation.swap(true, Ordering::AcqRel) {
            return Err("Dorham is already updating".into());
        }
        let lock = Busy(&self.operation);
        let installer = self.stage(app, epoch).await?;
        let release = self
            .candidate
            .lock()
            .expect("updater candidate")
            .clone()
            .ok_or("No Windows update available")?;
        let _read_lock =
            verified(&installer, &release).map_err(|_| "Windows update verification failed")?;
        self.outside_call(app, epoch)?;
        Command::new(&installer)
            .args(["/S", "--updated", "--force-run"])
            .creation_flags(0x08000008)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start the verified Windows installer")?;
        self.publish(app, |state| state.phase = "installing");
        std::mem::forget(lock);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(750));
            app.exit(0);
        });
        Ok(())
    }
}

fn verified(path: &Path, release: &Release) -> io::Result<File> {
    let metadata = path.symlink_metadata()?;
    if !metadata.is_file() || metadata.len() != release.size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid installer size",
        ));
    }
    // Allow the image loader to read the executable while blocking replacement.
    let mut file = OpenOptions::new().read(true).share_mode(1).open(path)?;
    let mut digest = Sha256::new();
    let mut count = 0;
    let mut chunk = [0; 65536];
    loop {
        let length = file.read(&mut chunk)?;
        if length == 0 {
            break;
        }
        count += length as u64;
        if count > release.size {
            break;
        }
        digest.update(&chunk[..length]);
    }
    if count != release.size || format!("{:x}", digest.finalize()) != release.sha256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid installer checksum",
        ));
    }
    Ok(file)
}

pub fn schedule(app: &AppHandle, check: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let host = app.state::<Host>();
        if check {
            let _ = host.updater.check(&app).await;
        }
        if !host.in_call.load(Ordering::Acquire)
            && host.updater.state().available
            && host.updater.state().phase != "ready"
        {
            let _ = host.updater.prepare(&app).await;
        }
    });
}

#[tauri::command]
pub async fn update_check(window: tauri::WebviewWindow) -> Result<Status, String> {
    crate::require_main(&window)?;
    let state = window
        .state::<Host>()
        .updater
        .check(window.app_handle())
        .await?;
    schedule(window.app_handle(), false);
    Ok(state)
}

#[tauri::command]
pub async fn update_prepare(window: tauri::WebviewWindow) -> Result<(), String> {
    crate::require_main(&window)?;
    window
        .state::<Host>()
        .updater
        .prepare(window.app_handle())
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn update_install(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    crate::require_main(&window)?;
    window
        .state::<Host>()
        .updater
        .install(window.app_handle())
        .await?;
    Ok(serde_json::json!({ "started": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn windows_feed_requires_exact_artifact_identity() {
        let manifest = json!({ "schema": 1, "version": "1.3.1", "windows": {
            "version": "1.3.1", "appId": "com.dorham.chat", "size": 4500, "sha256": "a".repeat(64),
            "url": format!("{ORIGIN}/downloads/1.3.1/Dorham-1.3.1-Windows-x64.exe")
        }});
        assert!(parse_manifest(&serde_json::to_vec(&manifest).unwrap()).is_ok());
        for (key, value) in [
            (
                "url",
                json!("https://example.invalid/downloads/1.3.1/Dorham-1.3.1-Windows-x64.exe"),
            ),
            ("appId", json!("com.dorham.other")),
            ("size", json!(MAX_INSTALLER + 1)),
            ("sha256", json!("A".repeat(64))),
            ("version", json!("1.3.01")),
        ] {
            let mut malformed = manifest.clone();
            malformed["windows"][key] = value;
            assert!(parse_manifest(&serde_json::to_vec(&malformed).unwrap()).is_err());
        }
    }
}
