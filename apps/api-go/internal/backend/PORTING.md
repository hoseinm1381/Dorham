# Go backend port contract

The TypeScript API in apps/api/src is the behavior reference. Preserve every route,
Socket.IO event/ack, error code, SQL schema and authorization check. No Node proxy
or JavaScript interpreter is an acceptable replacement for backend logic.

All implementation lives in this package (`package backend`), except cmd/dorham.
Root owns foundation/config/db/auth/http/realtime. Parallel owners own service*,
media*, and game*/chess* respectively. Do not edit another owner's files.

Shared types implemented by root:

* `type M = map[string]any`; `type Rows = []M`.
* `S(any) string`, `N(any) int64`, `F(any) float64`, `B(any) bool`, `Obj(any) M`,
  `Arr(any) []any`, `Str(M,string) string`, `Num(M,string) int64`, `Bool(M,string) bool`.
* `Now() int64` milliseconds, `ID() string` UUID, `Token() string`, `Hash(string) string`.
* `Fail(status int, code,message string)` panics with APIError; transaction and
  HTTP/socket boundaries recover and convert safely. `Check(bool,status,code,message)`.
* `Parse(string) any`, `JSON(any) string`, `Clone(M) M`, `Merge(...M) M`.
* `DB.One(query string,args ...any) M`, `.All(...) []M`, `.Run(...)`,
  `.Tx(func(*DB) any) any` serialized transactions; panic rolls back. Methods use
  ? placeholders for both database dialects. `DB.Dialect string`.
* `Config` fields use Go PascalCase from TS camelCase: DataDir, DatabaseURL,
  MaxUsers, MaxOnline, MaxVoice, RoomShares, GlobalShares, RetentionDays,
  MaxMessages, MaxDatabaseMiB, MaxAvatarsMiB, MediaTransport, LivekitURL,
  LivekitAPIURL, LivekitKey, LivekitSecret, ScreenMaxBitrate, ScreenMaxFrameRate,
  StandardShareSlots, GuestsEnabled, MaxGuests, AttachmentDir,
  AttachmentBudgetMiB, UploadReserveMiB, UploadConcurrency, UploadSoftMiB,
  UploadHardMiB, UploadSmallMiB, TTSIdleSeconds, TTSAudioCacheMiB, PublicURL,
  Origins []string, Secure, Production, BootstrapSecret, RegistrationOpen,
  StunURLs/TurnURLs []string, TurnUsername/TurnPassword/TurnSecret,
  CloudflareTurnKeyID/CloudflareTurnAPIToken, MediaAdmissionSecret.
* `App` fields C Config, DB *DB, Service *Service, Hub *Hub.
* `App.Route(method,path string,auth bool, handler func(*Request) any)`.
  Paths use Go std http `{id}` captures.
* `Request` fields A *App, W http.ResponseWriter, R *http.Request,
  Body M, User M, Session M; `Param(string) string`, `Query(string) string`,
  `UID() string`, `Status(int)`, `Header(string,string)`.
* `Hub.Notify(kind string,payload any)`; `.EmitUser(uid,event string,payload any)`;
  `.Online(uid string) bool`; `.DisconnectInvalid()`; `.Viewers() []M` with
  socketId/userId. Service.Notify is `func(string,any)` set by root.

Service owner: `NewService(db *DB,c Config) *Service`, fields DB *DB, C Config,
Notify func(string,any), OnTTS func(string,M); public methods PascalCase TS
names, dynamic body M, return JSON-shaped M/[]M/any as needed. Include permissions,
public user, member moderation, share policy, TURN, mentions, mutation receipts.
`PublicUser(M) M`; `Audit(tx *DB,actor,kind,target string,payload any)` root owns
in auth, use it. `Member/Channel/Conversation(tx,*...)` must accept passed tx.

Media owner: `NewMedia(a *App) *Media`, `RegisterRoutes()` and `Close()`;
`Synchronize()` updates SFU; `Credentials(uid string) M`; `Speech(uid string,msg M)`;
`Cleanup()`; `Metrics() M`. Own media* Go files. Include attachments/images/TTS/
SFU/admission, register their HTTP handlers. Use a.Service methods, root will
connect socket dispatch and OnTTS. Helper filesystem/error routines local names.

Games owner: `NewGames(a *App) *Games`, `RegisterRoutes()`, `Close()`,
`ReconcileVoice()`, `Presence(uid string,online bool)`, `List(uid,channel string) any`,
`View(uid,id string) any`, `ChessList(uid,channel string) any`, `ChessView(uid,id string) any`.
Own games*/chess* Go files. Include all chess+arcade logic, persistence, timers,
visibility/security, events. Use Hub.Online/EmitUser and Service.Notify.

No production changes. Do not mutate data/ or .env. All fixtures use private
temporary directories. Track incomplete work explicitly, never silent fallback.
