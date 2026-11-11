use std::cell::RefCell;
use std::ptr;
use tauri::AppHandle;
use url::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::WebResourceRequestedEventHandler;
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows_core::{HSTRING, Interface, PWSTR, Result, w};

struct SharedVideo {
    id: u64,
    capacity: usize,
    buffer: ICoreWebView2SharedBuffer,
}

impl Drop for SharedVideo {
    fn drop(&mut self) {
        let _ = unsafe { self.buffer.Close() };
    }
}

// WebView2 owns the mapping on its UI thread. One capture can hold one mapping.
thread_local! {
    static SHARED_VIDEO: RefCell<Option<SharedVideo>> = const { RefCell::new(None) };
}

pub fn clear_shared_video(id: Option<u64>) {
    SHARED_VIDEO.with_borrow_mut(|shared| {
        if shared.as_ref().is_some_and(|video| id.is_none_or(|id| id == video.id)) {
            *shared = None;
        }
    });
}

fn share_video(
    environment: &ICoreWebView2Environment,
    sender: &ICoreWebView2,
    id: u64,
    bytes: &[u8],
) -> Result<usize> {
    SHARED_VIDEO.with_borrow_mut(|shared| {
        let replace = shared.as_ref().is_none_or(|video| video.id != id || video.capacity < bytes.len());
        if replace {
            let environment: ICoreWebView2Environment12 = environment.cast()?;
            let capacity = bytes.len();
            let video = SharedVideo { id, capacity, buffer: unsafe { environment.CreateSharedBuffer(capacity as u64)? } };
            let webview: ICoreWebView2_17 = sender.cast()?;
            let metadata = HSTRING::from(serde_json::json!({ "dorhamVideoId": id, "capacity": capacity }).to_string());
            unsafe { webview.PostSharedBufferToScript(&video.buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, &metadata)? };
            *shared = Some(video);
        }
        let video = shared.as_ref().expect("allocated shared capture buffer");
        let mut target = ptr::null_mut();
        unsafe { video.buffer.Buffer(&mut target)? };
        if target.is_null() {
            return Err(windows_core::Error::from_thread());
        }
        // The renderer sends its next request only after consuming this frame.
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len()) };
        Ok(video.capacity)
    })
}

pub fn serve(core: &ICoreWebView2, app: AppHandle, allow_media: bool) -> Result<()> {
    let core2: ICoreWebView2_2 = core.cast()?;
    let environment = unsafe { core2.Environment()? };
    let mut token = 0;
    unsafe {
        core.AddWebResourceRequestedFilter(
            w!("https://localhost/*"),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        )?;
        core.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let request = args.Request()?;
            let mut uri = PWSTR::null();
            request.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);
            let url = Url::parse(&uri).ok()
                .filter(|url| url.scheme() == "https" && url.host_str() == Some("localhost") && url.port().is_none()
                    && url.username().is_empty() && url.password().is_none());
            if let Some(path) = url.as_ref().and_then(|url| url.path().strip_prefix("/__dorham_media/")) {
                let mut document = PWSTR::null();
                if let Some(sender) = sender.as_ref() {
                    sender.Source(&mut document)?;
                }
                let document = webview2_com::take_pwstr(document);
                let mut method = PWSTR::null();
                request.Method(&mut method)?;
                let method = webview2_com::take_pwstr(method);
                let frame = if allow_media && method == "GET"
                    && Url::parse(&document).is_ok_and(|url| crate::trusted_main_url(&url))
                {
                    media(&app, path)
                } else {
                    Err("Untrusted screen media request".into())
                };
                let video_id = path.strip_prefix("video/").and_then(|id| id.parse::<u64>().ok());
                let shared_requested = url.as_ref().is_some_and(|url| url.query() == Some("shared=1"));
                if let Some(id) = video_id {
                    if let (true, Some(sender), Ok(bytes)) = (shared_requested, sender.as_ref(), frame.as_ref()) {
                        if !bytes.is_empty() {
                            if let Ok(capacity) = share_video(&environment, sender, id, bytes) {
                                let headers = HSTRING::from(format!("Cache-Control: no-store\r\nX-Dorham-Video-Buffer: {capacity}"));
                                let response = environment.CreateWebResourceResponse(None, 200, w!("OK"), &headers)?;
                                return args.SetResponse(&response);
                            }
                            clear_shared_video(Some(id));
                        }
                    } else if allow_media {
                        clear_shared_video(Some(id));
                    }
                }
                let (code, reason, bytes, content_type) = match frame {
                    Ok(bytes) if bytes.is_empty() => (204, "No Content", bytes, "application/octet-stream"),
                    Ok(bytes) => (200, "OK", bytes, "application/octet-stream"),
                    Err(error) => (410, "Gone", error.into_bytes(), "text/plain; charset=utf-8"),
                };
                let headers = HSTRING::from(format!("Content-Type: {content_type}\r\nCache-Control: no-store\r\nCross-Origin-Resource-Policy: same-origin\r\nX-Content-Type-Options: nosniff"));
                let stream = (!bytes.is_empty()).then(|| SHCreateMemStream(Some(&bytes))).flatten();
                let response = environment.CreateWebResourceResponse(stream.as_ref(), code, &HSTRING::from(reason), &headers)?;
                return args.SetResponse(&response);
            }
            let asset = url.and_then(|url| app.asset_resolver().get_for_scheme(url.path().trim_start_matches('/').to_owned(), true));
            let response = if let Some(asset) = asset {
                let headers = HSTRING::from(format!(
                    "Content-Type: {}\r\nX-Content-Type-Options: nosniff\r\nCross-Origin-Resource-Policy: same-origin\r\nReferrer-Policy: no-referrer",
                    asset.mime_type
                ));
                let stream = SHCreateMemStream(Some(&asset.bytes));
                environment.CreateWebResourceResponse(stream.as_ref(), 200, w!("OK"), &headers)?
            } else {
                environment.CreateWebResourceResponse(None, 404, w!("Not Found"), w!("Cache-Control: no-store"))?
            };
            args.SetResponse(&response)
        })), &mut token)?;
    }
    Ok(())
}

fn media(app: &AppHandle, path: &str) -> std::result::Result<Vec<u8>, String> {
    let (kind, id) = path.split_once('/').ok_or("Invalid screen media request")?;
    let id = id
        .parse::<u64>()
        .map_err(|_| "Invalid screen share identifier")?;
    match kind {
        "video" => crate::capture::video_frame(app, id),
        "audio" => crate::capture::audio_frame(app, id),
        _ => Err("Invalid screen media request".into()),
    }
}
