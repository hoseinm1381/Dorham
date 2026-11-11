use serde::Serialize;
use std::mem::size_of;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};
use windows_core::BOOL;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    #[serde(skip)]
    pub handle: usize,
    #[serde(skip)]
    pub pid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Screen,
    Window,
}

pub fn enumerate() -> Vec<Source> {
    let mut output = Vec::<Source>::new();
    let context = LPARAM((&mut output as *mut Vec<Source>) as isize);
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(monitor), context);
        let _ = EnumWindows(Some(window), context);
    }
    output
}

unsafe extern "system" fn monitor(handle: HMONITOR, _: HDC, _: *mut RECT, context: LPARAM) -> BOOL {
    let sources = unsafe { &mut *(context.0 as *mut Vec<Source>) };
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    if unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo) }.as_bool() {
        let device = String::from_utf16_lossy(&info.szDevice);
        let device = device.trim_end_matches('\0');
        let name = format!(
            "Screen {}",
            device.rsplit("DISPLAY").next().unwrap_or(device)
        );
        sources.push(Source {
            id: format!("screen:{}", handle.0 as usize),
            name,
            kind: Kind::Screen,
            handle: handle.0 as usize,
            pid: 0,
        });
    }
    true.into()
}

unsafe extern "system" fn window(handle: HWND, context: LPARAM) -> BOOL {
    let sources = unsafe { &mut *(context.0 as *mut Vec<Source>) };
    if sources.len() >= 120 {
        return false.into();
    }
    if !unsafe { IsWindowVisible(handle) }.as_bool() {
        return true.into();
    }
    let mut pid = 0;
    if unsafe { GetWindowThreadProcessId(handle, Some(&mut pid)) } == 0 || pid == std::process::id()
    {
        return true.into();
    }
    let mut cloaked = 0u32;
    let _ = unsafe {
        DwmGetWindowAttribute(
            handle,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            size_of::<u32>() as u32,
        )
    };
    if cloaked != 0 {
        return true.into();
    }
    let mut title = [0u16; 160];
    let length = unsafe { GetWindowTextW(handle, &mut title) };
    if length > 0 {
        sources.push(Source {
            id: format!("window:{}:{}", handle.0 as usize, pid),
            name: String::from_utf16_lossy(&title[..length as usize]),
            kind: Kind::Window,
            handle: handle.0 as usize,
            pid,
        });
    }
    true.into()
}
