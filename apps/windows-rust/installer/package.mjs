import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir, mkdtemp, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(directory, '../../..');
if (process.platform !== 'win32') throw Error('Build this existing-identity NSIS installer on Windows.');
const payloadArg = process.argv.indexOf('--payload'), outputArg = process.argv.indexOf('--output');
if (payloadArg < 0 || !process.argv[payloadArg+1]) throw Error('Pass --payload <prepared Rust runtime directory containing Dorham.exe>.');
const payload = path.resolve(process.argv[payloadArg+1]);
const metadata = JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
const tauri = process.argv.includes('--tauri');
const version = tauri
  ? JSON.parse(await readFile(path.join(root, 'apps/desktop-tauri/tauri.conf.json'), 'utf8')).version
  : metadata.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid Rust release version.');
const output = outputArg < 0 ? path.join(root,`artifacts/v${version}/windows`) : path.resolve(process.argv[outputArg+1]);
if (!existsSync(path.join(payload,'Dorham.exe'))) throw Error('Prepared Rust payload must contain Dorham.exe.');
for (const legacy of ['resources/app.asar','icudtl.dat','chrome_100_percent.pak','v8_context_snapshot.bin']) if (existsSync(path.join(payload,legacy))) throw Error(`Electron runtime must not be shipped in the Rust payload: ${legacy}`);
const bootstrapper = path.resolve(process.env.DORHAM_WEBVIEW_BOOTSTRAPPER || path.join(root,'.tools/webview2/MicrosoftEdgeWebview2Setup.exe'));
if (!existsSync(bootstrapper)) throw Error('Provide the official signed Microsoft Evergreen WebView2 bootstrapper via DORHAM_WEBVIEW_BOOTSTRAPPER. See installer/README.md.');
const env = { ...process.env, DORHAM_WEBVIEW_BOOTSTRAPPER: bootstrapper, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
const signer = process.env.DORHAM_WINDOWS_SIGNER_THUMBPRINT;
function signFile(file) {
  if (!signer) return;
  const tool = process.env.DORHAM_WINDOWS_SIGNTOOL;
  const timestamp = process.env.DORHAM_WINDOWS_TIMESTAMP_URL;
  if (!/^[a-f0-9]{40}$/i.test(signer) || !tool || !existsSync(tool) || !timestamp || !/^https?:\/\//i.test(timestamp)) {
    throw Error('Configure SignTool, the code-signing certificate thumbprint, and an RFC 3161 timestamp URL.');
  }
  for (const args of [['sign', '/sha1', signer, '/fd', 'SHA256', '/tr', timestamp, '/td', 'SHA256', file], ['verify', '/pa', '/tw', file]]) {
    const result = spawnSync(tool, args, { windowsHide: true, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error('Windows signing or timestamp verification failed.');
  }
}
if (tauri) {
  for (const name of ['VoiceHotkey.exe', 'CaptureVideo.exe', 'ShareAudio.exe']) {
    if (!existsSync(path.join(payload, 'native', name))) throw Error(`Tauri payload is missing ${name}`);
  }
  env.DORHAM_PROFILE_VALIDATOR = path.join(payload, 'Dorham.exe');
  for (const name of ['VoiceHotkey.exe', 'CaptureVideo.exe', 'ShareAudio.exe']) signFile(path.join(payload, 'native', name));
}
signFile(path.join(payload, 'Dorham.exe'));
const checkSignature = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'); $s=Get-AuthenticodeSignature -LiteralPath $env:DORHAM_WEBVIEW_BOOTSTRAPPER; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Official WebView2 bootstrapper signature verification failed.'}"],{env,windowsHide:true,encoding:'utf8',timeout:30000});
if(checkSignature.error)throw checkSignature.error;
if(checkSignature.status!==0)throw Error(checkSignature.stderr || 'WebView2 bootstrapper signature verification failed.');
const nsis = path.resolve(process.env.DORHAM_NSIS_BUNDLE || path.join(root, '.tools/nsis/nsis-bundle'));
if (existsSync(path.join(nsis, 'makensis.cmd'))) {
  env.ELECTRON_BUILDER_NSIS_DIR = nsis;
  env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsis;
}
await mkdir(output,{recursive:true});
const resources = await mkdtemp(path.join(path.dirname(output), 'nsis-resources-'));
for (const name of ['migration.nsh', 'migrate-electron.ps1', 'export-electron.cjs', 'protect-export.ps1']) {
  await copyFile(path.join(directory, name), path.join(resources, name));
}
const arguments_ = [path.join(root,'node_modules/electron-builder/cli.js'),'--config',path.join(directory,'electron-builder.yml'),'--prepackaged',payload,'--win','nsis','--x64',`--config.directories.output=${output}`,`--config.directories.buildResources=${resources}`,`--config.extraMetadata.version=${version}`];
const result = spawnSync(process.execPath,arguments_,{cwd:root,env,windowsHide:true,stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
signFile(path.join(output, `Dorham-${version}-Windows-x64.exe`));
const hashes={};
async function inventory(dir,prefix=''){for(const name of(await readdir(dir)).sort()){const relative=prefix+name,file=path.join(dir,name);if((await stat(file)).isDirectory())await inventory(file,relative+'/');else hashes[relative]=createHash('sha256').update(await readFile(file)).digest('hex');}}
await inventory(payload);
await writeFile(path.join(output,'RUST-PAYLOAD.json'),JSON.stringify({version,runtime:tauri?'tauri-webview2':'rust-webview2',appId:'com.dorham.chat',nsisGuid:'26094eeb-aead-5f8d-b988-ece04b473a4b',files:hashes},null,2));
console.log(`Built existing-identity Rust installer in ${output}; no installation was performed.`);
