#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assets;
mod capture;
mod downloads;
mod hotkeys;
mod overlay;
mod session;
mod settings;
mod updater;
mod webview;

use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, AtomicU32, Ordering},
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use url::Url;
use windows_core::HSTRING;

const MAIN: &str = "main";
const MAIN_DOCUMENT: &str = "https://localhost/index.html";

fn trusted_main_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/index.html"
}

struct Host {
    profile: PathBuf,
    benchmark: bool,
    settings: Mutex<settings::Store>,
    hotkeys: Mutex<hotkeys::Hotkeys>,
    capture: Mutex<capture::Capture>,
    updater: updater::Updater,
    browser_process: AtomicU32,
    overlay: Mutex<Option<Value>>,
    overlay_creating: AtomicBool,
    overlay_ready: AtomicBool,
    persian: AtomicBool,
    in_call: AtomicBool,
    locked: AtomicBool,
    suspended: AtomicBool,
}

fn sync_call_resources(app: &AppHandle) {
    let host = app.state::<Host>();
    let active = host.in_call.load(Ordering::Acquire)
        && !host.locked.load(Ordering::Acquire)
        && !host.suspended.load(Ordering::Acquire);
    if let Ok(mut keys) = host.hotkeys.lock() {
        keys.set_active(app, active);
    }
    if !active {
        capture::stop_all(app);
    }
    let _ = overlay::request_sync(app);
    render_tray(app);
}

fn set_in_call(app: &AppHandle, value: bool) {
    let host = app.state::<Host>();
    let previous = host.in_call.swap(value, Ordering::AcqRel);
    if value && !previous {
        host.updater.pause();
        if let Some(main) = app.get_webview_window(MAIN) {
            webview::set_memory_idle(&main, false);
        }
    } else if !value && previous && !cfg!(debug_assertions) {
        updater::schedule(app, false);
    }
    if !value {
        if let Ok(mut overlay) = host.overlay.lock() {
            *overlay = None;
        }
    }
    sync_call_resources(app);
}

#[derive(Deserialize)]
#[serde(tag = "method", content = "value", rename_all = "camelCase")]
enum DesktopRequest {
    GetAppInfo,
    GetServer,
    SetServer(String),
    GetSecret,
    SetSecret(Option<String>),
    GetDownloadFolder,
    ChooseDownloadFolder,
    ResetDownloadFolder,
    GetOverlay,
    ConfigureOverlay(settings::OverlayPreferences),
    UpdateOverlay(Value),
    GetPendingStorage,
    GetCaptureCapabilities,
    GetUpdateState,
    FinishMigration,
    SetInCall(bool),
    SetMemoryIdle(bool),
    ConfigureVoiceHotkey(hotkeys::Preferences),
    SetLanguage(String),
    IsVisible,
}

fn visible(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
}

fn publish_visibility(window: &WebviewWindow) {
    let _ = window.emit_to(MAIN, "desktop-visibility", visible(window));
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != MAIN || !window.url().is_ok_and(|url| trusted_main_url(&url)) {
        return Err("Untrusted desktop window".into());
    }
    Ok(())
}

#[tauri::command]
fn desktop_command(window: WebviewWindow, request: DesktopRequest) -> Result<Value, String> {
    require_main(&window)?;
    let host = window.state::<Host>();
    match request {
        DesktopRequest::ChooseDownloadFolder => {
            let owner = window.hwnd().map_err(|_| "The download folder picker could not open.")?;
            let folder = downloads::choose_folder(owner).map_err(|_| "The download folder picker could not open.")?;
            if let Some(path) = &folder {
                host.settings.lock().map_err(|_| "Dorham settings are unavailable")?.change(|settings| {
                    settings.download_folder = Some(path.clone());
                    Ok(())
                })?;
            }
            Ok(json!(folder))
        }
        DesktopRequest::GetAppInfo => Ok(json!({
            "version": window.app_handle().package_info().version.to_string(),
            "platform": "windows",
        })),
        DesktopRequest::IsVisible => Ok(json!(visible(&window))),
        DesktopRequest::GetUpdateState => Ok(json!(host.updater.state())),
        DesktopRequest::GetCaptureCapabilities => Ok(json!({
            "sharedAudio": host.capture.lock().map_err(|_| "Screen capture unavailable")?.shared_audio(),
        })),
        DesktopRequest::SetInCall(value) => {
            set_in_call(window.app_handle(), value);
            Ok(Value::Null)
        }
        DesktopRequest::SetMemoryIdle(idle) => {
            webview::set_memory_idle(&window, idle);
            Ok(Value::Null)
        }
        DesktopRequest::ConfigureVoiceHotkey(value) => {
            let supported = host
                .hotkeys
                .lock()
                .map_err(|_| "Voice hotkeys unavailable")?
                .configure(window.app_handle(), value)?;
            Ok(json!({ "supported": supported }))
        }
        DesktopRequest::SetLanguage(language) => {
            if matches!(language.as_str(), "en-US" | "fa-IR") {
                host.persian.store(language == "fa-IR", Ordering::Release);
                render_tray(window.app_handle());
            }
            Ok(Value::Null)
        }
        DesktopRequest::UpdateOverlay(value) => {
            if !host.in_call.load(Ordering::Acquire) {
                return Ok(Value::Null);
            }
            let mut current = host
                .overlay
                .lock()
                .map_err(|_| "Overlay state unavailable")?;
            let next = overlay::sanitize(value, current.as_ref());
            if next != *current {
                *current = next;
                drop(current);
                overlay::request_sync(window.app_handle()).map_err(|_| "Could not update voice overlay")?;
            }
            Ok(Value::Null)
        }
        request => {
            let mut store = host
                .settings
                .lock()
                .map_err(|_| "Dorham settings are unavailable")?;
            match request {
                DesktopRequest::GetServer => Ok(json!(store.value.server)),
                DesktopRequest::SetServer(server) => {
                    let server = settings::server_origin(&server)?;
                    store.change(|settings| {
                        if settings.server != server {
                            settings.server = server;
                            settings.set_secret(None)?;
                        }
                        Ok(())
                    })?;
                    Ok(Value::Null)
                }
                DesktopRequest::GetSecret => Ok(json!(store.value.get_secret()?)),
                DesktopRequest::GetDownloadFolder => Ok(json!(store.value.download_folder)),
                DesktopRequest::ResetDownloadFolder => {
                    store.change(|settings| { settings.download_folder = None; Ok(()) })?;
                    Ok(Value::Null)
                }
                DesktopRequest::SetSecret(value) => {
                    store.change(|settings| settings.set_secret(value.as_deref()))?;
                    Ok(Value::Null)
                }
                DesktopRequest::GetOverlay => {
                    let mut value = json!(store.value.voice_overlay);
                    value["monitors"] = json!(overlay::monitor_names(&window));
                    Ok(value)
                }
                DesktopRequest::ConfigureOverlay(preferences) => {
                    store.change(|settings| {
                        settings.voice_overlay = preferences;
                        Ok(())
                    })?;
                    drop(store);
                    overlay::request_sync(window.app_handle())
                        .map_err(|_| "Could not update voice overlay")?;
                    window
                        .emit_to(MAIN, "desktop-overlay-preferences", preferences)
                        .map_err(|_| "Could not update overlay preferences")?;
                    let mut value = json!(preferences);
                    value["monitors"] = json!(overlay::monitor_names(&window));
                    Ok(value)
                }
                DesktopRequest::GetPendingStorage => Ok(json!(store.pending_storage())),
                DesktopRequest::FinishMigration => {
                    store.finish_migration()?;
                    Ok(Value::Null)
                }
                _ => unreachable!(),
            }
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        publish_visibility(&window);
    }
}

struct TrayItems {
    open: MenuItem<tauri::Wry>,
    update: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

fn render_tray(app: &AppHandle) {
    let Some(menu) = app.try_state::<TrayItems>() else {
        return;
    };
    let host = app.state::<Host>();
    let fa = host.persian.load(Ordering::Acquire);
    let in_call = host.in_call.load(Ordering::Acquire);
    let update = host.updater.state();
    let _ = menu.open.set_text(if fa {
        "باز کردن دورهم"
    } else {
        "Open Dorham"
    });
    let _ = menu.quit.set_text(if fa {
        "خروج (قطع تماس صوتی)"
    } else {
        "Quit (disconnect voice)"
    });
    let status = match (fa, update.phase) {
        (true, "ready") => format!("راه‌اندازی دوباره برای به‌روزرسانی {}", update.latest),
        (false, "ready") => format!("Restart to update {}", update.latest),
        (true, "downloading") => format!("دریافت به‌روزرسانی {}%", update.progress),
        (false, "downloading") => format!("Downloading update {}%", update.progress),
        (true, "installing") => "در حال نصب به‌روزرسانی…".into(),
        (false, "installing") => "Installing update…".into(),
        (true, _) => "بررسی به‌روزرسانی".into(),
        (false, _) => "Check for updates".into(),
    };
    let _ = menu.update.set_text(&status);
    let _ = menu
        .update
        .set_enabled(!in_call && !matches!(update.phase, "downloading" | "installing"));
    if let Some(tray) = app.tray_by_id("dorham") {
        let title = if in_call {
            if fa {
                "Dorham — در تماس صوتی"
            } else {
                "Dorham — in voice"
            }
        } else {
            "Dorham"
        };
        let _ = tray.set_tooltip(Some(title));
    }
}

fn profile_dir(app: &tauri::App) -> tauri::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("DORHAM_TEST_PROFILE_ROOT") {
        let root = PathBuf::from(root);
        if root.is_absolute() {
            return Ok(root);
        }
    }
    app.path().app_local_data_dir()
}

fn setup(app: &mut tauri::App, benchmark_profile: Option<&Path>) -> Result<(), Box<dyn std::error::Error>> {
    let benchmark = benchmark_profile.is_some();
    let profile = match benchmark_profile {
        Some(path) => path.to_owned(),
        None => profile_dir(app)?,
    };
    let alternate = benchmark
        || cfg!(debug_assertions) && std::env::var_os("DORHAM_TEST_PROFILE_ROOT").is_some();
    let migration = if alternate {
        profile.join("electron-export-v1.json")
    } else {
        app.path().local_data_dir()?.join("Dorham/migration/electron-export-v1.json")
    };
    let settings = settings::Store::load(&profile, &migration)?;
    app.manage(Host {
        profile: profile.clone(),
        benchmark,
        settings: Mutex::new(settings),
        hotkeys: Mutex::new(hotkeys::Hotkeys::new(
            app.path().resource_dir()?.join("native/VoiceHotkey.exe"),
        )),
        capture: Mutex::new(capture::Capture::new(&app.path().resource_dir()?)),
        updater: updater::Updater::new(profile.join("updates"))?,
        browser_process: AtomicU32::new(0),
        overlay: Mutex::new(None),
        overlay_creating: AtomicBool::new(false),
        overlay_ready: AtomicBool::new(false),
        persian: AtomicBool::new(false),
        in_call: AtomicBool::new(false),
        locked: AtomicBool::new(false),
        suspended: AtomicBool::new(false),
    });
    let main =
        WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(Url::parse("about:blank")?))
            .title("Dorham")
            .inner_size(1370.0, 880.0)
            .min_inner_size(720.0, 540.0)
            .data_directory(profile.join("WebView2"))
            .use_https_scheme(true)
            .visible(false)
            .on_navigation(|url| url.as_str() == "about:blank" || trusted_main_url(url))
            .on_download(downloads::route)
            .on_new_window(|url, _| {
                webview::open_link(&url);
                NewWindowResponse::Deny
            })
            .build()?;
    session::register(&main)?;
    let show = main.clone();
    let app_handle = app.handle().clone();
    main.with_webview(move |view| {
        let result = (|| -> windows_core::Result<()> {
            let core = unsafe { view.controller().CoreWebView2()? };
            unsafe {
                let mut browser = 0;
                core.BrowserProcessId(&mut browser)?;
                app_handle
                    .state::<Host>()
                    .browser_process
                    .store(browser, Ordering::Release);
                assets::serve(&core, app_handle.clone(), true)?;
                webview::install(&core, show.clone())?;
                core.Navigate(&HSTRING::from(MAIN_DOCUMENT))?;
            }
            Ok(())
        })();
        if result.is_ok() {
            let _ = show.show();
            publish_visibility(&show);
        } else {
            eprintln!("Could not initialize the bundled Dorham interface");
            app_handle.exit(1);
        }
    })?;
    let window = main.clone();
    main.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if window.state::<Host>().in_call.load(Ordering::Acquire) {
                let _ = window.hide();
                publish_visibility(&window);
            } else {
                window.app_handle().exit(0);
            }
        }
        WindowEvent::Resized(_) | WindowEvent::Focused(_) => publish_visibility(&window),
        _ => {}
    });

    let open = MenuItem::with_id(app, "open", "Open Dorham", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit (disconnect voice)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &update, &quit])?;
    let mut tray = TrayIconBuilder::with_id("dorham")
        .menu(&menu)
        .tooltip("Dorham")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "update" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let host = app.state::<Host>();
                    if host.updater.state().available {
                        if host.updater.install(&app).await.is_err() {
                            let _ = app.run_on_main_thread({
                                let app = app.clone();
                                move || show_main(&app)
                            });
                        }
                    } else {
                        updater::schedule(&app, true);
                    }
                });
            }
            "quit" => {
                set_in_call(app, false);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    app.manage(TrayItems { open, update, quit });
    if !benchmark && !cfg!(debug_assertions) {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(10));
            loop {
                updater::schedule(&handle, true);
                std::thread::sleep(std::time::Duration::from_secs(3600));
            }
        });
    }
    Ok(())
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let command = args.next();
    if command.as_deref() == Some(std::ffi::OsStr::new("--validate-electron-export")) {
        let valid = args
            .next()
            .is_some_and(|path| settings::validate_legacy(Path::new(&path)).is_ok())
            && args.next().is_none();
        std::process::exit(if valid { 0 } else { 1 });
    }
    let benchmark_profile = if command.as_deref() == Some(std::ffi::OsStr::new("--benchmark-profile")) {
        let Some(profile) = args.next().map(PathBuf::from).filter(|path| path.is_absolute() && path.is_dir()) else {
            std::process::exit(2);
        };
        if args.next().is_some() {
            std::process::exit(2);
        }
        Some(profile)
    } else {
        None
    };
    let mut builder = tauri::Builder::default();
    if benchmark_profile.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show_main(app)));
    }
    builder
        .setup(move |app| setup(app, benchmark_profile.as_deref()))
        .invoke_handler(tauri::generate_handler![
            desktop_command,
            capture::capture_video,
            capture::capture_quality,
            capture::capture_stop,
            capture::capture_picker_model,
            capture::capture_picker_previews,
            capture::capture_picker_restore,
            capture::capture_picker_select,
            capture::capture_audio_start,
            capture::capture_audio_stop,
            updater::update_check,
            updater::update_prepare,
            updater::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("start Dorham Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_limited_to_the_bundled_document() {
        assert!(trusted_main_url(&Url::parse(MAIN_DOCUMENT).unwrap()));
        for url in [
            "http://localhost/index.html",
            "https://localhost:1443/index.html",
            "https://user@localhost/index.html",
            "https://localhost.evil.example/index.html",
            "https://localhost/overlay.html",
            "https://tauri.localhost/index.html",
            "about:blank",
        ] {
            assert!(!trusted_main_url(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
