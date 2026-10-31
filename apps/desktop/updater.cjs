const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

function createUpdater(app, net, options = {}) {
  const { RELEASE_ORIGIN, releaseFile, newerVersion } = options.contracts || require('./release-contract.cjs');
  let busy = false;
  async function latest() {
    const response = await net.fetch(`${RELEASE_ORIGIN}/downloads/latest.json`, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Update check unavailable');
    const text = await response.text(); if (text.length > 16384) throw Error('Invalid update response');
    return releaseFile(JSON.parse(text), 'windows');
  }
  async function check() { const file = await latest(); return { current: app.getVersion(), latest: file.version, available: newerVersion(file.version, app.getVersion()) }; }
  async function install() {
    if (busy) throw Error('An update is already downloading'); busy = true;
    let partial;
    try {
      const file = await latest(); if (!newerVersion(file.version, app.getVersion())) throw Error('This app is already up to date');
      const directory = path.join(app.getPath('userData'), 'updates'); await fs.mkdir(directory, { recursive: true });
      partial = path.join(directory, 'installer.exe.download'); const installer = path.join(directory, 'installer.exe');
      await fs.rm(partial, { force: true });
      const response = await net.fetch(file.url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10 * 60000) });
      if (!response.ok || Number(response.headers.get('content-length')) !== file.size || !response.body) throw Error('Update download unavailable');
      const output = await fs.open(partial, 'wx'); const digest = createHash('sha256'); let size = 0;
      try { for await (const chunk of response.body) { size += chunk.length; if (size > file.size) throw Error('Invalid update size'); digest.update(chunk); await output.writeFile(chunk); } } finally { await output.close(); }
      if (size !== file.size || digest.digest('hex') !== file.sha256) throw Error('Update verification failed');
      await fs.rm(installer, { force: true }); await fs.rename(partial, installer);
      if (options.canInstall && !options.canInstall()) throw Error('Disconnect voice before installing an update.');
      const child = (options.spawn || spawn)(installer, ['--updated'], { detached: true, stdio: 'ignore', windowsHide: false });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      setTimeout(() => app.quit(), 750); return { started: true };
    } finally { if (partial) await fs.rm(partial, { force: true }); busy = false; }
  }
  return { check, install };
}
module.exports = { createUpdater };
