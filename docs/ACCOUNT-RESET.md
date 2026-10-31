# Accounts, recovery and deliberate resets

The expansion does not delete accounts during startup, migration or deployment. The owner explicitly chose to keep live accounts. No production reset has been performed.

## Recover a forgotten password

From 0.7.5, registration displays eight one-use recovery codes. Save them in a password manager or private offline file. Existing users receive a one-time account reminder; saved old codes stay valid unless replaced explicitly with password confirmation. Recovery setup is also under Account settings → Privacy → Account recovery. Plaintext codes are not recoverable from their database hashes.

On the sign-in screen, open **Forgot password?**, enter your username, one unused recovery code and a new password, then sign in with that password. The code is consumed and previous sessions are revoked. Without a saved code, contact the instance administrator for a temporary password. Supporting security questions cannot reset a password alone. The in-app guide gives the same steps.

## Initial global administrator

Normal registration never grants global administration. An existing registered user may claim it once through Settings using the private `BOOTSTRAP_ADMIN_SECRET`. Alternatively stop the application and initialize a fresh administrator with the CLI below. Once claimed, another initialization is rejected. Server owners/administrators cannot ban, reset, demote or remove the protected global administrator through the administration APIs.

Create a private JSON file outside the repository, readable only by the operator, with `username`, `displayName` and `password`. Use at least eight characters; prefer a longer random password. Do not put passwords in shell arguments or environment examples. The commands never print the password.

```sh
# Source checkout (patched Node 24, development tools installed):
npm run admin -- init --credentials /private/new-admin.json --confirm INIT-SUPERADMIN
# Compiled deployment, with its existing private environment loaded:
node --env-file=/etc/dorham/pilot.env apps/api/dist/admin.js init \
  --credentials /private/new-admin.json --confirm INIT-SUPERADMIN
```

## Preview before a reset

Stop the Node application; do not erase a live `instance.lock`. Inspect the actual systemd process if a stale receipt is suspected. The CLI refuses a live or invalid ownership receipt. Existing server/channel IDs and configuration are preserved, ownership transfers to the new account, and other people must join again after registering.

**A reset removes all previous accounts, authentication sessions, user tags, invitations, messages, DMs, reactions, unread cursors, voice membership and file metadata.** It resets retained channel event sequences. Role overrides, channel settings, tag definitions and tag requirements remain. The preview lists affected counts before execution.

```sh
sudo systemctl stop dorham
cd /opt/dorham
sudo /opt/node-v24.22.1-linux-x64/bin/node \
  --env-file=/etc/dorham/pilot.env apps/api/dist/admin.js preview
```

Only after a separate explicit operator decision:

```sh
# /private/reset-2026-10-29 must be a NEW directory outside DATA_DIR.
# Run with permissions sufficient for the private backup and dedicated data paths.
node --env-file=/etc/dorham/pilot.env apps/api/dist/admin.js reset \
  --credentials /private/new-admin.json \
  --backup /private/reset-2026-10-29 \
  --confirm RESET-ALL-USERS
```

The reset creates a **pre-migration** SQLite backup, checks integrity/foreign keys, and copies avatars and uploaded files before the database transaction. It keeps original asset directories as same-filesystem `.before-account-reset-...` siblings rather than deleting them. Preserve those originals and the private backup until an operator explicitly authorizes cleanup; account resets are not a disk-reclamation tool. Ensure enough free space for the asset copies. Fix directory ownership after an operator-root invocation before starting the `dorham` service.

Test restoration into an isolated directory first. Restore the complete database and matching avatars/attachments together, while the application is stopped, following OPERATIONS.md. Never overlay a live SQLite file. The ordinary backup command backs up SQLite only; uploaded files must now be included as well as avatars. Preserve instance configuration separately in private storage.

The automated destructive-reset CLI supports SQLite. PostgreSQL migrations and application operations are supported, but a destructive PostgreSQL reset requires an operator-reviewed `pg_dump`/restore workflow and is not automatically executed by this CLI.

## Recovery and sessions

- In 0.7.6, a signed-in registered user may set a new password without knowing the old password, using Profile settings, Privacy → Account recovery or the one-time reminder. The authenticated API keeps the current session and invalidates other sessions; browser CSRF checks remain required. Guests must register first. Existing recovery codes remain valid unless explicitly replaced. A revoked or signed-out session cannot use this route. Signed-out recovery still requires an unused code or an administrator-issued temporary password.


- Web cookies are HttpOnly/SameSite and secure under HTTPS, with CSRF checks. Web renewal extends the 30-day session and cookie. Native refresh credentials rotate through the existing protected Electron/Android bridges; reused refresh credentials revoke their session. Device lists expose metadata, never access/refresh tokens.
- Users can revoke a device or all devices. Revoked sockets are disconnected, and clients clear their visible private state when session invalidation is confirmed. Password recovery revokes every session and voice membership.
- Eight high-entropy, one-use recovery codes are issued after password confirmation, displayed once, and stored only as hashes. Reissuing invalidates the old set. Keep the downloaded file private and outside the repository.
- Optional questions use normalized answers and salted Argon2id hashes. **A question/answer is never accepted by the password-recovery endpoint.** The primary recovery methods are a code or an audited super-admin temporary password.
- A temporary administrator-issued password is shown only once and must be changed before ordinary APIs or sockets become usable. The administrator cannot view an existing password. Audit rows exclude passwords, recovery codes, answer text and media tokens.
- Guests have a persistent random identity with no usable password. They join by invitation, may send permitted messages/use voice, cannot upload files or administer servers, and can register the same identity without receiving additional roles. Server guest access defaults on and can be disabled; global guest admission can also be disabled. Guests and registered users share the same 100-identity cap; conversion consumes no extra slot.
