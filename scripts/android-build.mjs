import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, cp, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), version = JSON.parse(await readFile('package.json', 'utf8')).version, output = process.env.DORHAM_ANDROID_OUTPUT || `artifacts/android-${version}`;
if (!existsSync('apps/web/dist/index.html')) throw new Error('Run npm run build:web first.');
const env = { ...process.env };
const debug = process.argv.includes('--debug');
if (!debug && (!env.DORHAM_KEYSTORE || !env.DORHAM_STORE_PASSWORD || !env.DORHAM_KEY_PASSWORD)) throw Error('Release signing credentials are required. Use --debug only for an explicit test build.');
if (existsSync('.tools/jdk')) { const local = (await readdir('.tools/jdk')).find(n => n.startsWith('jdk-21')); if (local) env.JAVA_HOME = path.resolve('.tools/jdk', local); }
if (existsSync('.tools/android-sdk36/platforms')) env.ANDROID_HOME = path.resolve('.tools/android-sdk36');
if (!env.JAVA_HOME || !existsSync(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) throw new Error('Set JAVA_HOME to JDK 21.');
if (!env.ANDROID_HOME) throw new Error('Set ANDROID_HOME to an SDK with Android 36 and build-tools 36.0.0.');
let result = spawnSync(process.execPath, [path.join(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], { cwd: path.join(root, 'apps/android'), env, stdio: 'inherit' }); if (result.status) process.exit(result.status);
const args = ['--no-daemon', '--max-workers=1', '--stacktrace'];
const localGradle = path.join(root, '.tools/gradle/gradle-8.14.3/bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
const gradle = existsSync(localGradle) ? localGradle : process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
// Separate compiler processes release their heap before compiling the other variant.
for (const target of [debug ? 'assembleDebug' : 'assembleRelease']) {
  result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : gradle, process.platform === 'win32' ? ['/d', '/s', '/c', gradle, ...args, target] : [...args, target], { cwd: path.join(root, 'apps/android/android'), env, stdio: 'inherit' }); if (result.status) process.exit(result.status);
}
await mkdir(output, { recursive: true });
const kind = debug ? 'debug' : 'release';
const apk = `apps/android/android/app/build/outputs/apk/${kind}/app-${kind}.apk`;
if (!existsSync(apk)) throw Error('Signed APK output is missing.');
const metadata = JSON.parse(await readFile(`apps/android/android/app/build/outputs/apk/${kind}/output-metadata.json`, 'utf8'));
if (metadata.applicationId !== 'com.dorham.chat' || metadata.elements[0].versionName !== version) throw Error('APK identity/version mismatch.');
const signer = path.join(env.ANDROID_HOME, 'build-tools', '36.0.0', process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : signer, process.platform === 'win32' ? ['/d', '/s', '/c', signer, 'verify', '--verbose', '--print-certs', path.resolve(apk)] : ['verify', '--verbose', '--print-certs', apk], { env, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
await cp(apk, path.join(output, `Dorham-${version}-Android${debug ? '-debug' : ''}.apk`));
console.log(debug ? 'Explicit debug APK built.' : 'Signed release APK verified and copied. Keep the permanent signing key for every future update.');
