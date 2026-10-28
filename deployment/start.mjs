import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename, chmod, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const version = '24.22.1';
// Official https://nodejs.org/dist/v24.22.1/SHASUMS256.txt, verified 2026-10-28.
const checksums = {
  x64: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c',
  arm64: '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3'
};
const [major, minor, patch] = process.versions.node.split('.').map(Number);
if (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))) {
  await import(pathToFileURL(path.resolve('apps/api/dist/index.js')).href);
} else {
  if (process.platform !== 'linux' || !checksums[process.arch] || typeof process.execve !== 'function') throw new Error(`Use patched Node ${version} or newer within Node 24. Automatic bootstrap supports Linux x64/arm64.`);
  const expected = checksums[process.arch], cache = path.resolve('.cache', `node-v${version}-${process.arch}`);
  const binary = path.join(cache, 'node'), receipt = path.join(cache, 'verified.json');
  const digest = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
  let verified = false;
  try { const saved = JSON.parse(await readFile(receipt, 'utf8')); verified = saved.archiveSha256 === expected && saved.binarySha256 === await digest(binary); } catch { /* Install a missing or incomplete cache. */ }
  if (!verified) {
    await mkdir(cache, { recursive: true }); const staging = await mkdtemp(path.join(cache, 'install-'));
    const archive = path.join(staging, 'node.tar.gz'), extracted = path.join(staging, 'node');
    try {
      const name = `node-v${version}-linux-${process.arch}`;
      console.log(`Installing checksum-verified Node ${version} in the persistent runtime cache.`);
      const response = await fetch(`https://nodejs.org/dist/v${version}/${name}.tar.gz`, { signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`Node runtime download failed: ${response.status}`);
      const hash = createHash('sha256'); let bytes = 0;
      const verify = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; if (bytes > 120 * 1048576) return done(new Error('Node archive exceeded its download budget.')); hash.update(chunk); done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(archive, { flags: 'wx' }));
      if (hash.digest('hex') !== expected) throw new Error('Node runtime checksum mismatch.');
      const unpack = spawnSync('tar', ['-xzf', archive, '--directory', staging, '--strip-components=2', `${name}/bin/node`], { stdio: 'inherit', timeout: 30000 });
      if (unpack.status !== 0) throw new Error('Node runtime extraction failed.');
      await chmod(extracted, 0o755); const binarySha256 = await digest(extracted); await rename(extracted, binary);
      await writeFile(receipt, JSON.stringify({ version, archiveSha256: expected, binarySha256 }), { mode: 0o600 });
    } finally {
      // Only remove files created in this fresh staging directory; never user data.
      await unlink(archive).catch(() => {}); await unlink(extracted).catch(() => {}); await rmdir(staging).catch(() => {});
    }
  }
  // Replace the bootstrap process so the application receives shutdown signals directly.
  process.execve(binary, [binary, '--env-file-if-exists=.env', path.resolve('apps/api/dist/index.js')], process.env);
}
