//! Main-thread native tray with event-loop-safe actions.

use std::sync::Arc;
use tray_icon::{
    Icon, MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent,
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayAction {
    Open,
    Quit,
}

/// Keep this value alive for the application lifetime. `on_action` should only
/// enqueue a Tao user event; it must not access a WebView or HWND off-thread.
pub struct NativeTray {
    tray: TrayIcon,
}

impl NativeTray {
    pub fn new<F>(
        rgba: Vec<u8>,
        width: u32,
        height: u32,
        on_action: F,
    ) -> Result<Self, Box<dyn std::error::Error>>
    where
        F: Fn(TrayAction) + Send + Sync + 'static,
    {
        let menu = Menu::new();
        let open = MenuItem::new("Open Dorham", true, None);
        let quit = MenuItem::new("Quit (disconnect voice)", true, None);
        menu.append_items(&[&open, &PredefinedMenuItem::separator(), &quit])?;
        let tray = TrayIconBuilder::new()
            .with_id("dorham-main-tray")
            .with_tooltip("Dorham")
            .with_icon(Icon::from_rgba(rgba, width, height)?)
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(false)
            .build()?;
        let on_action = Arc::new(on_action);
        let on_menu = Arc::clone(&on_action);
        let open_id = open.id().clone();
        let quit_id = quit.id().clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            if event.id == open_id {
                on_menu(TrayAction::Open);
            } else if event.id == quit_id {
                on_menu(TrayAction::Quit);
            }
        }));
        let tray_id = tray.id().clone();
        TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
            if let TrayIconEvent::DoubleClick { id, button: MouseButton::Left, .. } = event {
                if id == tray_id {
                    on_action(TrayAction::Open);
                }
            }
        }));
        Ok(Self { tray })
    }

    pub fn set_in_call(&self, active: bool) -> tray_icon::Result<()> {
        self.tray.set_tooltip(Some(if active { "Dorham — in voice" } else { "Dorham" }))
    }
}

impl Drop for NativeTray {
    fn drop(&mut self) {
        // This host owns exactly one tray. Release callbacks holding event-loop
        // proxies before the tray's HWND and the loop itself are destroyed.
        MenuEvent::set_event_handler(None::<fn(MenuEvent)>);
        TrayIconEvent::set_event_handler(None::<fn(TrayIconEvent)>);
    }
}
