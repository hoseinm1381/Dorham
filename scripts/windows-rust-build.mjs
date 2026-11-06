import { spawnSync } from 'node:child_process';
import { readFile, mkdir, cp, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
if (process.platform !== 'win32') throw Error('Build this Windows application on Windows.');
const root=process.cwd(),project=path.join(root,'apps/windows-rust');
const version=(await readFile(path.join(project,'Cargo.toml'),'utf8')).match(/^version = "(\d+\.\d+\.\d+)"/m)?.[1];
if(!version)throw Error('Rust application version missing.');
const diagnostic=process.argv.includes('--diagnostic'), release=process.argv.includes('--release');
const variant=diagnostic?'rust-diagnostic':'rust';
const output=path.resolve(`artifacts/v${version}/${variant}/win-unpacked`),assets=path.join(output,'assets');
await mkdir(assets,{recursive:true});
const env={...process.env,DORHAM_FRONTEND_VERSION:version};
if(existsSync('.tools/rustup'))env.RUSTUP_HOME=path.resolve('.tools/rustup');
if(existsSync('.tools/cargo'))env.CARGO_HOME=path.resolve('.tools/cargo');
env.RUSTUP_TOOLCHAIN=env.DORHAM_RUST_TOOLCHAIN||'1.99.1-x86_64-pc-windows-gnu';
const target='x86_64-pc-windows-gnu';
const toolchain=path.join(env.RUSTUP_HOME||'', 'toolchains',env.RUSTUP_TOOLCHAIN);
const linker=path.join(toolchain,`lib/rustlib/${target}/bin/self-contained/x86_64-w64-mingw32-gcc.exe`);
const clang=path.resolve('.tools/llvm-mingw-20261020-ucrt-x86_64/bin');
if(existsSync(linker))env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=linker;
if(existsSync(path.join(clang,'x86_64-w64-mingw32-clang.exe'))){env.CC_x86_64_pc_windows_gnu=path.join(clang,'x86_64-w64-mingw32-clang.exe');env.AR_x86_64_pc_windows_gnu=path.join(clang,'llvm-ar.exe');}
env.CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS=`-C dlltool=${path.join(clang,'llvm-dlltool.exe')}`;
env.PATH=[path.dirname(linker),clang,path.join(env.CARGO_HOME||'','bin'),env.PATH].join(path.delimiter);
function run(executable,args){const result=spawnSync(executable,args,{env,stdio:'inherit',windowsHide:true});if(result.error)throw result.error;if(result.status!==0)throw Error(`Build command failed: ${args[0]}`);}
if(!process.argv.includes('--skip-web')){
  for(const script of ['icons','audio-assets','default-avatars','emoji-assets'])run(process.execPath,[`scripts/${script}.mjs`]);
  run(process.execPath,['node_modules/vite/bin/vite.js','build','--config','apps/web/vite.config.ts','--outDir',assets]);
  const html=await readFile(path.join(assets,'index.html'),'utf8');
  const csp="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http://localhost:* http://127.0.0.1:*; connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*; media-src 'self' blob: https: http://localhost:* http://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'none'";
  await writeFile(path.join(assets,'index.html'),html.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="'+csp+'"><meta name="referrer" content="no-referrer">'));
}
for(const name of ['overlay.html','overlay.css','overlay-renderer.js','icon.png'])await cp(`apps/desktop/${name}`,path.join(assets,name));
const cargo=existsSync(path.join(env.CARGO_HOME||'','bin/cargo.exe'))?path.join(env.CARGO_HOME,'bin/cargo.exe'):'cargo';
run(cargo,['build','--manifest-path',path.join(project,'Cargo.toml'),'--target',target,'--jobs','2',...(release?['--release']:[]),...(diagnostic?['--features','native-test']:[])]);
const binary=path.join(project,'target',target,release?'release':'debug','Dorham.exe');await cp(binary,path.join(output,'Dorham.exe'));
const registry=path.join(env.CARGO_HOME||'','registry/src');let loader;
for(const directory of await readdir(registry)){const entries=await readdir(path.join(registry,directory));const crate=entries.find(n=>n.startsWith('webview2-com-sys-0.39.'));if(crate){loader=path.join(registry,directory,crate,'x64/WebView2Loader.dll');break;}}
if(!loader)throw Error('Pinned WebView2 loader missing.');await cp(loader,path.join(output,'WebView2Loader.dll'));
// GNU Rust panic/unwind dependencies are redistributable toolchain libraries;
// no compiler, Electron, Node or WebView2 browser runtime is shipped.
for(const name of ['libgcc_s_seh-1.dll','libwinpthread-1.dll']){const file=path.join(toolchain,'bin',name);if(existsSync(file))await cp(file,path.join(output,name));}
const files={};async function inventory(dir){for(const name of(await readdir(dir)).sort()){const file=path.join(dir,name);if((await stat(file)).isDirectory())await inventory(file);else files[path.relative(output,file).split(path.sep).join('/')]=createHash('sha256').update(await readFile(file)).digest('hex');}}
await inventory(output);await writeFile(path.join(path.dirname(output),'RUST-BUILD.json'),JSON.stringify({version,runtime:'rust-webview2',diagnostic,release,files},null,2));
console.log(`Rust Windows ${version}: ${output}`);
