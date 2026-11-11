fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_command",
            "capture_video",
            "capture_stop",
            "capture_picker_model",
            "capture_picker_thumbnail",
            "capture_picker_select",
            "capture_audio_start",
            "capture_audio_stop",
            "update_check",
            "update_prepare",
            "update_install",
        ]),
    ))
    .expect("validate the Dorham desktop manifest");
}
