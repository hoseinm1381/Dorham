import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
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
const version = metadata.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid Rust release version.');
const output = outputArg < 0 ? path.join(root,`artifacts/v${version}/windows`) : path.resolve(process.argv[outputArg+1]);
if (!existsSync(path.join(payload,'Dorham.exe'))) throw Error('Prepared Rust payload must contain Dorham.exe.');
for (const legacy of ['resources/app.asar','icudtl.dat','chrome_100_percent.pak','v8_context_snapshot.bin']) if (existsSync(path.join(payload,legacy))) throw Error(`Electron runtime must not be shipped in the Rust payload: ${legacy}`);
const bootstrapper = path.resolve(process.env.DORHAM_WEBVIEW_BOOTSTRAPPER || path.join(root,'.tools/webview2/MicrosoftEdgeWebview2Setup.exe'));
if (!existsSync(bootstrapper)) throw Error('Provide the official signed Microsoft Evergreen WebView2 bootstrapper via DORHAM_WEBVIEW_BOOTSTRAPPER. See installer/README.md.');
const env = { ...process.env, DORHAM_WEBVIEW_BOOTSTRAPPER: bootstrapper, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
const checkSignature = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:DORHAM_WEBVIEW_BOOTSTRAPPER; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation'){throw 'Official WebView2 bootstrapper signature verification failed.'}"],{env,windowsHide:true,encoding:'utf8',timeout:30000});
if(checkSignature.error)throw checkSignature.error;
if(checkSignature.status!==0)throw Error(checkSignature.stderr || 'WebView2 bootstrapper signature verification failed.');
if(existsSync(path.join(root,'.tools/nsis/nsis-bundle/makensis.cmd'))){env.ELECTRON_BUILDER_NSIS_DIR=path.join(root,'.tools/nsis/nsis-bundle');env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR=env.ELECTRON_BUILDER_NSIS_DIR;}
await mkdir(output,{recursive:true});
const arguments_ = [path.join(root,'node_modules/electron-builder/cli.js'),'--config',path.join(directory,'electron-builder.yml'),'--prepackaged',payload,'--win','nsis','--x64',`--config.directories.output=${output}`,`--config.extraMetadata.version=${version}`];
const result = spawnSync(process.execPath,arguments_,{cwd:root,env,windowsHide:true,stdio:'inherit'});
if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);
const hashes={};
async function inventory(dir,prefix=''){for(const name of(await readdir(dir)).sort()){const relative=prefix+name,file=path.join(dir,name);if((await stat(file)).isDirectory())await inventory(file,relative+'/');else hashes[relative]=createHash('sha256').update(await readFile(file)).digest('hex');}}
await inventory(payload);
await writeFile(path.join(output,'RUST-PAYLOAD.json'),JSON.stringify({version,runtime:'rust-webview2',appId:'com.dorham.chat',nsisGuid:'26094eeb-aead-5f8d-b988-ece04b473a4b',files:hashes},null,2));
console.log(`Built existing-identity Rust installer in ${output}; no installation was performed.`);
