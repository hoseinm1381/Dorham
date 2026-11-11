use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const KEYS: &str = include_str!("../../../packages/contracts/src/voice-keys.json");
const CREATE_NO_WINDOW: u32 = 0x08000000;
static VIRTUAL_KEYS: OnceLock<HashMap<String, u32>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Open,
    Push,
    Toggle,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
struct Binding {
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Preferences {
    mode: Mode,
    background: bool,
    binding: Binding,
}

impl Preferences {
    fn key(&self) -> Result<u32, String> {
        if self.binding.alt && self.binding.code == "F4" {
            return Err("Unsupported voice hotkey".into());
        }
        VIRTUAL_KEYS
            .get_or_init(|| serde_json::from_str(KEYS).expect("valid shared Windows voice keys"))
            .get(&self.binding.code)
            .copied()
            .ok_or_else(|| "Unsupported voice hotkey".into())
    }
}

pub struct Hotkeys {
    path: PathBuf,
    preferences: Option<Preferences>,
    active: bool,
    helper: Option<Child>,
    generation: Arc<AtomicU64>,
    failures: u32,
}

impl Hotkeys {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            preferences: None,
            active: false,
            helper: None,
            generation: Arc::new(AtomicU64::new(0)),
            failures: 0,
        }
    }

    pub fn configure(&mut self, app: &AppHandle, preferences: Preferences) -> Result<bool, String> {
        preferences.key()?;
        if self.preferences.as_ref() != Some(&preferences) {
            self.preferences = Some(preferences);
            self.restart(app);
        }
        Ok(self.path.is_file())
    }

    pub fn set_active(&mut self, app: &AppHandle, active: bool) {
        if self.active != active {
            self.active = active;
            self.restart(app);
        }
    }

    fn stop(&mut self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(mut child) = self.helper.take() {
            child.stdin.take();
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn restart(&mut self, app: &AppHandle) {
        self.stop();
        self.failures = 0;
        emit(app, "release", None);
        self.start(app);
    }

    fn start(&mut self, app: &AppHandle) {
        let Some(preferences) = self
            .preferences
            .as_ref()
            .filter(|p| self.active && p.background && p.mode != Mode::Open)
        else {
            return;
        };
        let Ok(key) = preferences.key() else { return };
        let binding = &preferences.binding;
        let mods =
            u8::from(binding.ctrl) | (u8::from(binding.alt) << 1) | (u8::from(binding.shift) << 2);
        let mut child = match Command::new(&self.path)
            .args([
                key.to_string(),
                mods.to_string(),
                std::process::id().to_string(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => {
                self.failed(app);
                return;
            }
        };
        let stdout = child.stdout.take().expect("piped hotkey output");
        let (sender, receiver) = mpsc::sync_channel(16);
        thread::spawn(move || read_events(stdout, sender));
        self.helper = Some(child);
        let app = app.clone();
        let generation = self.generation.clone();
        let current = generation.load(Ordering::SeqCst);
        thread::spawn(move || {
            let mut ready = false;
            while generation.load(Ordering::SeqCst) == current {
                match receiver.recv_timeout(Duration::from_millis(3500)) {
                    Ok(event @ (b'H' | b'D' | b'U')) => {
                        if !ready {
                            ready = true;
                            with_current(&app, current, |keys, app| {
                                keys.failures = 0;
                                emit(app, "ready", None);
                            });
                        }
                        match event {
                            b'D' => schedule_key(&app, current, "down"),
                            b'U' => schedule_key(&app, current, "up"),
                            _ => {}
                        }
                    }
                    _ => {
                        with_current(&app, current, |keys, app| keys.failed(app));
                        break;
                    }
                }
            }
        });
    }

    fn failed(&mut self, app: &AppHandle) {
        self.stop();
        emit(app, "release", None);
        if self.failures == 0 {
            emit(
                app,
                "error",
                Some("Background hotkey interrupted. Microphone released."),
            );
        }
        let delay = Duration::from_millis(750 << self.failures.min(4));
        self.failures = self.failures.saturating_add(1);
        let app = app.clone();
        let current = self.generation.load(Ordering::SeqCst);
        thread::spawn(move || {
            thread::sleep(delay);
            with_current(&app, current, |keys, app| keys.start(app));
        });
    }
}

impl Drop for Hotkeys {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_events(mut pipe: impl Read, sender: mpsc::SyncSender<u8>) {
    let mut input = [0; 64];
    let mut line = Vec::with_capacity(4);
    while let Ok(count) = pipe.read(&mut input) {
        if count == 0 {
            return;
        }
        for &byte in &input[..count] {
            if byte == b'\n' {
                if !matches!(
                    line.as_slice(),
                    [b'D' | b'U' | b'H'] | [b'D' | b'U' | b'H', b'\r']
                ) || sender.send(line[0]).is_err()
                {
                    return;
                }
                line.clear();
            } else if line.len() < 2 {
                line.push(byte);
            } else {
                return;
            }
        }
    }
}

fn with_current(
    app: &AppHandle,
    current: u64,
    operation: impl FnOnce(&mut Hotkeys, &AppHandle) + Send + 'static,
) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let host = handle.state::<crate::Host>();
        if let Ok(mut keys) = host.hotkeys.lock() {
            if keys.generation.load(Ordering::SeqCst) == current {
                operation(&mut keys, &handle);
            }
        }
    });
}

fn schedule_key(app: &AppHandle, current: u64, kind: &'static str) {
    with_current(app, current, move |_, app| emit(app, kind, None));
}

fn emit(app: &AppHandle, kind: &str, message: Option<&str>) {
    let background = app
        .get_webview_window("main")
        .is_none_or(|window| !window.is_focused().unwrap_or(false));
    let _ = app.emit_to(
        "main",
        "desktop-voice-hotkey",
        json!({ "type": kind, "background": background, "message": message }),
    );
}
