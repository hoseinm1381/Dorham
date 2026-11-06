/* global AbortController, clearTimeout */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { spawn } = require('node:child_process');

function createUpdater(app, net, options = {}) {
  const { RELEASE_ORIGIN, releaseFile, newerVersion } = options.contracts || require('./release-contract.cjs');
  let info = { current: app.getVersion(), latest: app.getVersion(), available: false, phase: 'idle', progress: 0 };
  let candidate, prepared, checkTask, downloadTask, controller, installing = false, disposed = false, paused = false;
  let startup, interval, lastAttempt = -Infinity;
  const directory = path.join(app.getPath('userData'), 'updates');
  const installerPath = file => path.join(directory, `installer-${file.version}-${file.sha256}.exe`);
  const sameFile = (a, b) => a?.version === b?.version && a?.sha256 === b?.sha256 && a?.size === b?.size;
  function publish(patch) {
    info = { ...info, ...patch };
    if (!disposed) options.onState?.({ ...info });
    return { ...info };
  }
  async function latest() {
    const response = await net.fetch(`${RELEASE_ORIGIN}/downloads/windows.json`, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Update check unavailable');
    // Bound the stream before allocating/parsing a manifest.
    if (!response.body) throw Error('Invalid update response');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 16384) throw Error('Invalid update response'); chunks.push(Buffer.from(chunk)); }
    return releaseFile(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'windows');
  }
  async function verified(file) {
    try {
      const installer = installerPath(file), stat = await fs.lstat(installer);
      if (!stat.isFile() || stat.size !== file.size) return false;
      const digest = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(installer)) { size += chunk.length; if (size > file.size) return false; digest.update(chunk); }
      return size === file.size && digest.digest('hex') === file.sha256;
    } catch { return false; }
  }
  async function download(file) {
    const installer = installerPath(file), partial = installer + '.download';
    controller = new AbortController(); paused = false;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60000)]);
    try {
      if (await verified(file)) { prepared = file; publish({ phase: 'ready', progress: 100 }); return; }
      prepared = undefined;
      await fs.mkdir(directory, { recursive: true });
      await fs.rm(partial, { force: true });
      publish({ phase: 'downloading', progress: 0 });
      const response = await net.fetch(file.url, { credentials: 'omit', redirect: 'error', signal });
      if (!response.ok || Number(response.headers.get('content-length')) !== file.size || !response.body) throw Error('Update download unavailable');
      const output = await fs.open(partial, 'wx'), digest = createHash('sha256'); let size = 0, progress = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted(); size += chunk.length; if (size > file.size) throw Error('Invalid update size');
          digest.update(chunk); await output.writeFile(chunk);
          const next = Math.min(99, Math.floor(size * 100 / file.size));
          if (next !== progress) { progress = next; publish({ progress }); }
        }
      } finally { await output.close(); }
      signal.throwIfAborted();
      if (size !== file.size || digest.digest('hex') !== file.sha256) throw Error('Update verification failed');
      await fs.rm(installer, { force: true }); await fs.rename(partial, installer);
      prepared = file; publish({ phase: 'ready', progress: 100 });
      // Retain only this app-owned installer; never touch profile/preferences.
      for (const name of await fs.readdir(directory)) if (/^installer-\d+\.\d+\.\d+-[a-f0-9]{64}\.exe(?:\.download)?$/.test(name) && name !== path.basename(installer)) await fs.rm(path.join(directory, name), { force: true }).catch(() => {});
    } catch (error) {
      publish({ phase: paused ? 'available' : 'error', progress: 0 }); throw error;
    } finally { await fs.rm(partial, { force: true }); controller = undefined; }
  }
  function prepare(file = candidate) {
    if (downloadTask) return downloadTask;
    if (disposed) return Promise.reject(Error('Updater stopped'));
    if (!file || !newerVersion(file.version, app.getVersion())) return Promise.reject(Error('This app is already up to date'));
    downloadTask = download(file).finally(() => {
      downloadTask = undefined;
      // A very short call may end before cancellation has drained the stream.
      if (paused) autoDownload();
    });
    return downloadTask;
  }
  function autoDownload() {
    if (options.autoDownload && !disposed && !installing && candidate && info.phase !== 'ready' && (!options.canDownload || options.canDownload())) void prepare().catch(() => {});
  }
  function check() {
    if (checkTask) return checkTask;
    if (downloadTask || installing || disposed) return Promise.resolve({ ...info });
    lastAttempt = Date.now();
    checkTask = (async () => {
      try {
        const file = await latest();
        if (disposed) return { ...info };
        candidate = newerVersion(file.version, app.getVersion()) ? file : undefined;
        if (!sameFile(candidate, prepared)) prepared = undefined;
        publish({ latest: file.version, available: Boolean(candidate), phase: candidate ? (prepared ? 'ready' : 'available') : 'idle', progress: prepared ? 100 : 0 });
        autoDownload(); return { ...info };
      } catch (error) { if (info.phase !== 'ready') publish({ phase: 'error' }); throw error; }
    })().finally(() => { checkTask = undefined; });
    return checkTask;
  }
  async function install() {
    if (installing) throw Error('An update is already installing');
    if (disposed) throw Error('Updater stopped');
    if (options.canInstall && !options.canInstall()) throw Error('Disconnect voice before installing an update.');
    installing = true;
    try {
      if (checkTask) await checkTask;
      if (!candidate) candidate = await latest();
      if (!newerVersion(candidate.version, app.getVersion())) throw Error('This app is already up to date');
      publish({ latest: candidate.version, available: true });
      await prepare(candidate);
      // Rehash immediately before launch: a prepared file can have changed on disk.
      if (!await verified(candidate)) { prepared = undefined; throw Error('Update verification failed'); }
      if (disposed) throw Error('Updater stopped');
      if (options.canInstall && !options.canInstall()) throw Error('Disconnect voice before installing an update.');
      const child = (options.spawn || spawn)(installerPath(candidate), ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      publish({ phase: 'installing' });
      // Keep the lock until exit so a second click cannot launch another installer.
      const quit = setTimeout(() => app.quit(), 750); quit.unref?.(); return { started: true };
    } catch (error) { installing = false; publish({ phase: prepared ? 'ready' : 'error' }); throw error; }
  }
  function wake() {
    if (disposed) return;
    if (Date.now() - lastAttempt >= 5 * 60000) void check().catch(() => {}); else autoDownload();
  }
  function start() {
    if (startup || interval || disposed) return;
    startup = setTimeout(wake, 10000); startup.unref?.();
    interval = setInterval(wake, 3600000); interval.unref?.();
  }
  function pauseDownload() { paused = true; controller?.abort(); }
  function stop() { disposed = true; clearTimeout(startup); clearInterval(interval); controller?.abort(); }
  return { check, install, prepare, state: () => ({ ...info }), start, wake, pauseDownload, stop };
}
module.exports = { createUpdater };
