// Video elements here are muted previews/viewers. Audio stays in the independent
// media graph, with call signaling and native talk keys active in the tray.
let installed = false;
export function installNativeVisibility() {
  if (installed || !window.desktop?.onVisibility) return;
  installed = true;
  let visible = true;
  const paused = new Set<HTMLVideoElement>();
  const pause = (video: HTMLVideoElement) => { if (!video.paused) { paused.add(video); video.pause(); } };
  window.desktop.onVisibility(value => {
    visible = value; document.documentElement.classList.toggle('native-window-hidden', !visible);
    if (!visible) for (const video of document.querySelectorAll('video')) pause(video);
    else { for (const video of paused) if (video.isConnected) void video.play().catch(() => {}); paused.clear(); }
  });
  document.addEventListener('play', event => { if (!visible && event.target instanceof HTMLVideoElement) pause(event.target); }, true);
}
