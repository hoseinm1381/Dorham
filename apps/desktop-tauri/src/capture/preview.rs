use super::{Kind, NO_CONSOLE, Settings, Source, read_frame};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::collections::HashMap;
use std::io::{self, Read};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const SIZE: Settings = Settings {
    width: 192,
    height: 108,
    fps: 4,
};

pub const MAX_SOURCES: usize = 6;

#[derive(Default)]
struct Slot {
    frame: Option<(Vec<u8>, u32, u32)>,
    changed: bool,
    reported_unavailable: bool,
}

pub struct Batch {
    ids: Vec<String>,
    revision: u64,
    child: Child,
    latest: Arc<Mutex<Vec<Slot>>>,
    started: Instant,
}

impl Batch {
    pub fn start(binary: &Path, sources: &[&Source], revision: u64) -> io::Result<Self> {
        let mut command = Command::new(binary);
        command.arg("previews").arg(std::process::id().to_string());
        for source in sources {
            command.args([
                if source.kind == Kind::Window { "window" } else { "monitor" }.into(),
                source.handle.to_string(),
                source.pid.to_string(),
            ]);
        }
        let mut child = command
            .creation_flags(NO_CONSOLE)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdout = child.stdout.take().expect("piped preview output");
        let latest = Arc::new(Mutex::new((0..sources.len()).map(|_| Slot::default()).collect()));
        let output = latest.clone();
        thread::spawn(move || {
            let _ = read_previews(stdout, output);
        });
        Ok(Self {
            ids: sources.iter().map(|source| source.id.clone()).collect(),
            revision,
            child,
            latest,
            started: Instant::now(),
        })
    }

    pub fn matches(&self, sources: &[&Source], revision: u64) -> bool {
        self.revision == revision
            && self.ids.iter().map(String::as_str)
                .eq(sources.iter().map(|source| source.id.as_str()))
    }

    pub fn frames(&self) -> HashMap<String, Option<String>> {
        let mut result = HashMap::new();
        let Ok(mut latest) = self.latest.lock() else { return result };
        for (id, slot) in self.ids.iter().zip(latest.iter_mut()) {
            if let Some((frame, width, height)) = slot.frame.as_ref().filter(|_| slot.changed) {
                result.insert(id.clone(), Some(bitmap_url(&frame[8..], *width, *height)));
                slot.changed = false;
            } else if slot.frame.is_none()
                && !slot.reported_unavailable
                && self.started.elapsed() >= Duration::from_secs(2)
            {
                result.insert(id.clone(), None);
                slot.reported_unavailable = true;
            }
        }
        result
    }
}

impl Drop for Batch {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_previews(mut pipe: impl Read, latest: Arc<Mutex<Vec<Slot>>>) -> io::Result<()> {
    let mut header = [0; 4];
    loop {
        pipe.read_exact(&mut header)?;
        let frame = read_frame(&mut pipe, &SIZE, false, Vec::new())?;
        let Ok(mut slots) = latest.lock() else { return Ok(()) };
        let Some(slot) = slots.get_mut(u32::from_le_bytes(header) as usize) else { return Ok(()) };
        if slot.frame.as_ref() != Some(&frame) {
            slot.frame = Some(frame);
            slot.changed = true;
        }
    }
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
