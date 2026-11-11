use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::RemoteDesktop::{
    NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_NCDESTROY, WM_POWERBROADCAST,
    WM_WTSSESSION_CHANGE,
};

const SUBCLASS: usize = 130;
const SESSION_LOCK: u32 = 7;
const SESSION_UNLOCK: u32 = 8;

pub fn register(window: &WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = window.hwnd()?;
    unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)? };
    let app = Box::into_raw(Box::new(window.app_handle().clone()));
    unsafe {
        if !SetWindowSubclass(hwnd, Some(window_message), SUBCLASS, app as usize).as_bool() {
            drop(Box::from_raw(app));
            let _ = WTSUnRegisterSessionNotification(hwnd);
            return Err("Could not monitor the Windows session".into());
        }
    }
    Ok(())
}

unsafe extern "system" fn window_message(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    app: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(window_message), SUBCLASS);
            let _ = WTSUnRegisterSessionNotification(hwnd);
            drop(Box::from_raw(app as *mut AppHandle));
        }
    } else if matches!(message, WM_POWERBROADCAST | WM_WTSSESSION_CHANGE) {
        let app = unsafe { &*(app as *const AppHandle) };
        let host = app.state::<crate::Host>();
        match (message, wparam.0 as u32) {
            (WM_POWERBROADCAST, PBT_APMSUSPEND) => host.suspended.store(true, Ordering::Release),
            (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) => {
                host.suspended.store(false, Ordering::Release)
            }
            (WM_WTSSESSION_CHANGE, SESSION_LOCK) => host.locked.store(true, Ordering::Release),
            (WM_WTSSESSION_CHANGE, SESSION_UNLOCK) => host.locked.store(false, Ordering::Release),
            _ => return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) },
        }
        crate::sync_call_resources(app);
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
