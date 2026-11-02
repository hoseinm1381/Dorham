import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), asar = require('@electron/asar'), yauzl = require('yauzl');
const root = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2] || JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const directory = path.resolve(process.env.DORHAM_NATIVE_RELEASE_DIR || path.join(root, `artifacts/v${version}`));
const windowsDir = path.join(directory, 'windows'), asarPath = path.join(windowsDir, 'win-unpacked/resources/app.asar');
const installer = path.join(windowsDir, `Dorham-${version}-Windows-x64.exe`);
const apk = path.join(directory, `android/Dorham-${version}-Android.apk`);
const baselineAPK = path.resolve(process.env.DORHAM_PREVIOUS_APK || path.join(root, 'artifacts/v1.0.6/android/Dorham-1.0.6-Android.apk'));
const evidence = path.join(root, `artifacts/evidence/v${version.replaceAll('.','')}-native-payload-independent.json`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const archiveName = name => name.split('/').join(path.sep);
const archiveFile = name => asar.extractFile(asarPath, archiveName(name));
async function fileSHA(file) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
async function files(dir, prefix = '') { const out = []; for (const name of (await readdir(dir)).sort()) { const relative = prefix + name; if ((await stat(path.join(dir, name))).isDirectory()) out.push(...await files(path.join(dir, name), relative + '/')); else out.push(relative); } return out; }
async function apkEntries(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error); const result = new Map(); zip.on('error', reject); zip.on('end', () => resolve(result));
    zip.on('entry', entry => {
      if (entry.fileName.endsWith('/')) return zip.readEntry();
      if (!entry.fileName.startsWith('assets/public/') && !entry.fileName.startsWith('lib/')) return zip.readEntry();
      zip.openReadStream(entry, (error, stream) => { if (error) { zip.close(); return reject(error); } const chunks = []; stream.on('data', bytes => chunks.push(bytes)); stream.on('error', reject); stream.on('end', () => { result.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); }); });
    }); zip.readEntry();
  }));
}
function run(command, args, env = process.env) {
  const bat = command.endsWith('.bat');
  const result = spawnSync(bat ? 'cmd.exe' : command, bat ? ['/d','/s','/c',command,...args] : args, { env, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(command)} failed: ${result.stderr}`); return result.stdout;
}
const report = { version, checkedAtUTC: new Date().toISOString(), status: 'failed', packageStaticChecks: {}, physicalAcceptance: 'Not performed by this script. Install-over-existing, retained login, real microphone/speaker and OS clipboard need device acceptance.', files: {} };
try {
  const webFiles = await files(path.join(root, 'apps/web/dist'));
  const archiveFiles = asar.listPackage(asarPath).map(name => name.replaceAll('\\','/').replace(/^\//,''));
  const desktopWeb = archiveFiles.filter(name => name.startsWith('dist/') && !asar.statFile(asarPath, archiveName(name)).files).map(name => name.slice(5)).sort();
  assert.deepEqual(desktopWeb, [...webFiles].sort());
  for (const file of webFiles) assert.equal(sha(archiveFile('dist/' + file)), await fileSHA(path.join(root, 'apps/web/dist', file)), `Windows web bytes: ${file}`);
  const pkg = JSON.parse(archiveFile('package.json').toString()); assert.equal(pkg.version, version);
  assert.equal(pkg.name, '@dorham/desktop');
  for (const name of ['main.cjs','capture-origin.cjs','preload.cjs','updater.cjs','release-contract.cjs','voice-overlay.cjs','voice-hotkeys.cjs','voice-keys.json','overlay-preload.cjs','overlay.html','overlay.css','overlay-renderer.js','native/VoiceHotkey.exe']) {
    assert.equal(sha(archiveFile(name)), await fileSHA(path.join(root, 'apps/desktop', name)), `Windows native bytes: ${name}`);
  }
  report.packageStaticChecks.windowsVersion = pkg.version;
  report.packageStaticChecks.windowsWebFilesExact = webFiles.length;
  report.packageStaticChecks.windowsNativeModulesExact = true;
  report.packageStaticChecks.windowsPublisherSignature = 'Unsigned by operator choice; signature identity is not claimed.';
  const apkFiles = await apkEntries(apk);
  const extras = [...apkFiles.keys()].filter(name => name.startsWith('assets/public/') && !webFiles.includes(name.slice('assets/public/'.length)));
  assert.ok(extras.every(name => ['capacitor.js','capacitor.plugins.json','cordova.js','cordova_plugins.js'].includes(name.slice('assets/public/'.length))), `Unexpected Android web files: ${extras}`);
  for (const file of webFiles) { const bytes = apkFiles.get('assets/public/' + file); assert.ok(bytes, `APK web file missing: ${file}`); assert.equal(sha(bytes), await fileSHA(path.join(root, 'apps/web/dist', file)), `Android web bytes: ${file}`); }
  report.packageStaticChecks.androidWebFilesExact = webFiles.length;
  report.packageStaticChecks.androidCapacitorGeneratedExtraFiles = extras;
  const native64 = [];
  for (const [name, bytes] of apkFiles) {
    if (!name.startsWith('lib/') || !name.endsWith('.so') || bytes[4] !== 2) continue;
    assert.equal(bytes[5], 1, `Expected little-endian ELF: ${name}`);
    const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
    const loads = []; for (let i=0;i<count;i++) { const position=offset+i*size; if (bytes.readUInt32LE(position) === 1) loads.push(Number(bytes.readBigUInt64LE(position+48))); }
    assert.ok(loads.length > 0 && loads.every(alignment => alignment >= 16384), `ELF load alignment below 16KiB: ${name}`); native64.push(name);
  }
  report.packageStaticChecks.android64BitELF16KiB = native64;
  const localSDK = path.join(root, '.tools/android-sdk36');
  const sdk = process.env.DORHAM_ANDROID_SDK || (existsSync(localSDK) ? localSDK : process.env.ANDROID_HOME);
  assert.ok(sdk, 'Android SDK is required for package verification.');
  const tools = path.join(sdk, 'build-tools', '36.0.0'), extension = process.platform === 'win32' ? '.exe' : '';
  const env = { ...process.env };
  if (process.env.DORHAM_JAVA_HOME) env.JAVA_HOME = process.env.DORHAM_JAVA_HOME;
  if ((!env.JAVA_HOME || !existsSync(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) && existsSync(path.join(root, '.tools/jdk'))) { const jdk=(await readdir(path.join(root, '.tools/jdk'))).find(name=>name.startsWith('jdk-21')); if(jdk)env.JAVA_HOME=path.join(root,'.tools/jdk',jdk); }
  const signer = path.join(tools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  const sign = run(signer, ['verify','--verbose','--print-certs',apk], env);
  const priorSign = run(signer, ['verify','--print-certs',baselineAPK], env);
  const cert = text => text.match(/Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase();
  assert.match(cert(sign) || '', /^[a-f0-9]{64}$/); assert.equal(cert(sign), cert(priorSign));
  const metadata = run(path.join(tools, 'aapt'+extension), ['dump','badging',apk],env);
  const priorMetadata = run(path.join(tools, 'aapt'+extension), ['dump','badging',baselineAPK],env);
  assert.match(metadata, /package: name='com\.dorham\.chat'/); assert.ok(metadata.includes(`versionName='${version}'`));
  const versionCode = Number(metadata.match(/versionCode='(\d+)'/)?.[1]);
  const [major,minor,patch]=version.split('.').map(Number); assert.equal(versionCode,major*1000000+minor*1000+patch);
  assert.ok(versionCode > Number(priorMetadata.match(/versionCode='(\d+)'/)?.[1]));
  run(path.join(tools,'zipalign'+extension),['-c','-P','16','4',apk],env);
  Object.assign(report.packageStaticChecks,{applicationId:'com.dorham.chat',androidVersionCode:versionCode,androidSignatureVerified:true,androidSameSignerAsPreviousAPK:true,androidSignerSHA256:cert(sign),androidZip16KiBAligned:true});
  for(const file of [installer,asarPath,apk])report.files[path.relative(root,file).split(path.sep).join('/')]={bytes:(await stat(file)).size,sha256:await fileSHA(file)};
  report.status='passed';
} catch(error) {report.error=String(error.stack||error);process.exitCode=1;}
finally {await mkdir(path.dirname(evidence),{recursive:true});await writeFile(evidence,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,version,evidence,error:report.error||null}));}
