# Dorham Monitor 1.1.0 backend contract

The Go backend implements this contract in `apps/api-go/internal/backend/admin_accounts.go`. Migration 13 adds the deleted-account marker after the Android notification migration. Deploy the Go backend and web build together to enable the full feature in Monitor and update already-open browser chats.

All paths below use `/api/v1`. Monitor signs in with `POST /auth/login`, `X-Dorham-Native: 1`, and `{username,password,requestId}`. It keeps the returned Bearer access token in memory and requests a new sign-in when the 15-minute access session expires. `POST /auth/logout` revokes that session.

`GET /admin/capabilities` requires a global administrator and returns:

```json
{
  "version": 1,
  "userActions": ["ban", "unban", "revoke", "resetPassword", "setPassword", "delete"],
  "usersPagination": true,
  "deletionMode": "anonymizeKeepMessages"
}
```

`GET /admin/users?offset=0` returns `{users: PublicUser[]}` in pages of 250 ordered by creation time and ID. Deleted accounts are excluded before paging. A short page ends the list. `GET /admin/audit` returns the existing audit trail. Monitor falls back to the four original actions and a single user page when an older server returns 404 for capability discovery.

`POST /admin/users/{id}` takes a UUID `requestId` and an `action`. Global administrators are protected. A duplicate request ID returns 409. Successful writes return `{success:true}`.

- `ban` blocks instance access and revokes existing sessions. `unban` allows a fresh sign-in. `revoke` signs out existing devices.
- `resetPassword` returns a generated temporary password once. `setPassword` accepts a chosen `password` of 8–128 characters. Both require replacement at the next login and revoke prior sessions and recovery methods. Chosen passwords are excluded from audit records and mutation receipts.
- `delete` requires `confirmUsername` equal to the current username. The login, profile, recoveries, sessions and memberships are retired. Servers owned by the account transfer to the acting administrator. Original messages, replies and attached files retain their normal retention under **Deleted account**. The other DM participant can still read the conversation. Historical message text and existing backups can contain names users wrote before deletion.

Session revocation removes Android notification device registrations and queued deliveries by foreign-key cascade. The backend also disconnects sockets, invalidates detached voice recovery and uses the existing voice and SFU reconciliation. Existing chess matches involving the deleted account finish, while other supported games use the existing player-departure logic.

The legacy Node backend understands the reserved deleted-account identity when reading a database from Go. It continues to advertise the original account management functionality through Monitor's compatibility fallback.
