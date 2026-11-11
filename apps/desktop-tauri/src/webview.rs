use crate::{set_in_call, trusted_main_url};
use std::sync::atomic::Ordering;
use tauri::{Manager, WebviewWindow};
use url::Url;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    ContainsFullScreenElementChangedEventHandler, NavigationStartingEventHandler,
    PermissionRequestedEventHandler, ProcessFailedEventHandler, ScreenCaptureStartingEventHandler,
};
use windows::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
use windows_core::{BOOL, HSTRING, Interface, PCWSTR, PWSTR, Result, w};

fn set_memory_target(core: &ICoreWebView2, idle: bool) {
    let Ok(view) = core.cast::<ICoreWebView2_19>() else { return };
    let level = if idle {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = unsafe { view.SetMemoryUsageTargetLevel(level) };
}

pub fn set_memory_idle(main: &WebviewWindow, idle: bool) {
    let app = main.app_handle().clone();
    let _ = main.with_webview(move |view| {
        let host = app.state::<crate::Host>();
        if let Ok(core) = unsafe { view.controller().CoreWebView2() } {
            set_memory_target(&core, idle && !host.in_call.load(Ordering::Acquire));
        }
    });
}

pub fn open_link(url: &Url) {
    if url.scheme() == "https"
        && url.has_host()
        && url.username().is_empty()
        && url.password().is_none()
    {
        let target = HSTRING::from(url.as_str());
        unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                &target,
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
    }
}

pub fn install(core: &ICoreWebView2, main: WebviewWindow) -> Result<()> {
    let mut token = 0;
    unsafe {
        let navigation_app = main.app_handle().clone();
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    set_memory_target(&core, false);
                }
                let app = navigation_app.clone();
                let _ = navigation_app.run_on_main_thread(move || {
                    if app
                        .state::<crate::Host>()
                        .in_call
                        .load(std::sync::atomic::Ordering::Acquire)
                    {
                        set_in_call(&app, false);
                    }
                });
                Ok(())
            })),
            &mut token,
        )?;
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|sender, args| {
                let Some(args) = args else { return Ok(()) };
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                if let Ok(handler) = args.cast::<ICoreWebView2PermissionRequestedEventArgs2>() {
                    handler.SetHandled(true)?;
                }
                if let Ok(profile) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    profile.SetSavesInProfile(false)?;
                }
                let Some(sender) = sender else { return Ok(()) };
                let mut source = PWSTR::null();
                sender.Source(&mut source)?;
                let source = webview2_com::take_pwstr(source);
                let mut request = PWSTR::null();
                args.Uri(&mut request)?;
                let request = webview2_com::take_pwstr(request);
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                args.PermissionKind(&mut kind)?;
                if matches!(
                    kind,
                    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE | COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY
                ) && Url::parse(&source).is_ok_and(|url| trusted_main_url(&url))
                    && Url::parse(&request).is_ok_and(|url| {
                        trusted_main_url(&url) || url.as_str() == "https://localhost/"
                    })
                {
                    // The verified document can request the mic through
                    // WebView2's permission store, including an existing denial.
                    if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                        #[cfg(debug_assertions)]
                        if std::env::var_os("DORHAM_TEST_DENY_MICROPHONE")
                            .is_some_and(|value| value == "1")
                        {
                            return Ok(());
                        }
                        if let Ok(profile) =
                            args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                        {
                            profile.SetSavesInProfile(true)?;
                        }
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_DEFAULT)?;
                    } else {
                        args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;

        if let Ok(capture) = core.cast::<ICoreWebView2_27>() {
            capture.add_ScreenCaptureStarting(
                &ScreenCaptureStartingEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }

        let fullscreen_window = main.clone();
        core.add_ContainsFullScreenElementChanged(
            &ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    let mut fullscreen = BOOL::default();
                    core.ContainsFullScreenElement(&mut fullscreen)?;
                    let _ = fullscreen_window.set_fullscreen(fullscreen.as_bool());
                }
                Ok(())
            })),
            &mut token,
        )?;

        let app = main.app_handle().clone();
        core.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED;
                    args.ProcessFailedKind(&mut kind)?;
                    if matches!(
                        kind,
                        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                    ) {
                        let owned = app.clone();
                        let _ = app.run_on_main_thread(move || set_in_call(&owned, false));
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}
