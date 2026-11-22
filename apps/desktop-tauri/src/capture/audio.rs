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
use windows_version::OsVersion;

const PACKET: usize = 7680;
const MAX_PACKETS: usize = 6;
const MAX_BATCH_PACKETS: usize = 3;
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
        let args = audio_arguments(selection, browser_pid, std::process::id(), OsVersion::current().build)?;
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
        Ok(take_batch(&mut queue))
    }
}

fn audio_arguments(selection: &Selection, browser_pid: u32, owner_pid: u32, build: u32) -> Result<Vec<String>, String> {
        let owner = owner_pid.to_string();
        Ok(match selection.audio_scope {
            AudioScope::Application if build < 20348 => return Err("Application-only sound needs a newer Windows version".into()),
            AudioScope::Application => vec![
                "include-window".into(),
                selection.source.handle.to_string(),
                owner,
                selection.source.pid.to_string(),
            ],
            AudioScope::System if build < 20348 => {
                vec!["output-system".into(), "1".into(), owner]
            }
            AudioScope::System if browser_pid != 0 => {
                vec!["exclude-process".into(), browser_pid.to_string(), owner]
            }
            _ => return Err("Choose a supported Windows audio source first".into()),
        })
}

fn take_batch(queue: &mut VecDeque<[u8; PACKET]>) -> Vec<u8> {
    let packets = queue.len().min(MAX_BATCH_PACKETS);
    let mut result = Vec::with_capacity(packets * PACKET);
    for packet in queue.drain(..packets) {
        result.extend_from_slice(&packet);
    }
    result
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_10_requires_explicit_computer_audio_and_never_broadens_application_audio() {
        let mut selection = Selection {
            source: super::super::sources::Source {
                id: "owned-window".into(), name: "Game".into(),
                kind: super::super::sources::Kind::Window, minimized: false,
                handle: 555, pid: 123,
            },
            audio_scope: AudioScope::None,
        };
        assert!(audio_arguments(&selection, 200, 100, 19045).is_err());
        selection.audio_scope = AudioScope::Application;
        assert!(audio_arguments(&selection, 200, 100, 19045).is_err());
        assert_eq!(audio_arguments(&selection, 200, 100, 22631).unwrap(), ["include-window", "555", "100", "123"]);
        selection.audio_scope = AudioScope::System;
        assert_eq!(audio_arguments(&selection, 0, 100, 19045).unwrap(), ["output-system", "1", "100"]);
        assert_eq!(audio_arguments(&selection, 200, 100, 22631).unwrap(), ["exclude-process", "200", "100"]);
        assert!(audio_arguments(&selection, 0, 100, 22631).is_err());
    }

    #[test]
    fn audio_batches_preserve_fifo_order_and_leave_pending_packets() {
        let mut queue = VecDeque::from([[1; PACKET], [2; PACKET], [3; PACKET], [4; PACKET]]);
        let batch = take_batch(&mut queue);
        assert_eq!(batch.len(), MAX_BATCH_PACKETS * PACKET);
        for (index, packet) in batch.chunks_exact(PACKET).enumerate() {
            assert!(packet.iter().all(|value| *value == index as u8 + 1));
        }
        assert_eq!(take_batch(&mut queue), vec![4; PACKET]);
        assert!(take_batch(&mut queue).is_empty());
    }
}
