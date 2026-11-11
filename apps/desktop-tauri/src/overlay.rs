use crate::{Host, assets, settings::OverlayPosition};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_NOACTIVATE,
};
use windows_core::{HSTRING, w};

const WINDOW: &str = "voice-overlay";
const DOCUMENT: &str = "https://localhost/overlay.html";
const BRIDGE: &str = r#"
if (location.href === "https://localhost/overlay.html" && window.top === window) {
  Object.defineProperty(window, "voiceOverlay", { value: Object.freeze({
    onState(listener) {
      const handler = event => listener(event.data);
      chrome.webview.addEventListener("message", handler);
      return () => chrome.webview.removeEventListener("message", handler);
    }
  }) });
}
"#;

fn text(value: &Value, size: usize) -> String {
    value
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(size)
        .collect()
}

fn avatar(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    let encoded = value.strip_prefix("data:image/png;base64,")?;
    (value.len() <= 32768
        && encoded
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')))
    .then_some(value)
}

pub fn sanitize(value: Value, previous: Option<&Value>) -> Option<Value> {
    value["channel"].as_str()?;
    let old = previous.and_then(|value| value["members"].as_array());
    let members: Vec<_> = value["members"].as_array()?.iter().take(16).filter(|member| member["name"].is_string())
        .enumerate().map(|(index, member)| {
            let id = text(&member["id"], 80);
            let image = if let Some(explicit) = member.get("avatar") {
                avatar(explicit)
            } else {
                old.and_then(|list| {
                    if id.is_empty() { list.get(index) } else { list.iter().find(|old| old["id"] == id) }
                }).and_then(|old| avatar(&old["avatar"]))
            };
            json!({
                "id": id, "name": text(&member["name"], 48), "avatar": image,
                "muted": member["muted"] == true, "deafened": member["deafened"] == true,
                "serverMuted": member["serverMuted"] == true, "speaking": member["speaking"] == true,
            })
        }).collect();
    Some(json!({
        "channel": text(&value["channel"], 80),
        "language": if value["language"] == "fa-IR" { "fa-IR" } else { "en-US" },
        "members": members,
    }))
}

fn render(window: &WebviewWindow, packet: Value, position: OverlayPosition) -> tauri::Result<()> {
    if let Some(monitor) = window.primary_monitor()? {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let height = 20 + packet["members"].as_array().map_or(0, Vec::len) * 38;
        let width = (270.0 * scale).round() as u32;
        let height =
            ((height as f64 * scale).round() as u32).min(area.size.height.saturating_sub(32));
        let margin = (16.0 * scale).round() as i32;
        let right = matches!(
            position,
            OverlayPosition::TopRight | OverlayPosition::BottomRight
        );
        let bottom = matches!(
            position,
            OverlayPosition::BottomLeft | OverlayPosition::BottomRight
        );
        let x = area.position.x
            + if right {
                area.size.width as i32 - width as i32 - margin
            } else {
                margin
            };
        let y = area.position.y
            + if bottom {
                area.size.height as i32 - height as i32 - margin
            } else {
                margin
            };
        window.set_size(PhysicalSize::new(width, height))?;
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    let payload = HSTRING::from(packet.to_string());
    window.with_webview(move |view| unsafe {
        if let Ok(core) = view.controller().CoreWebView2() {
            let _ = core.PostWebMessageAsJson(&payload);
        }
    })?;
    window.show()
}

pub fn sync(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let host = app.state::<Host>();
    let preferences = host
        .settings
        .lock()
        .map_err(|_| "Overlay settings unavailable")?
        .value
        .voice_overlay;
    let packet = host
        .overlay
        .lock()
        .map_err(|_| "Overlay state unavailable")?
        .clone();
    let packet = packet.filter(|value| {
        preferences.enabled
            && host.in_call.load(Ordering::Acquire)
            && !host.locked.load(Ordering::Acquire)
            && !host.suspended.load(Ordering::Acquire)
            && value["members"]
                .as_array()
                .is_some_and(|list| !list.is_empty())
    });
    let Some(packet) = packet else {
        if let Some(overlay) = app.get_webview_window(WINDOW) {
            overlay.destroy()?;
        }
        return Ok(());
    };
    if let Some(window) = app.get_webview_window(WINDOW) {
        if window.url().is_ok_and(|url| url.as_str() == DOCUMENT) {
            render(&window, packet, preferences.position)?;
        }
        return Ok(());
    }
    let app_handle = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        WINDOW,
        WebviewUrl::External(url::Url::parse("about:blank")?),
    )
    .title("Dorham voice")
    .data_directory(host.profile.join("WebView2"))
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .focusable(false)
    .focused(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .use_https_scheme(true)
    .initialization_script(BRIDGE)
    .on_navigation(|url| matches!(url.as_str(), "about:blank" | DOCUMENT))
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_page_load(move |_, page| {
        if page.url().as_str() == DOCUMENT
            && page.event() == tauri::webview::PageLoadEvent::Finished
        {
            let _ = sync(&app_handle);
        }
    })
    .build()?;
    window.set_ignore_cursor_events(true)?;
    let hwnd = window.hwnd()?;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_NOACTIVATE.0 as isize);
    }
    let app = app.clone();
    window.with_webview(move |view| unsafe {
        if let Ok(core) = view.controller().CoreWebView2() {
            if assets::serve(&core, app, false).is_ok() {
                let _ = core.Navigate(w!("https://localhost/overlay.html"));
            }
        }
    })?;
    Ok(())
}
