//! Origin- and frame-scoped WebView2 media permissions.
//!
//! Install these handlers before navigating the product webview. Child frames
//! never receive device permissions, and display capture keeps WebView2's own
//! user-consent picker rather than selecting a source behind the user's back.

use webview2_com::{
    ContainsFullScreenElementChangedEventHandler, FrameCreatedEventHandler,
    FramePermissionRequestedEventHandler, PermissionRequestedEventHandler,
    ScreenCaptureStartingEventHandler,
    Microsoft::Web::WebView2::Win32::*,
};
use windows::core::{BOOL, Interface, PWSTR, Result};
use wry::{WebView, WebViewExtWindows};

/// A parsed origin comparison avoids prefix lookalikes, credentials and ports.
pub fn trusted_main_frame_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|uri| {
        uri.scheme() == "https"
            && uri.host_str() == Some("localhost")
            && uri.port_or_known_default() == Some(443)
            && uri.username().is_empty()
            && uri.password().is_none()
    })
}

fn permitted_kind(kind: COREWEBVIEW2_PERMISSION_KIND) -> bool {
    matches!(
        kind,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
            | COREWEBVIEW2_PERMISSION_KIND_CAMERA
            | COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY
            | COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS
    )
}

/// WebView2 owns these event-handler COM references for the webview's lifetime.
/// No handler captures the webview, avoiding a webview/handler reference cycle.
pub fn install_media_handlers<F>(webview: &WebView, on_fullscreen: F) -> Result<()>
where
    F: Fn(bool) + 'static,
{
    let core = webview.webview();
    // Require the interfaces used to enforce capture provenance. An outdated
    // runtime must fail setup rather than silently losing a security check.
    let capture: ICoreWebView2_27 = core.cast()?;
    let frames: ICoreWebView2_4 = core.cast()?;
    let _: ICoreWebView2_20 = core.cast()?;
    let mut token = 0_i64;
    unsafe {
        frames.add_FrameCreated(
            &FrameCreatedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    let frame: ICoreWebView2Frame3 = args.Frame()?.cast()?;
                    let mut child_token = 0_i64;
                    frame.add_PermissionRequested(
                        &FramePermissionRequestedEventHandler::create(Box::new(|_, args| {
                            if let Some(args) = args {
                                // A child frame's event also covers descendant
                                // requests. Handled prevents main-view policy
                                // from turning this denial into an allowance.
                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                                let extended: ICoreWebView2PermissionRequestedEventArgs2 =
                                    args.cast()?;
                                extended.SetHandled(true)?;
                                if let Ok(profile) =
                                    args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                                {
                                    profile.SetSavesInProfile(false)?;
                                }
                            }
                            Ok(())
                        })),
                        &mut child_token,
                    )?;
                }
                Ok(())
            })),
            &mut token,
        )?;

        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|sender, args| {
                let Some(args) = args else { return Ok(()) };
                // Default to denial before any fallible provenance operation.
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                if let Ok(profile) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    profile.SetSavesInProfile(false)?;
                }
                let Some(sender) = sender else { return Ok(()) };
                let checked = (|| -> Result<bool> {
                    let mut request_uri = PWSTR::null();
                    args.Uri(&mut request_uri)?;
                    let request_uri = webview2_com::take_pwstr(request_uri);
                    let mut document_uri = PWSTR::null();
                    sender.Source(&mut document_uri)?;
                    let document_uri = webview2_com::take_pwstr(document_uri);
                    let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                    args.PermissionKind(&mut kind)?;
                    Ok(trusted_main_frame_url(&request_uri)
                        && trusted_main_frame_url(&document_uri)
                        && permitted_kind(kind))
                })();
                if checked.unwrap_or(false) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        )?;

        capture.add_ScreenCaptureStarting(
            &ScreenCaptureStartingEventHandler::create(Box::new(|sender, args| {
                let Some(args) = args else { return Ok(()) };
                args.SetCancel(true)?;
                let Some(sender) = sender else { return Ok(()) };
                let checked = (|| -> Result<bool> {
                    let frame_info = args.OriginalSourceFrameInfo()?;
                    let frame_info_id: ICoreWebView2FrameInfo2 = frame_info.cast()?;
                    let main: ICoreWebView2_20 = sender.cast()?;
                    let mut source_id = 0_u32;
                    let mut main_id = 0_u32;
                    frame_info_id.FrameId(&mut source_id)?;
                    main.FrameId(&mut main_id)?;
                    let mut frame_uri = PWSTR::null();
                    frame_info.Source(&mut frame_uri)?;
                    let frame_uri = webview2_com::take_pwstr(frame_uri);
                    let mut document_uri = PWSTR::null();
                    sender.Source(&mut document_uri)?;
                    let document_uri = webview2_com::take_pwstr(document_uri);
                    Ok(main_id != 0
                        && main_id == source_id
                        && trusted_main_frame_url(&frame_uri)
                        && trusted_main_frame_url(&document_uri))
                })();
                if checked.unwrap_or(false) {
                    args.SetCancel(false)?;
                }
                Ok(())
            })),
            &mut token,
        )?;

        core.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                let checked = (|| -> Result<bool> {
                    let Some(sender) = sender else { return Ok(false) };
                    let mut uri = PWSTR::null();
                    sender.Source(&mut uri)?;
                    if !trusted_main_frame_url(&webview2_com::take_pwstr(uri)) {
                        return Ok(false);
                    }
                    let mut fullscreen = BOOL::default();
                    sender.ContainsFullScreenElement(&mut fullscreen)?;
                    Ok(fullscreen.as_bool())
                })();
                on_fullscreen(checked.unwrap_or(false));
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_origin_rejects_lookalikes_credentials_ports_and_other_schemes() {
        for uri in ["https://localhost/", "https://LOCALHOST/index.html", "https://localhost:443/chat?room=1"] {
            assert!(trusted_main_frame_url(uri), "{uri}");
        }
        for uri in [
            "http://localhost/", "https://localhost:444/", "https://localhost.evil.test/",
            "https://localhost@evil.test/", "https://evil.test@localhost/", "https://:secret@localhost/",
            "https://localhost./", "https://127.0.0.1/", "https://tauri.localhost/",
            "dorham://app/", "file:///index.html", "data:text/html,hello", "null", "about:blank",
        ] {
            assert!(!trusted_main_frame_url(uri), "{uri}");
        }
    }

    #[test]
    fn unrelated_sensitive_permissions_stay_denied() {
        for kind in [
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
        ] {
            assert!(!permitted_kind(kind));
        }
        assert!(permitted_kind(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE));
    }
}
