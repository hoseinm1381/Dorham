package backend

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"golang.org/x/crypto/argon2"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"net/http"
	"strconv"
	"strings"
)

var authSlots = make(chan struct{}, 2)

func authEnter() func() {
	select {
	case authSlots <- struct{}{}:
		return func() { <-authSlots }
	default:
		Fail(429, "AUTH_BUSY", "Authentication is busy. Please retry shortly.")
	}
	return nil
}
func PasswordHash(password string) string {
	release := authEnter()
	defer release()
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		panic(e)
	}
	digest := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	return fmt.Sprintf("$argon2id$v=19$m=19456,p=1,t=2$%s$%s", base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(digest))
}
func PasswordVerify(encoded, password string) bool {
	release := authEnter()
	defer release()
	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[1] != "argon2id" || p[2] != "v=19" {
		return false
	}
	params := map[string]uint32{}
	for _, field := range strings.Split(p[3], ",") {
		pair := strings.Split(field, "=")
		if len(pair) != 2 || !Contains([]string{"m", "t", "p"}, pair[0]) {
			return false
		}
		if _, exists := params[pair[0]]; exists {
			return false
		}
		for _, r := range pair[1] {
			if r < '0' || r > '9' {
				return false
			}
		}
		value, err := strconv.ParseUint(pair[1], 10, 32)
		if err != nil {
			return false
		}
		params[pair[0]] = uint32(value)
	}
	memory, iterations, parallel := params["m"], params["t"], params["p"]
	if len(params) != 3 || memory < 8*parallel || memory > 262144 || iterations < 1 || iterations > 10 || parallel < 1 || parallel > 16 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(p[4])
	if e != nil || len(salt) < 8 || len(salt) > 64 {
		return false
	}
	digest, e := base64.RawStdEncoding.DecodeString(p[5])
	if e != nil || len(digest) < 16 || len(digest) > 64 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, iterations, memory, uint8(parallel), uint32(len(digest)))
	return Equal(base64.RawStdEncoding.EncodeToString(got), base64.RawStdEncoding.EncodeToString(digest))
}
func Audit(tx *DB, actor, action, target string, details any) {
	var av, tv any
	if actor != "" {
		av = actor
	}
	if target != "" {
		tv = target
	}
	if details == nil {
		details = M{}
	}
	tx.Run("INSERT INTO audit_log(id,actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?,?)", ID(), av, action, tv, JSON(details), Now())
	tx.Run("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY created_at DESC LIMIT 500 OFFSET 10000)")
}
func Administrator(tx *DB, uid string) M {
	u := tx.One("SELECT * FROM users WHERE id=? AND banned=0 AND guest=0", uid)
	Check(u != nil && Bool(u, "instance_admin"), 403, "FORBIDDEN", "Global administration is required.")
	return u
}
func recoveryCodes(tx *DB, uid string) []string {
	codes := []string{}
	for i := 0; i < 8; i++ {
		code := Token()[:24]
		codes = append(codes, code)
		tx.Run("INSERT INTO recovery_codes(user_id,code_hash,created_at) VALUES(?,?,?)", uid, Hash(code), Now())
	}
	return codes
}
func normalizeAnswer(s string) string {
	return cases.Lower(language.English).String(strings.Join(strings.FieldsFunc(norm.NFKC.String(s), serviceJSSpace), " "))
}
func verifyCurrent(u M, password string) {
	Check(!Bool(u, "guest") && PasswordVerify(Str(u, "password_hash"), password), 401, "INVALID_CREDENTIALS", "Current password is incorrect.")
}
func (a *App) setCookie(r *Request, access string) {
	http.SetCookie(r.W, &http.Cookie{Name: "dorham_session", Value: access, Path: "/", HttpOnly: true, Secure: a.C.Secure, SameSite: http.SameSiteLaxMode, MaxAge: 30 * 86400})
}
func (a *App) sessionFor(r *Request, uid string, verifiedHash ...string) M {
	native := r.R.Header.Get("X-Dorham-Native") == "1"
	access, csrf, refresh := Token(), Token(), ""
	var refreshHash any
	expires := Now() + 30*86400000
	if native {
		refresh = Token()
		refreshHash = Hash(refresh)
		expires = Now() + 15*60000
	}
	device := r.R.UserAgent()
	if device == "" {
		device = "Unknown device"
	}
	if len(device) > 160 {
		device = device[:160]
	}
	u := Obj(a.DB.Tx(func(tx *DB) any {
		current := tx.One("SELECT * FROM users WHERE id=? AND banned=0 AND deleted_at IS NULL", uid)
		Check(current != nil && (len(verifiedHash) == 0 || Str(current, "password_hash") == verifiedHash[0]), 401, "INVALID_CREDENTIALS", "Username or password is incorrect.")
		old := tx.All("SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC", uid)
		for i, s := range old {
			if i >= 2 {
				tx.Run("DELETE FROM sessions WHERE id=?", s["id"])
			}
		}
		tx.Run("INSERT INTO sessions(id,user_id,access_hash,refresh_hash,csrf,native,access_expires,expires_at,created_at,device_name,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)", ID(), uid, Hash(access), refreshHash, csrf, native, expires, Now()+30*86400000, Now(), device, Now())
		return current
	}))
	result := M{"user": PublicUser(u), "csrf": csrf}
	if native {
		result["accessToken"], result["refreshToken"] = access, refresh
	} else {
		a.setCookie(r, access)
	}
	return result
}
func authBody(b M, register bool) {
	RID(b)
	name := VString(b, "username", 3, 32, true)
	Check(usernamePattern.MatchString(name), 400, "VALIDATION", "Invalid username")
	VString(b, "password", 8, 128, false)
	if register {
		VString(b, "displayName", 1, 48, true)
		VEnum(b, "language", []string{"en-US", "fa-IR"}, true)
	}
}
func (a *App) registerAuth() {
	a.Route("POST", "/api/v1/auth/register", false, func(r *Request) any {
		Check(a.C.RegistrationOpen, 403, "REGISTRATION_CLOSED", "Registration is closed.")
		b := corePick(r.Body, "username", "password", "displayName", "language", "requestId")
		authBody(b, true)
		encoded := PasswordHash(Str(b, "password"))
		created := Obj(a.DB.Tx(func(tx *DB) any {
			Check(Num(tx.One("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL"), "count") < int64(a.C.MaxUsers), 409, "ACCOUNT_LIMIT", "This instance has reached its account limit.")
			Check(tx.One("SELECT id FROM users WHERE username=?", strings.ToLower(Str(b, "username"))) == nil, 409, "USERNAME_TAKEN", "This username is unavailable.")
			uid := ID()
			tx.Run("INSERT INTO users(id,username,display_name,password_hash,created_at,language) VALUES(?,?,?,?,?,?)", uid, strings.ToLower(Str(b, "username")), b["displayName"], encoded, Now(), Str(b, "language"))
			return M{"uid": uid, "codes": recoveryCodes(tx, uid)}
		}))
		a.Hub.Notify("state:changed", M{})
		r.Status(201)
		return Merge(a.sessionFor(r, Str(created, "uid")), M{"recoveryCodes": created["codes"]})
	})
	a.Route("POST", "/api/v1/auth/login", false, func(r *Request) any {
		b := r.Body
		authBody(b, false)
		u := a.DB.One("SELECT * FROM users WHERE username=?", strings.ToLower(Str(b, "username")))
		if u == nil || Bool(u, "guest") || Bool(u, "banned") || u["deleted_at"] != nil {
			PasswordHash(Str(b, "password"))
			Fail(401, "INVALID_CREDENTIALS", "Username or password is incorrect.")
		}
		Check(PasswordVerify(Str(u, "password_hash"), Str(b, "password")), 401, "INVALID_CREDENTIALS", "Username or password is incorrect.")
		return a.sessionFor(r, Str(u, "id"), Str(u, "password_hash"))
	})
	a.Route("POST", "/api/v1/auth/refresh", false, func(r *Request) any {
		b := r.Body
		RID(b)
		fingerprint := Hash(VString(b, "refreshToken", 20, 512, false))
		result := a.DB.Tx(func(tx *DB) any {
			if old := tx.One("SELECT session_id FROM used_refresh WHERE hash=?", fingerprint); old != nil {
				tx.Run("DELETE FROM sessions WHERE id=?", old["session_id"])
				return nil
			}
			s := tx.One("SELECT * FROM sessions WHERE refresh_hash=? AND native=1 AND expires_at>=?", fingerprint, Now())
			if s == nil || tx.One("SELECT id FROM users WHERE id=? AND banned=0 AND deleted_at IS NULL", s["user_id"]) == nil {
				return nil
			}
			access, refresh := Token(), Token()
			tx.Run("INSERT INTO used_refresh(hash,session_id,expires_at) VALUES(?,?,?)", fingerprint, s["id"], s["expires_at"])
			tx.Run("UPDATE sessions SET access_hash=?,refresh_hash=?,access_expires=?,expires_at=?,last_seen=? WHERE id=?", Hash(access), Hash(refresh), Now()+15*60000, Now()+30*86400000, Now(), s["id"])
			return M{"accessToken": access, "refreshToken": refresh, "csrf": s["csrf"]}
		})
		Check(result != nil, 401, "REFRESH_INVALID", "Session expired. Sign in again.")
		return result
	})
	a.Route("POST", "/api/v1/auth/guest", false, a.guest)
	a.Route("POST", "/api/v1/auth/recover", false, a.recoverAccount)
	a.Route("GET", "/api/v1/auth/me", true, func(r *Request) any { return M{"user": PublicUser(r.User), "csrf": r.Session["csrf"]} })
	a.Route("POST", "/api/v1/auth/renew", true, func(r *Request) any {
		RID(r.Body)
		Check(!Bool(r.Session, "native"), 400, "NATIVE_REFRESH", "Use native credential renewal.")
		access := Token()
		a.DB.Run("UPDATE sessions SET access_hash=?,access_expires=?,expires_at=?,last_seen=? WHERE id=?", Hash(access), Now()+30*86400000, Now()+30*86400000, Now(), r.Session["id"])
		a.setCookie(r, access)
		return M{"success": true, "csrf": r.Session["csrf"]}
	})
	a.Route("POST", "/api/v1/auth/logout", true, func(r *Request) any {
		RID(r.Body)
		a.DB.Run("DELETE FROM sessions WHERE id=?", r.Session["id"])
		a.Hub.DisconnectSession(Str(r.Session, "id"))
		http.SetCookie(r.W, &http.Cookie{Name: "dorham_session", Path: "/", MaxAge: -1})
		return M{"success": true}
	})
	a.Route("POST", "/api/v1/auth/password", true, func(r *Request) any {
		b := r.Body
		rid := RID(b)
		password := VString(b, "password", 8, 128, false)
		Check(!Bool(r.User, "guest"), 403, "GUEST_ACCOUNT", "Register this guest account before setting a password.")
		encoded := PasswordHash(password)
		result := a.Service.Mutate(r.UID(), rid, "password.change", M{"fingerprint": Hash(password)}, func(tx *DB) any {
			Check(tx.One("SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>=?", r.Session["id"], r.UID(), Now()) != nil, 401, "UNAUTHORIZED", "Sign in again to continue.")
			tx.Run("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?", encoded, r.UID())
			tx.Run("DELETE FROM sessions WHERE user_id=? AND id<>?", r.UID(), r.Session["id"])
			Audit(tx, r.UID(), "password.change", r.UID(), nil)
			return M{"success": true}
		})
		a.Hub.DisconnectInvalid()
		return result
	})
	a.Route("POST", "/api/v1/admin/claim", true, func(r *Request) any {
		rid := RID(r.Body)
		secret := VString(r.Body, "secret", 0, 256, false)
		Check(a.C.BootstrapSecret != "" && Equal(a.C.BootstrapSecret, secret), 403, "FORBIDDEN", "Bootstrap secret is invalid.")
		return a.Service.Mutate(r.UID(), rid, "admin.claim", M{}, func(tx *DB) any {
			Check(tx.One("SELECT value FROM meta WHERE key='admin_claimed'") == nil, 409, "ALREADY_CLAIMED", "Instance administration has already been claimed.")
			Check(!Bool(r.User, "guest"), 403, "GUEST_ACCOUNT", "Register before claiming administration.")
			Audit(tx, r.UID(), "admin.claim", r.UID(), nil)
			tx.Run("UPDATE users SET instance_admin=1 WHERE id=?", r.UID())
			tx.Run("INSERT INTO meta(key,value) VALUES('admin_claimed',?)", r.UID())
			return M{"success": true}
		})
	})
	a.Route("POST", "/api/v1/auth/upgrade", true, func(r *Request) any {
		b := r.Body
		authBody(b, true)
		Check(Bool(r.User, "guest"), 409, "NOT_GUEST", "This account is already registered.")
		encoded := PasswordHash(Str(b, "password"))
		result := a.Service.Mutate(r.UID(), Str(b, "requestId"), "guest.upgrade", M{"username": b["username"], "displayName": b["displayName"], "password": Hash(Str(b, "password"))}, func(tx *DB) any {
			Check(a.C.RegistrationOpen, 403, "REGISTRATION_CLOSED", "Registration is closed.")
			Check(tx.One("SELECT id FROM users WHERE id=? AND guest=1", r.UID()) != nil, 409, "NOT_GUEST", "This account is already registered.")
			tx.Run("UPDATE users SET username=?,display_name=?,password_hash=?,guest=0 WHERE id=?", strings.ToLower(Str(b, "username")), b["displayName"], encoded, r.UID())
			Audit(tx, r.UID(), "guest.upgrade", r.UID(), nil)
			return M{"success": true}
		})
		a.Hub.Notify("state:changed", M{})
		return result
	})
	a.registerRecovery()
	a.registerAdmin()
}
func (a *App) guest(r *Request) any {
	b := r.Body
	rid := RID(b)
	VString(b, "displayName", 1, 48, true)
	VString(b, "code", 10, 100, false)
	VEnum(b, "language", []string{"en-US", "fa-IR"}, true)
	Check(a.C.GuestsEnabled, 403, "GUESTS_DISABLED", "Guest access is disabled.")
	created := Obj(a.DB.Tx(func(tx *DB) any {
		fingerprint := Hash(`{"code":` + JSON(b["code"]) + `,"displayName":` + JSON(b["displayName"]) + `}`)
		previous := tx.One("SELECT m.user_id,m.fingerprint,m.response,u.guest FROM mutations m JOIN users u ON u.id=m.user_id WHERE m.request_id=? AND m.operation='guest.create'", rid)
		if previous != nil {
			Check(Bool(previous, "guest"), 409, "NOT_GUEST", "This account is already registered.")
			Check(Str(previous, "fingerprint") == fingerprint, 409, "IDEMPOTENCY_CONFLICT", "Request identifier was already used with different input.")
			return Merge(M{"userId": previous["user_id"]}, Obj(Parse(Str(previous, "response"))))
		}
		inv := tx.One("SELECT i.*,s.allow_guests FROM invites i JOIN servers s ON s.id=i.server_id WHERE i.hash=? AND i.expires_at>=? AND i.remaining>0", Hash(Str(b, "code")), Now())
		Check(inv != nil && Bool(inv, "allow_guests"), 403, "GUEST_INVITE_REQUIRED", "A valid invitation to a guest-enabled server is required.")
		Check(Num(tx.One("SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL"), "count") < int64(a.C.MaxUsers), 409, "ACCOUNT_LIMIT", "This instance has reached its account limit.")
		Check(Num(tx.One("SELECT COUNT(*) AS count FROM users WHERE guest=1"), "count") < int64(a.C.MaxGuests), 409, "GUEST_LIMIT", "Guest capacity has been reached.")
		uid := ID()
		tx.Run("INSERT INTO users(id,username,display_name,password_hash,guest,created_at,language) VALUES(?,?,?,?,1,?,?)", uid, "guest_"+strings.ReplaceAll(uid, "-", "")[:20], b["displayName"], "!guest-no-password", Now(), Str(b, "language"))
		tx.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)", inv["server_id"], uid, "member", Now())
		tx.Run("UPDATE invites SET remaining=remaining-1 WHERE hash=?", Hash(Str(b, "code")))
		landing := M{"serverId": inv["server_id"], "channelId": inv["channel_id"]}
		tx.Run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", uid, rid, "guest.create", fingerprint, JSON(landing), Now())
		Audit(tx, uid, "guest.create", Str(inv, "server_id"), nil)
		return Merge(M{"userId": uid}, landing)
	}))
	a.Hub.Notify("state:changed", M{})
	r.Status(201)
	return Merge(a.sessionFor(r, Str(created, "userId")), M{"landing": M{"serverId": created["serverId"], "channelId": created["channelId"]}})
}
func (a *App) recoverAccount(r *Request) any {
	b := r.Body
	RID(b)
	name := strings.ToLower(VString(b, "username", 1, 32, true))
	code := VString(b, "code", 0, 128, false)
	password := VString(b, "password", 8, 128, false)
	subject := Hash(name)
	a.DB.Tx(func(tx *DB) any {
		old := tx.One("SELECT * FROM recovery_attempts WHERE subject=?", subject)
		attempts, expires := int64(1), Now()+3600000
		if old != nil && Num(old, "expires_at") > Now() {
			attempts = Num(old, "attempts") + 1
			expires = Num(old, "expires_at")
		}
		Check(attempts <= 5, 429, "RECOVERY_LIMIT", "Recovery is temporarily unavailable. Try later or contact the administrator.")
		tx.Run("INSERT INTO recovery_attempts(subject,attempts,expires_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at", subject, attempts, expires)
		return nil
	})
	u := a.DB.One("SELECT * FROM users WHERE username=? AND guest=0 AND banned=0", name)
	digest := Hash(strings.TrimSpace(code))
	Check(u != nil && a.DB.One("SELECT code_hash FROM recovery_codes WHERE user_id=? AND code_hash=?", u["id"], digest) != nil, 401, "RECOVERY_INVALID", "Recovery details are invalid or unavailable.")
	encoded := PasswordHash(password)
	a.DB.Tx(func(tx *DB) any {
		Check(tx.One("SELECT c.code_hash FROM recovery_codes c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND c.code_hash=? AND u.banned=0 AND u.deleted_at IS NULL", u["id"], digest) != nil, 401, "RECOVERY_INVALID", "Recovery details are invalid or unavailable.")
		tx.Run("DELETE FROM recovery_codes WHERE user_id=? AND code_hash=?", u["id"], digest)
		tx.Run("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?", encoded, u["id"])
		tx.Run("DELETE FROM sessions WHERE user_id=?", u["id"])
		tx.Run("DELETE FROM voice_members WHERE user_id=?", u["id"])
		Audit(tx, Str(u, "id"), "account.recover", Str(u, "id"), nil)
		return nil
	})
	a.Hub.DisconnectInvalid()
	a.Hub.Notify("voice:changed", M{})
	return M{"success": true}
}
func (a *App) registerRecovery() {
	a.Route("GET", "/api/v1/auth/sessions", true, func(r *Request) any {
		rows := []M{}
		for _, s := range a.DB.All("SELECT id,device_name,native,created_at,last_seen,expires_at FROM sessions WHERE user_id=? AND expires_at>=? ORDER BY created_at DESC", r.UID(), Now()) {
			rows = append(rows, M{"id": s["id"], "device": s["device_name"], "native": Bool(s, "native"), "createdAt": s["created_at"], "lastSeen": s["last_seen"], "expiresAt": s["expires_at"], "current": s["id"] == r.Session["id"]})
		}
		return M{"sessions": rows}
	})
	a.Route("POST", "/api/v1/auth/sessions/revoke", true, func(r *Request) any {
		b := corePick(r.Body, "sessionId", "all", "requestId")
		rid := RID(b)
		VString(b, "sessionId", 1, 80, false, true)
		VBool(b, "all", true)
		if _, ok := b["all"]; !ok {
			b["all"] = false
		}
		Check(Bool(b, "all") || Str(b, "sessionId") != "", 400, "VALIDATION", "Choose sessions to revoke")
		a.Service.Mutate(r.UID(), rid, "session.revoke", b, func(tx *DB) any {
			target := Str(b, "sessionId")
			if Bool(b, "all") {
				tx.Run("DELETE FROM sessions WHERE user_id=?", r.UID())
				target = "all"
			} else {
				tx.Run("DELETE FROM sessions WHERE user_id=? AND id=?", r.UID(), target)
			}
			Audit(tx, r.UID(), "session.revoke", target, nil)
			return M{"success": true}
		})
		a.Hub.DisconnectInvalid()
		return M{"success": true}
	})
	a.Route("POST", "/api/v1/auth/recovery-codes", true, func(r *Request) any {
		b := r.Body
		rid := RID(b)
		verifyCurrent(r.User, VString(b, "password", 0, 128, false))
		var codes []string
		a.DB.Tx(func(tx *DB) any {
			requireLiveSession(tx, r)
			Check(tx.One("SELECT request_id FROM mutations WHERE user_id=? AND request_id=?", r.UID(), rid) == nil, 409, "CODES_ALREADY_ISSUED", "Codes are shown only once. Generate a new set if needed.")
			tx.Run("DELETE FROM recovery_codes WHERE user_id=?", r.UID())
			codes = recoveryCodes(tx, r.UID())
			tx.Run("INSERT INTO mutations(user_id,request_id,operation,fingerprint,response,created_at) VALUES(?,?,?,?,?,?)", r.UID(), rid, "recovery.issue", Hash("issued"), `{"success":true}`, Now())
			Audit(tx, r.UID(), "recovery.issue", r.UID(), nil)
			return nil
		})
		return M{"codes": codes}
	})
	a.Route("GET", "/api/v1/auth/recovery", true, func(r *Request) any {
		var question any
		if q := a.DB.One("SELECT question FROM recovery_questions WHERE user_id=?", r.UID()); q != nil {
			question = q["question"]
		}
		return M{"prompt": !Bool(r.User, "guest") && !Bool(r.User, "recovery_prompt_seen"), "question": question, "codesRemaining": a.DB.One("SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id=?", r.UID())["count"], "questions": []string{"What was your favorite school subject?", "What is a memorable personal preference?", "Custom question"}}
	})
	a.Route("POST", "/api/v1/auth/recovery-acknowledge", true, func(r *Request) any {
		RID(r.Body)
		Check(!Bool(r.User, "guest"), 403, "GUEST_ACCOUNT", "Register before setting up recovery.")
		a.DB.Run("UPDATE users SET recovery_prompt_seen=1 WHERE id=?", r.UID())
		return M{"success": true}
	})
	a.Route("POST", "/api/v1/auth/recovery-question", true, func(r *Request) any {
		b := r.Body
		rid := RID(b)
		verifyCurrent(r.User, VString(b, "password", 0, 128, false))
		question := VString(b, "question", 5, 200, true)
		answer := normalizeAnswer(VString(b, "answer", 1, 200, false))
		encoded := PasswordHash(answer)
		return a.Service.Mutate(r.UID(), rid, "recovery.question", M{"question": question, "answer": Hash(answer)}, func(tx *DB) any {
			requireLiveSession(tx, r)
			tx.Run("INSERT INTO recovery_questions(user_id,question,answer_hash) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET question=excluded.question,answer_hash=excluded.answer_hash", r.UID(), question, encoded)
			Audit(tx, r.UID(), "recovery.question", r.UID(), nil)
			return M{"success": true}
		})
	})
}
func requireLiveSession(tx *DB, r *Request) {
	now := Now()
	Check(tx.One("SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=? AND s.access_hash=? AND s.access_expires>=? AND s.expires_at>=? AND u.banned=0 AND u.deleted_at IS NULL",
		r.Session["id"], r.UID(), r.Session["access_hash"], now, now) != nil, 401, "UNAUTHENTICATED", "Sign in again to continue.")
}
