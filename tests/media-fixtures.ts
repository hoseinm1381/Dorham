import type { Page } from '@playwright/test';
export async function makeVideo(page: Page): Promise<Buffer> {
  const data = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const draw = canvas.getContext('2d')!, stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const finished = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    let frame = 0; const timer = setInterval(() => { draw.fillStyle = frame++ % 2 ? '#713ce0' : '#32bca5'; draw.fillRect(0, 0, 320, 180); draw.fillStyle = 'white'; draw.fillText(`Inline video ${frame}`, 20, 60); }, 60);
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 1400)); recorder.stop(); clearInterval(timer);
    const blob = await finished; stream.getTracks().forEach(track => track.stop()); return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(data);
}
