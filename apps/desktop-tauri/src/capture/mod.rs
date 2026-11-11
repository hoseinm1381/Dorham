mod audio;
mod preview;
mod sources;

use crate::{Host, assets, overlay, trusted_main_url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sources::{Kind, Source};
use std::io::{self, Read};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windows_core::w;
use windows_version::OsVersion;

const PICKER: &str = "capture-picker";
const DOCUMENT: &str = "https://localhost/capture-picker.html";
const NO_CONSOLE: u32 = 0x08000000;
const BRIDGE: &str = r#"
if (location.href === "https://localhost/capture-picker.html" && window.top === window) {
  Object.defineProperty(window, "capturePicker", { value: Object.freeze({
    model: () => window.__TAURI_INTERNALS__.invoke("capture_picker_model"),
    thumbnail: id => window.__TAURI_INTERNALS__.invoke("capture_picker_thumbnail", { id }),
    restore: id => window.__TAURI_INTERNALS__.invoke("capture_picker_restore", { id }),
    choose: choice => window.__TAURI_INTERNALS__.invoke("capture_picker_select", { choice })
  }) });
}
"#;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum AudioScope {
    None,
    Application,
    System,
}

#[derive(Deserialize)]
pub struct Settings {
    width: u32,
    height: u32,
    fps: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    id: String,
    audio_scope: AudioScope,
}

struct Selection {
    source: Source,
    audio_scope: AudioScope,
}

struct Picker {
    generation: u64,
    sources: Vec<Source>,
    audio: bool,
    result: Option<mpsc::SyncSender<Option<Selection>>>,
    preview_stopped: Arc<AtomicBool>,
    preview_pending: bool,
}

impl Drop for Picker {
    fn drop(&mut self) {
        self.preview_stopped.store(true, Ordering::Release);
    }
}

type LatestFrame = Arc<Mutex<Option<Vec<u8>>>>;

struct Video {
    id: u64,
    helper: Child,
    latest: LatestFrame,
    stopped: Arc<AtomicBool>,
    selection: Selection,
    granted: Instant,
    audio_used: bool,
}

impl Drop for Video {
    fn drop(&mut self) {
        let _ = self.helper.kill();
        let _ = self.helper.wait();
    }
}

pub struct Capture {
    binary: PathBuf,
    audio_binary: PathBuf,
    generation: u64,
    picker: Option<Picker>,
    video: Option<Video>,
    audio: Option<audio::Audio>,
}

impl Capture {
    pub fn new(root: &Path) -> Self {
        Self {
            binary: root.join("native/CaptureVideo.exe"),
            audio_binary: root.join("native/ShareAudio.exe"),
            generation: 0,
            picker: None,
            video: None,
            audio: None,
        }
    }

    pub fn stop(&mut self) {
        self.generation += 1;
        if let Some(result) = self
            .picker
            .take()
            .and_then(|mut picker| picker.result.take())
        {
            let _ = result.try_send(None);
        }
        self.audio = None;
        self.video = None;
    }

    fn supported(&self) -> bool {
        OsVersion::current().build >= 18362 && self.binary.is_file()
    }

    pub fn shared_audio(&self) -> bool {
        OsVersion::current().build >= 20348 && self.audio_binary.is_file()
    }

    pub fn picker_open(&self) -> bool {
        self.picker
            .as_ref()
            .is_some_and(|picker| picker.result.is_some())
    }
}

fn allowed(host: &Host) -> bool {
    host.in_call.load(Ordering::Acquire)
        && !host.locked.load(Ordering::Acquire)
        && !host.suspended.load(Ordering::Acquire)
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" && window.url().is_ok_and(|url| trusted_main_url(&url)) {
        Ok(())
    } else {
        Err("Untrusted screen capture requester".into())
    }
}

fn picker_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == PICKER && window.url().is_ok_and(|url| url.as_str() == DOCUMENT) {
        Ok(())
    } else {
        Err("Untrusted screen capture picker".into())
    }
}

fn close_picker(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(PICKER) {
        let _ = window.destroy();
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_enabled(true);
    }
    let _ = overlay::request_sync(app);
}

pub fn stop_all(app: &AppHandle) {
    if let Ok(mut capture) = app.state::<Host>().capture.lock() {
        capture.stop();
    }
    assets::clear_shared_video(None);
    close_picker(app);
}

fn open_picker(app: &AppHandle, generation: u64) -> Result<(), Box<dyn std::error::Error>> {
    let host = app.state::<Host>();
    let pending = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?
        .picker
        .as_ref()
        .is_some_and(|picker| picker.generation == generation && picker.result.is_some());
    if !pending || !allowed(&host) {
        return Ok(());
    }
    let _ = overlay::request_sync(app);
    let main = app
        .get_webview_window("main")
        .ok_or("Missing screen-sharing window")?;
    let window = WebviewWindowBuilder::new(
        app,
        PICKER,
        WebviewUrl::External(url::Url::parse("about:blank")?),
    )
    .title(if host.persian.load(Ordering::Acquire) {
        "انتخاب منبع اشتراک‌گذاری"
    } else {
        "Choose what to share"
    })
    .inner_size(920.0, 690.0)
    .min_inner_size(640.0, 480.0)
    .parent(&main)?
    .data_directory(host.profile.join("WebView2"))
    .use_https_scheme(true)
    .visible(false)
    .initialization_script(BRIDGE)
    .on_navigation(|url| matches!(url.as_str(), "about:blank" | DOCUMENT))
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(|window, page| {
        if page.url().as_str() == DOCUMENT
            && page.event() == tauri::webview::PageLoadEvent::Finished
        {
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
    .build()?;
    main.set_enabled(false)?;
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut capture) = app_handle.state::<Host>().capture.lock() {
                if capture.picker.as_ref().is_some_and(|picker| {
                    picker.generation == generation && picker.result.is_some()
                }) {
                    capture.stop();
                }
            }
            if let Some(main) = app_handle.get_webview_window("main") {
                let _ = main.set_enabled(true);
            }
            let _ = overlay::request_sync(&app_handle);
        }
    });
    let app = app.clone();
    window.with_webview(move |view| unsafe {
        if let Ok(core) = view.controller().CoreWebView2() {
            if assets::serve(&core, app.clone(), false)
                .and_then(|_| core.Navigate(w!("https://localhost/capture-picker.html")))
                .is_ok()
            {
                return;
            }
        }
        stop_all(&app);
    })?;
    Ok(())
}

#[tauri::command]
pub fn capture_picker_model(window: WebviewWindow) -> Result<Value, String> {
    picker_window(&window)?;
    let host = window.state::<Host>();
    let mut capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    let audio_supported = capture.shared_audio();
    let picker = capture
        .picker
        .as_mut()
        .filter(|picker| allowed(&host) && picker.result.is_some())
        .ok_or("Screen sharing was cancelled")?;
    picker.sources = sources::enumerate();
    Ok(json!({
        "sources": picker.sources,
        "language": if host.persian.load(Ordering::Acquire) { "fa-IR" } else { "en-US" },
        "audioRequested": picker.audio,
        "audioSupported": audio_supported,
    }))
}

#[tauri::command]
pub async fn capture_picker_thumbnail(
    window: WebviewWindow,
    id: String,
) -> Result<Option<String>, String> {
    picker_window(&window)?;
    let host = window.state::<Host>();
    let (source, binary, generation, stopped) = {
        let mut capture = host
            .capture
            .lock()
            .map_err(|_| "Screen capture unavailable")?;
        let binary = capture.binary.clone();
        let picker = capture
            .picker
            .as_mut()
            .filter(|picker| allowed(&host) && picker.result.is_some() && !picker.preview_pending)
            .ok_or("Screen preview unavailable")?;
        let source = picker
            .sources
            .iter()
            .find(|source| source.id == id)
            .ok_or("Unknown capture source")?
            .clone();
        if source.minimized {
            return Ok(None);
        }
        picker.preview_pending = true;
        (source, binary, picker.generation, picker.preview_stopped.clone())
    };
    let thumbnail = tauri::async_runtime::spawn_blocking(move || {
        preview::capture(&binary, &source, &stopped)
    })
    .await
    .ok()
    .flatten();
    let mut capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    let Some(picker) = capture
        .picker
        .as_mut()
        .filter(|picker| picker.generation == generation)
    else {
        return Ok(None);
    };
    picker.preview_pending = false;
    Ok(thumbnail.filter(|_| allowed(&host) && picker.result.is_some()))
}

#[tauri::command]
pub async fn capture_picker_restore(window: WebviewWindow, id: String) -> Result<(), String> {
    picker_window(&window)?;
    let host = window.state::<Host>();
    let source = {
        let capture = host
            .capture
            .lock()
            .map_err(|_| "Screen capture unavailable")?;
        let previous = capture
            .picker
            .as_ref()
            .filter(|picker| allowed(&host) && picker.result.is_some())
            .and_then(|picker| {
                picker.sources.iter().find(|source| source.id == id && source.minimized)
            })
            .ok_or("Unknown minimized window")?;
        sources::enumerate()
            .into_iter()
            .find(|source| source.same_source(previous) && source.restore())
            .ok_or("Windows could not restore this application")?
    };
    let restored = tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(1);
        while source.is_minimized() {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(25));
        }
        true
    })
    .await
    .unwrap_or(false);
    if !restored {
        return Err("Windows could not restore this application".into());
    }
    Ok(())
}

#[tauri::command]
pub fn capture_picker_select(window: WebviewWindow, choice: Choice) -> Result<(), String> {
    picker_window(&window)?;
    let host = window.state::<Host>();
    let mut capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    let picker = capture
        .picker
        .as_ref()
        .filter(|picker| allowed(&host) && picker.result.is_some())
        .ok_or("Screen sharing was cancelled")?;
    let selection = if choice.id.is_empty() {
        None
    } else {
        if choice.audio_scope != AudioScope::None && (!picker.audio || !capture.shared_audio()) {
            return Err("Scoped Windows audio capture is unavailable".into());
        }
        let previous = picker
            .sources
            .iter()
            .find(|source| source.id == choice.id)
            .ok_or("Unknown capture source")?;
        let fresh = sources::enumerate()
            .into_iter()
            .find(|source| source.same_source(previous))
            .ok_or("Capture source closed. Refresh and choose again.")?;
        if fresh.minimized {
            return Err("Restore the window before sharing".into());
        }
        if choice.audio_scope == AudioScope::Application && fresh.kind != Kind::Window {
            return Err("Choose a window for application audio".into());
        }
        Some(Selection {
            source: fresh,
            audio_scope: choice.audio_scope,
        })
    };
    let picker = capture
        .picker
        .as_mut()
        .ok_or("Screen sharing was cancelled")?;
    picker.preview_stopped.store(true, Ordering::Release);
    let result = picker.result.take().ok_or("Screen sharing was cancelled")?;
    result
        .try_send(selection)
        .map_err(|_| "Screen sharing was cancelled")?;
    drop(capture);
    close_picker(window.app_handle());
    Ok(())
}

#[tauri::command]
pub async fn capture_video(
    window: WebviewWindow,
    settings: Settings,
    audio: bool,
) -> Result<Option<Value>, String> {
    main_window(&window)?;
    if !(1..=3840).contains(&settings.width)
        || !(1..=2160).contains(&settings.height)
        || !(1..=60).contains(&settings.fps)
    {
        return Err("Invalid capture size or frame rate".into());
    }
    let host = window.state::<Host>();
    let (sender, receiver) = mpsc::sync_channel(1);
    let generation = {
        let mut capture = host
            .capture
            .lock()
            .map_err(|_| "Screen capture unavailable")?;
        if !allowed(&host)
            || !capture.supported()
            || capture.picker.is_some()
            || capture.video.is_some()
        {
            return Err("Join a voice call and close any other screen share first.".into());
        }
        capture.generation += 1;
        let generation = capture.generation;
        capture.picker = Some(Picker {
            generation,
            sources: Vec::new(),
            audio,
            result: Some(sender),
            preview_stopped: Arc::new(AtomicBool::new(false)),
            preview_pending: false,
        });
        generation
    };
    let app = window.app_handle().clone();
    window
        .run_on_main_thread(move || {
            if open_picker(&app, generation).is_err() {
                stop_all(&app);
            }
        })
        .map_err(|_| "Could not open the screen sharing picker")?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(Duration::from_secs(120))
    })
    .await
    .map_err(|_| "Screen sharing was cancelled")?;
    let selected = match selected {
        Ok(Some(selection)) => selection,
        Ok(None) => {
            let mut capture = host
                .capture
                .lock()
                .map_err(|_| "Screen capture unavailable")?;
            if capture.generation == generation {
                capture.picker.take();
            }
            return Ok(None);
        }
        Err(_) => {
            let app = window.app_handle().clone();
            let _ = window.run_on_main_thread(move || {
                let current = app
                    .state::<Host>()
                    .capture
                    .lock()
                    .is_ok_and(|capture| capture.generation == generation);
                if current {
                    stop_all(&app);
                }
            });
            return Ok(None);
        }
    };
    let mut capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    if capture.generation != generation || !allowed(&host) {
        return Ok(None);
    }
    capture.picker.take();
    let mut helper = start_video_helper(&capture.binary, &selected.source, &settings, false)
        .map_err(|_| "Windows could not start screen capture")?;
    let stdout = helper.stdout.take().expect("piped capture output");
    let latest = Arc::new(Mutex::new(None));
    let stopped = Arc::new(AtomicBool::new(false));
    let output = latest.clone();
    let failed = stopped.clone();
    thread::spawn(move || {
        let _ = read_frames(stdout, output, settings);
        failed.store(true, Ordering::Release);
    });
    let result = json!({
        "id": generation, "sourceName": selected.source.name,
        "audioScope": selected.audio_scope,
        "surface": if selected.source.kind == Kind::Window { "window" } else { "monitor" },
    });
    capture.video = Some(Video {
        id: generation,
        helper,
        latest,
        stopped,
        selection: selected,
        granted: Instant::now(),
        audio_used: false,
    });
    Ok(Some(result))
}

fn start_video_helper(
    binary: &Path,
    source: &Source,
    settings: &Settings,
    thumbnail: bool,
) -> io::Result<Child> {
    let mut command = Command::new(binary);
    command
        .args([
            (if source.kind == Kind::Window {
                "window"
            } else {
                "monitor"
            })
            .into(),
            source.handle.to_string(),
            source.pid.to_string(),
            std::process::id().to_string(),
            settings.width.to_string(),
            settings.height.to_string(),
            settings.fps.to_string(),
        ])
        .creation_flags(NO_CONSOLE)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if thumbnail {
        command.arg("thumbnail");
    }
    command.spawn()
}

fn read_frames(mut source: impl Read, latest: LatestFrame, settings: Settings) -> io::Result<()> {
    loop {
        let (buffer, _, _) = read_frame(&mut source, &settings)?;
        if let Ok(mut latest) = latest.lock() {
            *latest = Some(buffer);
        }
    }
}

fn read_frame(source: &mut impl Read, settings: &Settings) -> io::Result<(Vec<u8>, u32, u32)> {
    let mut header = [0; 8];
    source.read_exact(&mut header)?;
    let width = u32::from_le_bytes(header[..4].try_into().expect("frame width"));
    let height = u32::from_le_bytes(header[4..].try_into().expect("frame height"));
    if !(1..=settings.width).contains(&width) || !(1..=settings.height).contains(&height) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid Windows capture frame",
        ));
    }
    let mut buffer = vec![0; 8 + (width * height * 4) as usize];
    buffer[..8].copy_from_slice(&header);
    source.read_exact(&mut buffer[8..])?;
    Ok((buffer, width, height))
}

pub fn video_frame(app: &AppHandle, id: u64) -> Result<Vec<u8>, String> {
    let host = app.state::<Host>();
    let capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    let video = capture
        .video
        .as_ref()
        .filter(|video| allowed(&host) && video.id == id)
        .ok_or("Screen sharing stopped")?;
    if video.stopped.load(Ordering::Acquire) {
        return Err("Windows stopped capturing this source. Choose it again to retry.".into());
    }
    let buffer = video
        .latest
        .lock()
        .map_err(|_| "Windows capture frame unavailable")?
        .take()
        .unwrap_or_default();
    Ok(buffer)
}

#[tauri::command]
pub fn capture_stop(window: WebviewWindow, id: u64) -> Result<(), String> {
    main_window(&window)?;
    let mut capture = window
        .state::<Host>()
        .inner()
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    if capture.video.as_ref().is_some_and(|video| video.id == id) {
        capture.stop();
        assets::clear_shared_video(Some(id));
    }
    Ok(())
}

#[tauri::command]
pub async fn capture_audio_start(window: WebviewWindow) -> Result<Value, String> {
    main_window(&window)?;
    let host = window.state::<Host>();
    let (id, selection, ready) = {
        let mut capture = host
            .capture
            .lock()
            .map_err(|_| "Screen capture unavailable")?;
        if !allowed(&host) || !capture.shared_audio() || capture.audio.is_some() {
            return Err("Application audio is unavailable for this session".into());
        }
        let binary = capture.audio_binary.clone();
        let video = capture
            .video
            .as_mut()
            .filter(|video| {
                !video.audio_used
                    && !video.stopped.load(Ordering::Acquire)
                    && video.granted.elapsed() < Duration::from_secs(30)
            })
            .ok_or("Choose a screen or application with sound first")?;
        video.audio_used = true;
        let (audio, ready) = audio::Audio::start(
            &binary,
            &video.selection,
            host.browser_process.load(Ordering::Acquire),
        )?;
        let id = video.id;
        let selection = json!({
            "id": id.to_string(), "sourceName": video.selection.source.name, "audioScope": video.selection.audio_scope,
        });
        capture.audio = Some(audio);
        (id, selection, ready)
    };
    let ready = tauri::async_runtime::spawn_blocking(move || {
        ready.recv_timeout(Duration::from_secs(10)) == Ok(true)
    })
    .await
    .unwrap_or(false);
    let mut capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    if !capture.video.as_ref().is_some_and(|video| video.id == id) || !allowed(&host) {
        return Err("Screen sharing was cancelled".into());
    }
    if !ready {
        capture.audio = None;
        return Err(
            "Windows could not capture audio for the selected scope. Share again to retry.".into(),
        );
    }
    Ok(selection)
}

pub fn audio_frame(app: &AppHandle, id: u64) -> Result<Vec<u8>, String> {
    let host = app.state::<Host>();
    let capture = host
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    if !allowed(&host) || !capture.video.as_ref().is_some_and(|video| id == video.id) {
        return Err("Screen sharing stopped".into());
    }
    let audio = capture.audio.as_ref().ok_or("Screen audio stopped")?;
    audio.packet()
}

#[tauri::command]
pub fn capture_audio_stop(window: WebviewWindow, id: String) -> Result<(), String> {
    main_window(&window)?;
    let mut capture = window
        .state::<Host>()
        .inner()
        .capture
        .lock()
        .map_err(|_| "Screen capture unavailable")?;
    if capture
        .video
        .as_ref()
        .is_some_and(|video| id == video.id.to_string())
    {
        capture.audio = None;
    }
    Ok(())
}
