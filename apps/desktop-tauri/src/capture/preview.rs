use super::{Settings, Source, read_frame, start_video_helper};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const SIZE: Settings = Settings {
    width: 240,
    height: 135,
    fps: 10,
};

pub fn capture(binary: &Path, source: &Source, stopped: &AtomicBool) -> Option<String> {
    if stopped.load(Ordering::Acquire) {
        return None;
    }
    let mut helper = start_video_helper(binary, source, &SIZE, true).ok()?;
    let mut stdout = helper.stdout.take().expect("piped preview output");
    let reader = thread::spawn(move || read_frame(&mut stdout, &SIZE));
    let deadline = Instant::now() + Duration::from_secs(2);
    while let Ok(None) = helper.try_wait() {
        if stopped.load(Ordering::Acquire) || Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    let _ = helper.kill();
    let _ = helper.wait();
    let (frame, width, height) = reader.join().ok()?.ok()?;
    if stopped.load(Ordering::Acquire) {
        return None;
    }
    Some(bitmap_url(&frame[8..], width, height))
}

fn bitmap_url(pixels: &[u8], width: u32, height: u32) -> String {
    // A top-down BMP uses the same BGRA row order as the capture frame.
    const HEADER_SIZE: u32 = 54;
    let mut bmp = Vec::with_capacity(HEADER_SIZE as usize + pixels.len());
    bmp.extend(b"BM");
    bmp.extend((HEADER_SIZE + pixels.len() as u32).to_le_bytes());
    bmp.extend([0; 4]);
    bmp.extend(HEADER_SIZE.to_le_bytes());
    bmp.extend(40u32.to_le_bytes());
    bmp.extend(width.to_le_bytes());
    bmp.extend((-(height as i32)).to_le_bytes());
    bmp.extend(1u16.to_le_bytes());
    bmp.extend(32u16.to_le_bytes());
    bmp.extend([0; 24]);
    bmp.extend(pixels);
    let mut url = String::from("data:image/bmp;base64,");
    STANDARD.encode_string(bmp, &mut url);
    url
}
