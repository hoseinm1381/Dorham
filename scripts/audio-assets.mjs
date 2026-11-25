import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'node_modules/@sapphi-red/web-noise-suppressor';
const meta = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
if (meta.version !== '0.4.1') throw Error('Review the RNNoise worklet patch before upgrading.');
let worklet = await readFile(`${root}/dist/rnnoise/workletProcessor.js`, 'utf8');
// Add startup status and apply our speech gate after each denoised frame.
const before = 'this.processor=p(t,{bufferSize:128,maxChannels:e.processorOptions.maxChannels}),this.destroyed&&this.destroy()})()';
const after = 'this.processor=p(t,{bufferSize:128,maxChannels:e.processorOptions.maxChannels}),this.destroyed?this.destroy():this.port.postMessage("ready")})().catch(()=>this.port.postMessage("error"))';
if (!worklet.includes(before)) throw Error('Unexpected RNNoise worklet source.');
const listener = 'this.port.addEventListener(`message`,e=>{e.data===`destroy`&&this.destroy()}),';
if (!worklet.includes(listener)) throw Error('Unexpected RNNoise message listener.');
const processFrame = 'let t=e.createDenoiseState(),n=e=>{u(e),t.processFrame(e),d(e)}';
if (!worklet.includes(processFrame)) throw Error('Unexpected RNNoise frame callback.');
worklet = '// Modified by Dorham: startup/error handshake, message port and speech gating.\nimport { speechGate } from "./speech-gate.js";\n' +
  worklet.replace(listener, listener + 'this.port.start(),').replace(before, after)
    .replace(processFrame, 'let t=e.createDenoiseState(),gate=speechGate(),n=e=>{u(e);const probability=t.processFrame(e);gate(e,probability);d(e)}')
    .replace(/\/\/# sourceMappingURL=.*$/, '');
await mkdir('apps/web/public/audio', { recursive: true });
await writeFile('apps/web/public/audio/rnnoise-worklet.js', worklet);
await copyFile('packages/media/src/speech-gate.worklet.js', 'apps/web/public/audio/speech-gate.js');
await copyFile(`${root}/dist/rnnoise.wasm`, 'apps/web/public/audio/rnnoise.wasm');
const announcements = JSON.parse(await readFile('assets/tts-loading/manifest.json', 'utf8'));
for (const clip of announcements.clips) {
  const source = `assets/tts-loading/${clip.file}`, data = await readFile(source);
  if (createHash('sha256').update(data).digest('hex') !== clip.sha256 || data.length !== clip.bytes) throw Error('Loading announcement differs from its reviewed recording.');
}
await copyFile('assets/tts-loading/README.md', 'apps/web/public/audio/tts-loading-CREDITS.txt');
await writeFile('apps/web/public/audio/LICENSE.txt', 'RNNoise worklet notices. Dorham modifications: startup/error handshake, message-port startup and speech gating.\n\n' + (await Promise.all(['web-noise-suppressor-MIT.txt', 'rnnoise-wasm-APACHE-2.0.txt', 'rnnoise-BSD-3-Clause.txt'].map(name => readFile(`docs/licenses/${name}`, 'utf8')))).join('\n\n'));
