use super::{AudioScope, NO_CONSOLE, Selection};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;

const PACKET: usize = 7680;
const MAX_PACKETS: usize = 6;
type Queue = Arc<Mutex<VecDeque<[u8; PACKET]>>>;

pub struct Audio {
    helper: Child,
    queue: Queue,
    stopped: Arc<AtomicBool>,
}

impl Audio {
    pub fn start(
        binary: &Path,
        selection: &Selection,
        browser_pid: u32,
    ) -> Result<(Self, mpsc::Receiver<bool>), String> {
        let owner = std::process::id().to_string();
        let args = match selection.audio_scope {
            AudioScope::Application => vec![
                "include-window".into(),
                selection.source.handle.to_string(),
                owner,
                selection.source.pid.to_string(),
            ],
            AudioScope::System if browser_pid != 0 => {
                vec!["exclude-process".into(), browser_pid.to_string(), owner]
            }
            _ => return Err("Choose a supported Windows audio source first".into()),
        };
        let mut helper = Command::new(binary)
            .args(args)
            .creation_flags(NO_CONSOLE)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "Could not start Windows application audio")?;
        let stdout = helper.stdout.take().expect("piped audio output");
        let stderr = helper.stderr.take().expect("piped audio status");
        let queue = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_PACKETS)));
        let stopped = Arc::new(AtomicBool::new(false));
        let output = queue.clone();
        let failed = stopped.clone();
        thread::spawn(move || {
            read_packets(stdout, output);
            failed.store(true, Ordering::Release);
        });
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut line = String::new();
            let ready = BufReader::new(stderr.take(128))
                .read_line(&mut line)
                .is_ok()
                && line.trim() == "READY 48000 2";
            let _ = sender.send(ready);
        });
        Ok((
            Self {
                helper,
                queue,
                stopped,
            },
            receiver,
        ))
    }

    pub fn packet(&self) -> Result<Vec<u8>, String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("Windows application audio stopped. Restart sharing to retry.".into());
        }
        let mut queue = self
            .queue
            .lock()
            .map_err(|_| "Windows application audio unavailable")?;
        Ok(queue
            .pop_front()
            .map_or_else(Vec::new, |packet| packet.to_vec()))
    }
}

fn read_packets(mut pipe: impl Read, queue: Queue) {
    let mut packet = [0; PACKET];
    while pipe.read_exact(&mut packet).is_ok() {
        let Ok(mut queue) = queue.lock() else { return };
        if queue.len() == MAX_PACKETS {
            queue.pop_front();
        }
        queue.push_back(packet);
    }
}

impl Drop for Audio {
    fn drop(&mut self) {
        self.helper.stdin.take();
        let _ = self.helper.kill();
        let _ = self.helper.wait();
    }
}
