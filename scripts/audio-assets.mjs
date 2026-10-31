import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
const root = 'node_modules/@sapphi-red/web-noise-suppressor';
const meta = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
if (meta.version !== '0.4.1') throw Error('Review the RNNoise worklet patch before upgrading.');
let worklet = await readFile(`${root}/dist/rnnoise/workletProcessor.js`, 'utf8');
// Add an explicit startup handshake and error report to the pinned upstream
// processor. Keep the original DSP, buffering and destroy message unchanged.
const before = 'this.processor=p(t,{bufferSize:128,maxChannels:e.processorOptions.maxChannels}),this.destroyed&&this.destroy()})()';
const after = 'this.processor=p(t,{bufferSize:128,maxChannels:e.processorOptions.maxChannels}),this.destroyed?this.destroy():this.port.postMessage("ready")})().catch(()=>this.port.postMessage("error"))';
if (!worklet.includes(before)) throw Error('Unexpected RNNoise worklet source.');
const listener = 'this.port.addEventListener(`message`,e=>{e.data===`destroy`&&this.destroy()}),';
if (!worklet.includes(listener)) throw Error('Unexpected RNNoise message listener.');
worklet = '// Modified by Dorham: startup/error handshake and start the destroy-message port.\n' + worklet.replace(listener, listener + 'this.port.start(),').replace(before, after).replace(/\/\/# sourceMappingURL=.*$/, '');
await mkdir('apps/web/public/audio', { recursive: true });
await writeFile('apps/web/public/audio/rnnoise-worklet.js', worklet);
await copyFile(`${root}/dist/rnnoise.wasm`, 'apps/web/public/audio/rnnoise.wasm');
await writeFile('apps/web/public/audio/LICENSE.txt', 'RNNoise worklet notices. Dorham modifications: startup/error handshake and message-port startup.\n\n' + (await Promise.all(['web-noise-suppressor-MIT.txt', 'rnnoise-wasm-APACHE-2.0.txt', 'rnnoise-BSD-3-Clause.txt'].map(name => readFile(`docs/licenses/${name}`, 'utf8')))).join('\n\n'));
