#![cfg_attr(not(feature = "native-test"), windows_subsystem = "windows")]
mod settings;
mod updater;
mod hotkeys;
mod overlay;
mod media;
mod tray;

use serde::Deserialize;
use serde_json::{Value,json};
use std::{path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use tao::{event::{Event,WindowEvent},event_loop::{ControlFlow,EventLoopBuilder,EventLoopProxy},window::{WindowBuilder,Fullscreen},dpi::LogicalSize,platform::windows::{WindowBuilderExtWindows,WindowExtWindows,EventLoopBuilderExtWindows}};
use wry::{WebViewBuilder,WebContext,WebViewExtWindows,WebViewBuilderExtWindows};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use windows::core::{Interface,HSTRING,PCWSTR};

#[derive(Debug,Deserialize)]
struct NativeRequest { id:u64, method:String, #[serde(default)] args:Value }
#[derive(Debug)]
enum UserEvent {
    Request(NativeRequest), Complete { id:u64, result:Result<Value,String>, quit:bool },
    Hotkey(hotkeys::HotkeyEvent), Fullscreen(bool), Tray(tray::TrayAction), Session(bool), Navigating,
}
fn response(webview:&wry::WebView,id:u64,result:Result<Value,String>) {
    let value=match result {Ok(value)=>json!({"id":id,"result":value}),Err(error)=>json!({"id":id,"error":error})};
    let _=webview.evaluate_script(&format!("window.__dorhamNativeResponse?.({value});"));
}
fn trusted(value:&str)->bool { media::trusted_main_frame_url(value) }
fn open_external(value:&str) {
    if let Ok(url)=url::Url::parse(value) {
        if url.scheme()=="https" && url.username().is_empty() && url.password().is_none() {
            unsafe { windows::Win32::UI::Shell::ShellExecuteW(None,&HSTRING::from("open"),&HSTRING::from(url.as_str()),PCWSTR::null(),PCWSTR::null(),windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL); }
        }
    }
}
fn path_setting() -> Result<(PathBuf,PathBuf),String> {
    let local=PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("Windows application data directory unavailable")?).join("Dorham");
    #[cfg(feature="native-test")]
    if let Some(root)=std::env::var_os("DORHAM_NATIVE_TEST_PROFILE") {
        let root=PathBuf::from(root);if !root.is_absolute() {return Err("Test profile must be absolute".into());}
        return Ok((root.join("native"),root.join("migration/electron-export-v1.json")));
    }
    Ok((local.join("native"),local.join("migration/electron-export-v1.json")))
}
fn asset_directory()->Result<PathBuf,String> {
    #[cfg(feature="native-test")]
    if let Some(value)=std::env::var_os("DORHAM_NATIVE_TEST_ASSETS") {return PathBuf::from(value).canonicalize().map_err(|e|e.to_string());}
    std::env::current_exe().map_err(|e|e.to_string())?.parent().ok_or("Application directory unavailable")?.join("assets").canonicalize().map_err(|_|"Bundled application interface is missing".into())
}

// Independent test profiles have independent instance identities and never
// activate a personal window. The named mutex lives for the entire process.
struct Instance(windows::Win32::Foundation::HANDLE);
impl Drop for Instance {fn drop(&mut self){unsafe{let _=windows::Win32::Foundation::CloseHandle(self.0);}}}
fn instance(profile:&Path)->Result<Option<Instance>,String>{
    use sha2::{Digest,Sha256};let suffix=format!("{:x}",Sha256::digest(profile.to_string_lossy().as_bytes()));
    unsafe {
        let handle=windows::Win32::System::Threading::CreateMutexW(None,false,&HSTRING::from(format!("Local\\Dorham.Rust.{}",&suffix[..24]))).map_err(|_|"Cannot initialize application instance")?;
        if windows::Win32::Foundation::GetLastError()==windows::Win32::Foundation::ERROR_ALREADY_EXISTS {
            if let Ok(hwnd)=windows::Win32::UI::WindowsAndMessaging::FindWindowW(&HSTRING::from(format!("DorhamRust{}",&suffix[..24])),PCWSTR::null()) {let _=windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd,windows::Win32::UI::WindowsAndMessaging::SW_RESTORE);let _=windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);}
            let _=windows::Win32::Foundation::CloseHandle(handle);return Ok(None);
        }
        Ok(Some(Instance(handle)))
    }
}

fn run()->Result<(),Box<dyn std::error::Error>> {
    let (profile,migration)=path_setting()?;std::fs::create_dir_all(&profile)?;
    let Some(_instance)=instance(&profile)? else {return Ok(());};
    #[cfg(not(feature="native-test"))]
    unsafe {for key in ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS","WEBVIEW2_USER_DATA_FOLDER","WEBVIEW2_BROWSER_EXECUTABLE_FOLDER","WEBVIEW2_RELEASE_CHANNEL_PREFERENCE"] {std::env::remove_var(key);}}
    let mut store=settings::SettingsStore::load(&profile,&migration)?;
    let assets=asset_directory()?;let in_call=Arc::new(AtomicBool::new(false));
    let updates=updater::Updater::new(profile.join("updates"),in_call.clone());
    let session_proxy:Arc<Mutex<Option<EventLoopProxy<UserEvent>>>>=Arc::new(Mutex::new(None));
    let p=session_proxy.clone();let mut builder=EventLoopBuilder::<UserEvent>::with_user_event();
    builder.with_msg_hook(move|message|{
        let message=unsafe{&*(message as *const windows::Win32::UI::WindowsAndMessaging::MSG)};
        let state=match(message.message,message.wParam.0){(0x02b1,7|2|4|6)=>Some(false),(0x02b1,8|1|3|5)=>Some(true),(0x0218,4)=>Some(false),(0x0218,7|18)=>Some(true),_=>None};
        if let Some(value)=state {if let Ok(p)=p.lock(){if let Some(p)=p.as_ref(){let _=p.send_event(UserEvent::Session(value));}}}false
    });
    let event_loop=builder.build();let proxy=event_loop.create_proxy();*session_proxy.lock().unwrap()=Some(proxy.clone());
    let icon=image::load_from_memory(&std::fs::read(assets.join("icon.png"))?)?.into_rgba8();let(width,height)=icon.dimensions();let icon_bytes=icon.into_raw();
    let native_icon=tao::window::Icon::from_rgba(icon_bytes.clone(),width,height)?;
    use sha2::{Digest,Sha256};let suffix=format!("{:x}",Sha256::digest(profile.to_string_lossy().as_bytes()));
    let window=WindowBuilder::new().with_title("Dorham — a little closer").with_window_classname(format!("DorhamRust{}",&suffix[..24])).with_inner_size(LogicalSize::new(1370.0,880.0)).with_min_inner_size(LogicalSize::new(720.0,540.0)).with_window_icon(Some(native_icon)).build(&event_loop)?;
    let hwnd=window.hwnd();let p=proxy.clone();
    let hotkeys=hotkeys::HotkeyController::spawn(Arc::new(move|value|{let _=p.send_event(UserEvent::Hotkey(value));}))?;hotkeys.set_window_handle(hwnd);
    let mut context=WebContext::new(Some(profile.join("webview2")));
    let script=include_str!("bridge.js").replace("__DORHAM_MIGRATED_STORAGE__",&serde_json::to_string(&store.value.pending_storage)?);
    let p=proxy.clone();let nav=proxy.clone();
    let mut webview_builder=WebViewBuilder::new_with_web_context(&mut context)
        .with_url("about:blank").with_background_color((16,18,24,255)).with_autoplay(true).with_devtools(true).with_initialization_script(script)
        .with_ipc_handler(move|request|{if !trusted(&request.uri().to_string())||request.body().len()>1024*1024{return;}if let Ok(value)=serde_json::from_str::<NativeRequest>(request.body()){let _=p.send_event(UserEvent::Request(value));}})
        .with_navigation_handler(|url|url=="about:blank"||trusted(&url))
        .with_new_window_req_handler(|url,_|{open_external(&url);wry::NewWindowResponse::Deny})
        .with_on_page_load_handler(move|kind,_|{if matches!(kind,wry::PageLoadEvent::Started){let _=nav.send_event(UserEvent::Navigating);}});
    #[cfg(feature="native-test")]
    if let Ok(arguments)=std::env::var("DORHAM_NATIVE_TEST_BROWSER_ARGS"){webview_builder=webview_builder.with_additional_browser_args(&arguments);}
    let webview=webview_builder.build(&window)?;
    unsafe {
        webview.webview().cast::<ICoreWebView2_3>()?.SetVirtualHostNameToFolderMapping(&HSTRING::from("localhost"),&HSTRING::from(assets.to_string_lossy().as_ref()),COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY)?;
        let preferences=webview.webview().Settings()?;preferences.SetAreDefaultContextMenusEnabled(true)?;preferences.SetIsStatusBarEnabled(false)?;
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from("com.dorham.chat"))?;
        windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification(windows::Win32::Foundation::HWND(hwnd as _),0)?;
        let p=proxy.clone();let mut token=0;
        webview.webview().add_ProcessFailed(&webview2_com::ProcessFailedEventHandler::create(Box::new(move|_,_|{let _=p.send_event(UserEvent::Navigating);Ok(())})),&mut token)?;
    }
    let p=proxy.clone();media::install_media_handlers(&webview,move|value|{let _=p.send_event(UserEvent::Fullscreen(value));})?;
    let mut voice_overlay=overlay::VoiceOverlay::new(&assets,&profile.join("overlay-webview2"))?;
    if let Ok(preferences)=serde_json::from_value(store.value.voice_overlay.clone()){voice_overlay.configure(preferences);}
    let p=proxy.clone();let native_tray=tray::NativeTray::new(icon_bytes,width,height,move|action|{let _=p.send_event(UserEvent::Tray(action));})?;
    webview.load_url("https://localhost/index.html")?;
    let mut exit_at:Option<Instant>=None;let mut available=true;
    event_loop.run(move|event,target,flow|{
        *flow=ControlFlow::WaitUntil(exit_at.unwrap_or_else(||Instant::now()+Duration::from_secs(1)));
        match event {
            Event::WindowEvent{window_id,event:WindowEvent::CloseRequested,..}if window_id==window.id()=>{if in_call.load(Ordering::Acquire){window.set_visible(false);}else{*flow=ControlFlow::Exit;}}
            Event::UserEvent(UserEvent::Fullscreen(value))=>{window.set_fullscreen(if value{Some(Fullscreen::Borderless(None))}else{None});}
            Event::UserEvent(UserEvent::Session(value))=>{available=value;hotkeys.set_session_available(value);voice_overlay.set_locked(!value);let _=voice_overlay.sync(target);}
            Event::UserEvent(UserEvent::Navigating)=>{hotkeys.set_active(false);in_call.store(false,Ordering::Release);voice_overlay.set_active(false);let _=voice_overlay.sync(target);}
            Event::UserEvent(UserEvent::Hotkey(value))=>{if hotkeys.is_current(value.generation){let mut value=serde_json::to_value(value).unwrap_or(Value::Null);value["background"]=json!(!window.is_focused());let _=webview.evaluate_script(&format!("window.__dorhamNativeHotkey?.({value});"));}}
            Event::UserEvent(UserEvent::Tray(action))=>{match action{tray::TrayAction::Open=>{window.set_visible(true);window.set_minimized(false);window.set_focus();}tray::TrayAction::Quit=>{*flow=ControlFlow::Exit;}_=>{}}}
            Event::UserEvent(UserEvent::Complete{id,result,quit})=>{response(&webview,id,result);if quit{exit_at=Some(Instant::now()+Duration::from_millis(750));}}
            Event::UserEvent(UserEvent::Request(request))=>{
                let NativeRequest{id,method,args}=request;if id==0||method.len()>64{return;}
                if method=="checkUpdate"||method=="installUpdate"{let updater=updates.clone();let p=proxy.clone();std::thread::spawn(move||{let install=method=="installUpdate";let result=if install{updater.install()}else{updater.check()};let quit=install&&result.is_ok();let _=p.send_event(UserEvent::Complete{id,result,quit});});return;}
                let result:Result<Value,String>=(||{match method.as_str(){
                    "getServer"=>Ok(json!(store.value.server)),
                    "setServer"=>{let value=settings::valid_server(args.as_str().ok_or("Invalid server address")?)?;let old=store.value.clone();store.value.server=value;store.value.secret=None;if let Err(e)=store.save(){store.value=old;return Err(e);}Ok(Value::Null)}
                    "getSecret"=>store.get_secret().map(|value|json!(value)),
                    "setSecret"=>{if !args.is_null()&&!args.is_string(){return Err("Invalid credential".into());}store.set_secret(args.as_str())?;Ok(Value::Null)}
                    "getAppInfo"=>Ok(json!({"version":updater::VERSION,"platform":"windows"})),
                    "getOverlay"=>Ok(serde_json::to_value(voice_overlay.preferences()).map_err(|e|e.to_string())?),
                    "configureOverlay"=>{let value=serde_json::from_value(args).map_err(|_|"Invalid overlay preferences")?;voice_overlay.configure(value);store.value.voice_overlay=serde_json::to_value(voice_overlay.preferences()).map_err(|e|e.to_string())?;store.save()?;voice_overlay.sync(target)?;Ok(store.value.voice_overlay.clone())}
                    "updateOverlay"=>{voice_overlay.update(serde_json::from_value(args).map_err(|_|"Invalid overlay state")?);voice_overlay.sync(target)?;Ok(Value::Null)}
                    "setInCall"=>{let active=args.as_bool().ok_or("Invalid voice state")?;in_call.store(active,Ordering::Release);hotkeys.set_active(active);hotkeys.set_session_available(available);voice_overlay.set_active(active);voice_overlay.sync(target)?;native_tray.set_in_call(active).map_err(|e|e.to_string())?;Ok(Value::Null)}
                    "setLanguage"=>{if !matches!(args.as_str(),Some("en-US"|"fa-IR")){return Err("Invalid language".into());}Ok(Value::Null)}
                    "configureVoiceHotkey"=>{hotkeys.configure(serde_json::from_value(args).map_err(|_|"Invalid voice hotkey")?)?;Ok(json!({"supported":true}))}
                    "storageMigrated"=>{store.value.pending_storage.clear();store.save()?;Ok(Value::Null)}
                    _=>Err("Unknown native operation".into())
                }})();response(&webview,id,result);
            }
            Event::MainEventsCleared=>{if exit_at.is_some_and(|deadline|Instant::now()>=deadline){*flow=ControlFlow::Exit;}}
            Event::LoopDestroyed=>{hotkeys.stop();voice_overlay.set_active(false);let _=voice_overlay.sync(target);}
            _=>{}
        }
    });
}
fn main(){if let Err(error)=run(){
    #[cfg(feature="native-test")]eprintln!("Dorham: {error}");
    #[cfg(not(feature="native-test"))]unsafe{windows::Win32::UI::WindowsAndMessaging::MessageBoxW(None,&HSTRING::from(format!("Dorham could not start. {error}")),&HSTRING::from("Dorham"),windows::Win32::UI::WindowsAndMessaging::MB_OK|windows::Win32::UI::WindowsAndMessaging::MB_ICONERROR);}
}}
