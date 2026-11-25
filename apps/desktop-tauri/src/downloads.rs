use std::path::{Path, PathBuf};
use tauri::{Manager, Webview, webview::DownloadEvent};
use windows::Win32::{
    Foundation::{ERROR_CANCELLED, HWND},
    System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
    UI::Shell::{FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS, FileOpenDialog, IFileOpenDialog, SIGDN_FILESYSPATH},
};
use windows_core::HRESULT;

pub fn choose_folder(owner: HWND) -> windows_core::Result<Option<String>> {
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
        match dialog.Show(Some(owner)) {
            Err(error) if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) => Ok(None),
            result => {
                result?;
                let folder = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
                Ok(Some(webview2_com::take_pwstr(folder)))
            }
        }
    }
}

pub fn route(window: Webview, event: DownloadEvent<'_>) -> bool {
    let DownloadEvent::Requested { url, destination } = event else { return true };
    if url.scheme() != "blob" || !url.as_str().starts_with("blob:https://localhost/") {
        return true;
    }
    let host = window.state::<crate::Host>();
    let Ok(store) = host.settings.lock() else { return false };
    let Some(folder) = store.value.download_folder.as_deref() else { return true };
    let Some(name) = destination.file_name() else { return false };
    let Some(path) = unused_path(Path::new(folder), Path::new(name)) else { return false };
    *destination = path;
    true
}

fn unused_path(folder: &Path, name: &Path) -> Option<PathBuf> {
    if !folder.is_absolute() || !folder.is_dir() { return None; }
    let first = folder.join(name);
    if matches!(first.try_exists(), Ok(false)) { return Some(first); }
    let stem = name.file_stem()?.to_string_lossy();
    for index in 1..1000 {
        let mut next = folder.join(format!("{stem} ({index})"));
        if let Some(extension) = name.extension() { next.set_file_name(format!("{stem} ({index}).{}", extension.to_string_lossy())); }
        if matches!(next.try_exists(), Ok(false)) { return Some(next); }
    }
    None
}
