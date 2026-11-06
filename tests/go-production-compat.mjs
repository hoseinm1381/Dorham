import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Synthetic accounts, temporary databases and loopback listeners only. No .env
// is inherited by the child and its cwd is a fresh private temporary directory.
// Optional DORHAM_GO_BINARY selects an existing untagged native binary;
// DORHAM_GO_LINUX_BINARY selects the Linux artifact inspected for fixture code.
// Otherwise this script builds production binaries using DORHAM_GO, the local
// verified compiler, or Go on PATH. CGO and test build tags are never enabled.
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.resolve(process.env.DORHAM_GO_COMPAT_EVIDENCE || path.join(root, 'artifacts/evidence/v110-independent-production-pg-review.json'));
const buildDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-v110-compat-build-'));
let binary, linuxBinary;
const report = { checkedAt: new Date().toISOString(), checks: {}, limitations: ['Private loopback production-mode process; TLS termination itself remains a deployment check.', 'PostgreSQL uses the genuine PostgreSQL WASM engine and real pgx TCP adapter, not a full PostgreSQL service/load test.', 'Owned child terminated after tests; graceful Linux shutdown is covered separately.'] };
function productionBuild(targetOS, output) {
  const localCompiler = path.join(root, '.tools/go-toolchain/go/bin', process.platform === 'win32' ? 'go.exe' : 'go');
  const compiler = process.env.DORHAM_GO || (existsSync(localCompiler) ? localCompiler : 'go');
  const env = { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOOS: targetOS, GOARCH: 'amd64',
    GOMODCACHE: process.env.GOMODCACHE || path.join(root, '.tools/go-modules'),
    GOCACHE: process.env.GOCACHE || path.join(root, '.tools/go-build-cache'),
    GOPATH: process.env.GOPATH || path.join(root, '.tools/go-path') };
  // Explicit arguments override inherited GOFLAGS so a tagged fixture cannot
  // accidentally masquerade as the production binary under test.
  const result = spawnSync(compiler, ['build', '-mod=readonly', '-tags=', '-trimpath', '-buildvcs=false', '-o', output, './cmd/dorham'], { cwd: path.join(root, 'apps/api-go'), env, windowsHide: true, encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Production ${targetOS} build failed: ${result.stderr}`);
}
function pass(name, value = true) { assert.ok(value, name); report.checks[name] = true; }
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
async function launch(databaseUrl = '') {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'dorham-v110-independent-'));
  const port = await freePort();
  const env = Object.fromEntries(['SystemRoot','SYSTEMROOT','WINDIR','PATH','TEMP','TMP','USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { NODE_ENV: 'production', HOST: '127.0.0.1', SERVER_PORT: String(port), DATA_DIR: dataDir, DATABASE_URL: databaseUrl,
    PUBLIC_URL: 'https://dorhamapp.ir', ALLOWED_ORIGINS: 'https://dorhamapp.ir,https://localhost,capacitor://localhost,dorham://app', COOKIE_SECURE: 'true',
    MEDIA_TRANSPORT: 'mesh', REGISTRATION_OPEN: 'true', UPLOAD_FREE_RESERVE_MIB: '1', TTS_IDLE_SECONDS: '180' });
  const child = spawn(binary, [], { cwd: dataDir, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b.toString(); });
  let exited = false; child.once('exit', () => { exited = true; });
  const base = `http://127.0.0.1:${port}`;
  async function request(route, { method = 'GET', body, origin = 'https://dorhamapp.ir', native, session, headers = {} } = {}) {
    if (origin) headers.Origin = origin;
    if (native) headers['X-Dorham-Native'] = '1';
    if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
    if (session?.cookie) headers.Cookie = session.cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + route, { method, body: body === undefined ? undefined : JSON.stringify(body), headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { /* Static/denial responses need not be JSON. */ }
    return { status: res.status, json, headers: res.headers, text };
  }
  async function stop() { if (!exited) { const end = once(child, 'exit'); child.kill(); await end; } await rm(dataDir, { recursive: true, force: true }); }
  try {
    const deadline = Date.now() + 20000;
    while (true) {
      if (exited) throw new Error(`CLI exited before ready: ${stderr}`);
      try { const ready = await request('/ready'); if (ready.status === 200) break; } catch { /* Wait for the owned child to bind its loopback port. */ }
      if (Date.now() > deadline) throw new Error(`CLI readiness timeout: ${stderr}`);
      await new Promise(r => setTimeout(r, 50));
    }
  } catch (error) { await stop(); throw error; }
  return { request, stop, child, base, stderr: () => stderr };
}
async function register(app, username, native = true, origin) {
  const res = await app.request('/api/v1/auth/register', { method: 'POST', native, origin, body: { username, password: 'Synthetic-private-password-84', displayName: username, requestId: randomUUID() } });
  assert.equal(res.status, 201, res.text); return { ...res.json, cookie: res.headers.get('set-cookie')?.split(';')[0], response: res };
}
let app, engine, pgServer;
try {
  if (!['win32','linux'].includes(process.platform) || process.arch !== 'x64') throw Error('Run this production compatibility check on Windows/Linux x86-64.');
  binary = process.env.DORHAM_GO_BINARY ? path.resolve(process.env.DORHAM_GO_BINARY) : path.join(buildDir, process.platform === 'win32' ? 'dorham-production.exe' : 'dorham-production-linux-amd64');
  linuxBinary = process.env.DORHAM_GO_LINUX_BINARY ? path.resolve(process.env.DORHAM_GO_LINUX_BINARY) : process.platform === 'linux' ? binary : path.join(buildDir, 'dorham-production-linux-amd64');
  if (!process.env.DORHAM_GO_BINARY) productionBuild(process.platform === 'win32' ? 'windows' : 'linux', binary);
  if (!process.env.DORHAM_GO_LINUX_BINARY && linuxBinary !== binary) productionBuild('linux', linuxBinary);
  report.productionBinary = binary;
  report.sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  for (const [label, file] of [['native production', binary], ['Linux production', linuxBinary]]) {
    const bytes = await readFile(file);
    for (const marker of ['DORHAM_FIXTURE_NONCE', '/__fixture/', 'FixtureControls']) pass(`${label} excludes ${marker}`, !bytes.includes(Buffer.from(marker)));
  }
  app = await launch();
  const browser = await register(app, 'review_web', false);
  const cookie = browser.response.headers.get('set-cookie');
  pass('browser cookie Secure/HttpOnly/Lax', /; Secure(?:;|$)/.test(cookie) && /; HttpOnly(?:;|$)/.test(cookie) && /SameSite=Lax/.test(cookie));
  pass('browser response does not expose bearer or refresh', !browser.accessToken && !browser.refreshToken);
  const csp = browser.response.headers.get('content-security-policy');
  pass('production CSP only secure network schemes', csp.includes("connect-src 'self' https: wss:") && !csp.includes(' http:') && !csp.includes(' ws:'));
  const noCsrf = await app.request('/api/v1/profile', { method: 'PATCH', session: browser, body: { bio: 'should fail', requestId: randomUUID() } });
  pass('browser mutation without CSRF denied', noCsrf.status === 403 && noCsrf.json.error.code === 'CSRF');
  const yesCsrf = await app.request('/api/v1/profile', { method: 'PATCH', session: browser, headers: { 'X-CSRF-Token': browser.csrf }, body: { displayName: 'review_web', status: 'online', bio: 'csrf verified', requestId: randomUUID() } });
  pass('browser mutation with CSRF succeeds', yesCsrf.status === 200);
  pass('hostile origin rejected', (await app.request('/api/v1/auth/me', { session: browser, origin: 'https://dorhamapp.ir.attacker.invalid' })).status === 403);
  pass('absent origin cannot bypass browser CSRF', (await app.request('/api/v1/profile', { method: 'PATCH', session: browser, origin: '', headers: { 'X-CSRF-Token': browser.csrf }, body: { bio: 'must fail', requestId: randomUUID() } })).status === 403);
  for (const [index, origin] of ['https://localhost','capacitor://localhost','dorham://app'].entries()) {
    const native = await register(app, `review_native_${index}`, true, origin);
    pass(`native protocol ${origin} bearer/refresh no cookie`, native.accessToken && native.refreshToken && !native.cookie);
    pass(`native protocol ${origin} bearer authenticates`, (await app.request('/api/v1/auth/me', { session: native, origin })).status === 200);
  }
  for (const route of ['/__fixture/sql', '/__fixture/control', '/internal/__fixture/sql']) {
    const response = await app.request(route, { method: 'POST', body: { sql: 'SELECT 1', nonce: 'irrelevant' } });
    pass(`production rejects fixture route ${route}`, [404,405].includes(response.status));
  }
  await app.stop(); app = undefined;

  engine = await PGlite.create();
  pgServer = new PGLiteSocketServer({ db: engine, host: '127.0.0.1', port: 0, maxConnections: 4 }); await pgServer.start();
  let url = pgServer.getServerConn(); if (!url.startsWith('postgres')) url = `postgresql://postgres:postgres@${url}/postgres`;
  url += (url.includes('?') ? '&' : '?') + 'sslmode=disable';
  app = await launch(url);
  pass('Go production process actual PostgreSQL adapter ready', (await app.request('/ready')).json.database === 'postgres');
  const versions = await engine.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(versions.rows.map(row => row.version), Array.from({ length: 13 }, (_, i) => i+1)); pass('Go fresh PostgreSQL applied exactly schema migrations 1-13');
  pass('PostgreSQL global transaction lock row created', (await engine.query('SELECT id FROM global_locks')).rows.length === 1);
  const alice = await register(app, 'pg_review_alice'), bob = await register(app, 'pg_review_bravo');
  const login = await app.request('/api/v1/auth/login', { method: 'POST', native: true, body: { username: 'pg_review_alice', password: 'Synthetic-private-password-84', requestId: randomUUID() } });
  pass('Go PostgreSQL Argon2 login and session', login.status === 200 && !!login.json.accessToken);
  const dm = await app.request('/api/v1/dms', { method: 'POST', session: alice, body: { userId: bob.user.id, requestId: randomUUID() } }); assert.equal(dm.status, 200, dm.text);
  const sendBody = { conversationId: dm.json.id, content: 'PostgreSQL real pgx TCP سلام', requestId: randomUUID() };
  const first = await app.request('/api/v1/messages', { method: 'POST', session: alice, body: sendBody }); assert.equal(first.status, 200, first.text);
  const retry = await app.request('/api/v1/messages', { method: 'POST', session: alice, body: sendBody }); assert.deepEqual(retry.json, first.json); pass('Go PostgreSQL mutation receipt exact replay');
  const conflict = await app.request('/api/v1/messages', { method: 'POST', session: alice, body: { ...sendBody, content: 'different body' } }); pass('Go PostgreSQL changed mutation payload rejected', conflict.status === 409);
  const history = await app.request(`/api/v1/conversations/${dm.json.id}/messages`, { session: bob }); pass('Go PostgreSQL DM history persisted Unicode exactly', history.status === 200 && history.json.messages.some(m => m.content === sendBody.content));
  const room = await app.request('/api/v1/servers', { method: 'POST', session: alice, body: { name: 'Go PostgreSQL room', requestId: randomUUID() } }); assert.equal(room.status, 200, room.text);
  const bootstrap = await app.request('/api/v1/bootstrap', { session: alice }); pass('Go PostgreSQL server bootstrap and snapshot', bootstrap.status === 200 && bootstrap.json.servers.some(s => s.id === room.json.id));
  const channel = bootstrap.json.channels.find(c => c.kind === 'text'); assert.ok(channel);
  const invite = await app.request(`/api/v1/servers/${room.json.id}/invites`, { method: 'POST', session: alice, body: { requestId: randomUUID() } }); assert.equal(invite.status, 200, invite.text);
  const join = await app.request('/api/v1/invites/join', { method: 'POST', session: bob, body: { code: invite.json.code, requestId: randomUUID() } }); assert.equal(join.status, 200, join.text);
  const permissions = await app.request(`/api/v1/channels/${channel.id}`, { method: 'PATCH', session: alice, body: { role: 'member', permissions: { write: false }, expectedRevision: 0, requestId: randomUUID() } }); assert.equal(permissions.status, 200, permissions.text);
  pass('Go PostgreSQL permission revision conflict', (await app.request(`/api/v1/channels/${channel.id}`, { method: 'PATCH', session: alice, body: { role: 'member', permissions: {}, expectedRevision: 0, requestId: randomUUID() } })).status === 409);
  pass('Go PostgreSQL channel write permission enforced', (await app.request('/api/v1/messages', { method: 'POST', session: bob, body: { conversationId: channel.conversationId, content: 'must fail', requestId: randomUUID() } })).status === 403);
  await engine.exec("CREATE FUNCTION independent_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'independent synthetic rollback'; END; $$; CREATE TRIGGER independent_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'role.change') EXECUTE FUNCTION independent_reject_audit();");
  const roleBody = { name: 'Rollback test role', color: '#aabbcc', permissions: { speak: false }, requestId: randomUUID() };
  const failed = await app.request(`/api/v1/servers/${room.json.id}/roles`, { method: 'POST', session: alice, body: roleBody });
  pass('Go PostgreSQL SQL exception after role INSERT surfaces failure', failed.status === 500);
  pass('Go PostgreSQL transaction rolls back prior role INSERT', (await engine.query('SELECT id FROM custom_roles WHERE name=$1', [roleBody.name])).rows.length === 0);
  pass('Go PostgreSQL failed mutation leaves no receipt', (await engine.query('SELECT request_id FROM mutations WHERE request_id=$1', [roleBody.requestId])).rows.length === 0);
  await engine.exec('DROP TRIGGER independent_audit_fail ON audit_log; DROP FUNCTION independent_reject_audit();');
  const role = await app.request(`/api/v1/servers/${room.json.id}/roles`, { method: 'POST', session: alice, body: roleBody });
  pass('Go PostgreSQL transaction recovers and same request retries after SQL rollback', role.status === 200 && !!role.json.id);
  const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => app.request('/api/v1/messages', { method: 'POST', session: alice, body: { conversationId: dm.json.id, content: `concurrent-${i}`, requestId: randomUUID() } })));
  pass('Go PostgreSQL concurrent API transactions serialize successfully', burst.every(r => r.status === 200));
  const sequences = (await engine.query('SELECT sequence FROM messages WHERE conversation_id=$1 ORDER BY sequence', [dm.json.id])).rows.map(r => Number(r.sequence));
  assert.deepEqual(sequences, Array.from({ length: 9 }, (_, i) => i+1)); pass('Go PostgreSQL concurrent writes preserve unique contiguous sequence');
  pass('Go PostgreSQL exact message row count excludes conflicting replay', (await engine.query('SELECT id FROM messages WHERE conversation_id=$1', [dm.json.id])).rows.length === 9);
  const operator = await register(app, 'pg_review_operator');
  await engine.query('UPDATE users SET instance_admin=1 WHERE id=$1', [operator.user.id]);
  const capabilities = await app.request('/api/v1/admin/capabilities', { session: operator });
  pass('Go PostgreSQL advertises the Monitor 1.1.0 contract', capabilities.status === 200 && capabilities.json.userActions.includes('delete') && capabilities.json.userActions.includes('setPassword'));
  const manage = (action, body = {}) => app.request(`/api/v1/admin/users/${alice.user.id}`, { method: 'POST', session: operator, body: { action, requestId: randomUUID(), ...body } });
  pass('Go PostgreSQL administrator sets a temporary password', (await manage('setPassword', { password: 'temporary-fixture-password' })).status === 200);
  pass('Go PostgreSQL password reset revokes old sessions', (await app.request('/api/v1/auth/me', { session: alice })).status === 401);
  await engine.exec("CREATE FUNCTION independent_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic deletion rollback'; END; $$; CREATE TRIGGER independent_delete_fail BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'admin.delete') EXECUTE FUNCTION independent_reject_delete();");
  assert.equal((await manage('delete', { confirmUsername: alice.user.username })).status, 500);
  const rolledBack = await app.request(`/api/v1/conversations/${dm.json.id}/messages?after=0`, { session: bob });
  pass('Go PostgreSQL failed delete rolls back history and server ownership', rolledBack.json.events[0].payload.author.id === alice.user.id && rolledBack.json.events[0].payload.author.username === alice.user.username && (await engine.query('SELECT owner_id FROM servers WHERE id=$1', [room.json.id])).rows[0].owner_id === alice.user.id);
  await engine.exec('DROP TRIGGER independent_delete_fail ON audit_log; DROP FUNCTION independent_reject_delete();');
  assert.equal((await manage('delete', { confirmUsername: alice.user.username })).status, 200);
  const kept = await app.request(`/api/v1/conversations/${dm.json.id}/messages?after=0`, { session: bob });
  pass('Go PostgreSQL delete preserves sequence and anonymizes retained events', kept.status === 200 && kept.json.events.length === 9 && kept.json.events.every(event => event.payload.author.deleted && event.payload.author.displayName === 'Deleted account'));
  pass('Go PostgreSQL delete transfers owned servers', (await engine.query('SELECT owner_id FROM servers WHERE id=$1', [room.json.id])).rows[0].owner_id === operator.user.id);
  const users = await app.request('/api/v1/admin/users?offset=0', { session: operator });
  pass('Go PostgreSQL deleted account excluded from admin list', users.status === 200 && users.json.users.every(user => user.id !== alice.user.id));
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack || error); process.exitCode = 1; }
finally {
  if (app) await app.stop();
  if (pgServer) await pgServer.stop();
  if (engine) await engine.close();
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(path.dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, checks: Object.keys(report.checks).length, error: report.error || null }));
}
