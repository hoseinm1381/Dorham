import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const root = process.cwd(), bundle = path.resolve(`artifacts/server-${version}`);
if (!existsSync(path.join(bundle, 'apps/api/dist/index.js'))) throw new Error('Run npm run deploy:bundle first.');
function git(args, env = process.env, cwd = root) {
  const result = spawnSync('git', args, { env, cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}
const source = git(['rev-parse', 'HEAD']), gitDirectory = path.resolve(git(['rev-parse', '--git-dir']));
mkdirSync('.tools', { recursive: true });
const env = { ...process.env, GIT_DIR: gitDirectory, GIT_WORK_TREE: bundle, GIT_INDEX_FILE: path.resolve('.tools/server-bundle.index') };
git(['read-tree', '--empty'], env); git(['add', '--all'], env, bundle);
const tree = git(['write-tree'], env), ref = 'refs/heads/codex/server-bundle';
let previous = ''; try { previous = git(['rev-parse', '--verify', ref]); } catch { /* first deployment */ }
const commit = git(['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-m', `Deploy prebuilt Dorham from source ${source}`], env);
git(['update-ref', ref, commit, previous || '0'.repeat(40)]);
console.log(`Prepared codex/server-bundle ${commit}: prebuilt web/API and production-only dependency lock; source ${source}.`);
