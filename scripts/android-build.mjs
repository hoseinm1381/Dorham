import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
if (!existsSync('apps/web/dist/index.html')) throw new Error('Run npm run build:web first.');
const env = { ...process.env };
if (existsSync('.tools/jdk')) { const local = (await readdir('.tools/jdk')).find(n => n.startsWith('jdk-21')); if (local) env.JAVA_HOME = path.resolve('.tools/jdk', local); }
if (existsSync('.tools/android-sdk36/platforms')) env.ANDROID_HOME = path.resolve('.tools/android-sdk36');
if (!env.JAVA_HOME || !existsSync(path.join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) throw new Error('Set JAVA_HOME to JDK 21.');
if (!env.ANDROID_HOME) throw new Error('Set ANDROID_HOME to an SDK with Android 36 and build-tools 36.0.0.');
let result = spawnSync(process.execPath, [path.join(root, 'node_modules/@capacitor/cli/bin/capacitor'), 'sync', 'android'], { cwd: path.join(root, 'apps/android'), env, stdio: 'inherit' }); if (result.status) process.exit(result.status);
const args = ['--no-daemon', '--max-workers=1', '--stacktrace'];
const localGradle = path.join(root, '.tools/gradle/gradle-8.14.3/bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
const gradle = existsSync(localGradle) ? localGradle : process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
// Separate compiler processes release their heap before compiling the other variant.
for (const target of ['assembleRelease', 'assembleDebug']) {
  result = spawnSync(process.platform === 'win32' ? 'cmd.exe' : gradle, process.platform === 'win32' ? ['/d', '/s', '/c', gradle, ...args, target] : [...args, target], { cwd: path.join(root, 'apps/android/android'), env, stdio: 'inherit' }); if (result.status) process.exit(result.status);
}
await mkdir('artifacts/android', { recursive: true });
for (const kind of ['release', 'debug']) { const dir = `apps/android/android/app/build/outputs/apk/${kind}`; if (existsSync(dir)) for (const file of await readdir(dir)) if (file.endsWith('.apk')) await cp(path.join(dir, file), `artifacts/android/Dorham-0.1.0-${file}`); }
console.log('APK outputs copied to artifacts/android. A debug APK is installable; a release APK needs DORHAM_KEYSTORE signing credentials.');
