package backend

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var catalogKinds = []string{"avatar", "badge", "frame", "banner", "emoji", "sticker", "sound"}
var catalogAccess = []string{"free", "profilePlus", "emojiPlus", "soundboardPlus", "communityPlus", "awarded"}
var catalogUploads = make(chan struct{}, 2)
var customEmojiPattern = regexp.MustCompile(`:dx-([0-9a-f-]{36}):`)
var accentPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func isCatalogReaction(text string) bool {
	return len(text) == 41 && customEmojiPattern.FindString(text) == text
}

func catalogURL(row M) string {
	return "/catalog/" + Str(row, "id") + "/" + Str(row, "digest")
}

func featureAvailable(tx *DB, uid, name string) bool {
	return featureSetting(tx, "features")[name] != false && featureGranted(tx, uid, name)
}

func catalogUsable(tx *DB, uid string, item M, server string) bool {
	if item == nil || !Bool(item, "active") {
		return false
	}
	scope := Str(item, "server_id")
	if owner := Str(item, "owner_id"); owner != "" && owner != uid {
		return false
	}
	if scope != "" && scope != server {
		return false
	}
	switch Str(item, "access") {
	case "free":
		return true
	case "awarded":
		return false
	case "communityPlus":
		return featureSetting(tx, "features")["communityPlus"] != false && communityGranted(tx, scope)
	default:
		return featureAvailable(tx, uid, Str(item, "access"))
	}
}

func featureCatalogView(tx *DB, uid string, grants M, communities, memberships map[string]bool) []M {
	items := []M{}
	for _, row := range tx.All("SELECT id,kind,label,pack,digest,access,server_id,free_slot,active,owner_id FROM feature_catalog WHERE published=1 ORDER BY kind,label,id") {
		kind, scope, access := Str(row, "kind"), Str(row, "server_id"), Str(row, "access")
		if scope != "" && !memberships[scope] {
			continue
		}
		if owner := Str(row, "owner_id"); owner != "" && owner != uid {
			continue
		}
		active := Bool(row, "active")
		if !active && kind != "emoji" && kind != "sticker" {
			continue
		}
		_, entitled := grants[access]
		usable := active && (access == "free" || entitled && access != "communityPlus" || access == "communityPlus" && communities[scope])
		items = append(items, M{"id": row["id"], "kind": kind, "label": row["label"], "pack": row["pack"], "url": catalogURL(row), "serverId": scope, "active": active, "usable": usable, "freeSlot": row["free_slot"]})
	}
	return items
}

func validateCatalogImage(data []byte, kind string) ([]byte, string) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	maxWidth, maxHeight := 256, 256
	switch kind {
	case "emoji":
		maxWidth, maxHeight = 128, 128
	case "sticker":
		maxWidth, maxHeight = 384, 384
	case "banner":
		maxWidth, maxHeight = 960, 320
	}
	Check(err == nil && config.Width > 0 && config.Height > 0 && config.Width <= maxWidth && config.Height <= maxHeight, 400, "BAD_IMAGE", "Use a PNG or JPEG within the catalog item size limit.")
	img, _, err := image.Decode(bytes.NewReader(data))
	Check(err == nil, 400, "BAD_IMAGE", "Invalid image.")
	var output bytes.Buffer
	encoder := png.Encoder{CompressionLevel: png.BestSpeed}
	Check(encoder.Encode(&output, img) == nil && output.Len() <= 512*1024, 400, "BAD_IMAGE", "Use a smaller image.")
	return output.Bytes(), "image/png"
}

// Only canonical mono 16-bit PCM WAV is accepted. A low sample rate and size
// limit bound both download and decoder work without an upload-side transcoder.
func validateCatalogSound(data []byte) ([]byte, string) {
	Check(len(data) >= 46 && len(data) <= 64*1024, 400, "BAD_AUDIO", "Use a WAV sound of at most 64 KiB.")
	u16 := func(offset int) uint16 { return binary.LittleEndian.Uint16(data[offset:]) }
	u32 := func(offset int) uint32 { return binary.LittleEndian.Uint32(data[offset:]) }
	samples := u32(24)
	Check(string(data[:4]) == "RIFF" && u32(4) == uint32(len(data)-8) && string(data[8:16]) == "WAVEfmt " && u32(16) == 16 && u16(20) == 1 && u16(22) == 1 &&
		samples >= 8000 && samples <= 24000 && u32(28) == samples*2 && u16(32) == 2 && u16(34) == 16 && string(data[36:40]) == "data" &&
		u32(40) == uint32(len(data)-44) && u32(40)%2 == 0 && u32(40) <= samples*6, 400, "BAD_AUDIO", "Use mono 16-bit PCM WAV, 8–24 kHz, up to 3 seconds.")
	return data, "audio/wav"
}

func catalogPutFile(dir, digest string, data []byte) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		panic(err)
	}
	target := filepath.Join(dir, digest)
	if _, err := os.Stat(target); err == nil {
		return
	}
	file, err := os.CreateTemp(dir, ".upload-")
	if err != nil {
		panic(err)
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil {
		panic(err)
	}
	if closeErr != nil {
		panic(closeErr)
	}
	if err := os.Rename(file.Name(), target); err != nil {
		panic(err)
	}
}

func (a *App) registerCatalog() {
	a.Route("POST", "/api/v1/admin/features/catalog", true, func(r *Request) any { return a.uploadCatalog(r, true) })
	a.Route("POST", "/api/v1/features/sounds", true, func(r *Request) any { return a.uploadCatalog(r, false) })
	a.Route("GET", "/api/v1/admin/features/catalog/{id}", true, func(r *Request) any {
		row := Obj(featureAdmin(r, func(tx *DB) any { return tx.One("SELECT digest,mime FROM feature_catalog WHERE id=?", r.Param("id")) }))
		Check(row != nil, 404, "NOT_FOUND", "Catalog item not found.")
		file, err := os.Open(filepath.Join(a.C.DataDir, "catalog", Str(row, "digest")))
		Check(err == nil, 404, "NOT_FOUND", "Asset not found.")
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, 512*1024+1))
		Check(err == nil && len(data) <= 512*1024, 404, "NOT_FOUND", "Asset not found.")
		r.Header("Cache-Control", "private, no-store")
		return M{"mime": row["mime"], "data": base64.StdEncoding.EncodeToString(data)}
	})
	a.Route("PUT", "/api/v1/admin/features/catalog/{id}", true, func(r *Request) any {
		Strict(r.Body, "active", "requestId")
		active, id := VBool(r.Body, "active"), r.Param("id")
		result := featureAdmin(r, func(tx *DB) any {
			item := tx.One("SELECT free_slot,owner_id,active,kind,access,server_id FROM feature_catalog WHERE id=?", id)
			Check(item != nil, 404, "NOT_FOUND", "Catalog item not found.")
			if owner := Str(item, "owner_id"); active && !Bool(item, "active") && owner != "" {
				Check(N(tx.One("SELECT COUNT(*) AS count FROM feature_catalog WHERE owner_id=? AND active=1", owner)["count"]) < 12, 409, "LIMIT", "This account already has twelve active custom sounds.")
			}
			if active && !Bool(item, "active") && Str(item, "kind") == "sound" && Str(item, "access") == "free" && Str(item, "server_id") == "" && N(item["free_slot"]) == 0 {
				Check(N(tx.One("SELECT COUNT(*) AS count FROM feature_catalog WHERE kind='sound' AND access='free' AND server_id IS NULL AND free_slot IS NULL AND active=1")["count"]) < 12, 409, "LIMIT", "There are already twelve active free bonus sounds.")
			}
			if active && N(item["free_slot"]) > 0 {
				tx.Run("UPDATE feature_catalog SET active=0 WHERE free_slot=? AND id<>?", item["free_slot"], id)
			}
			tx.Run("UPDATE feature_catalog SET active=?,published=CASE WHEN ?=1 THEN 1 ELSE published END WHERE id=?", serviceBoolInt(active), serviceBoolInt(active), id)
			writeFeatureSetting(tx, "catalogRevision", M{})
			Audit(tx, r.UID(), "feature.catalog.publish", id, M{"active": active})
			return M{"success": true}
		})
		a.featureChanged("")
		return result
	})
	a.Route("DELETE", "/api/v1/admin/features/catalog/{id}", true, func(r *Request) any {
		id := r.Param("id")
		digest := S(featureAdmin(r, func(tx *DB) any {
			item := tx.One("SELECT digest,published FROM feature_catalog WHERE id=?", id)
			Check(item != nil, 404, "NOT_FOUND", "Catalog item not found.")
			Check(!Bool(item, "published"), 409, "PUBLISHED", "Retire a published item to preserve its history.")
			tx.Run("DELETE FROM feature_catalog WHERE id=?", id)
			Audit(tx, r.UID(), "feature.catalog.discard", id, nil)
			return item["digest"]
		}))
		a.DB.Tx(func(tx *DB) any {
			if tx.One("SELECT id FROM feature_catalog WHERE digest=? LIMIT 1", digest) == nil {
				_ = os.Remove(filepath.Join(a.C.DataDir, "catalog", digest))
			}
			return nil
		})
		return M{"success": true}
	})
	a.Route("GET", "/catalog/{id}/{digest}", false, func(r *Request) any {
		id, digest := r.Param("id"), r.R.PathValue("digest")
		Check(len(digest) == 64, 404, "NOT_FOUND", "Asset not found.")
		row := a.DB.One("SELECT mime FROM feature_catalog WHERE id=? AND digest=? AND published=1", id, digest)
		Check(row != nil, 404, "NOT_FOUND", "Asset not found.")
		file, err := os.Open(filepath.Join(a.C.DataDir, "catalog", digest))
		Check(err == nil, 404, "NOT_FOUND", "Asset not found.")
		defer file.Close()
		r.Header("Cache-Control", "public, max-age=31536000, immutable")
		r.Header("ETag", `"`+digest+`"`)
		r.Header("Content-Type", Str(row, "mime"))
		r.Header("X-Content-Type-Options", "nosniff")
		http.ServeContent(r.W, r.R, digest, time.Time{}, file)
		return nil
	})
	a.Route("PUT", "/api/v1/features/profile", true, a.selectProfileAsset)
	a.Route("PUT", "/api/v1/admin/features/badge/{id}", true, a.awardProfileBadge)
}

func (a *App) uploadCatalog(r *Request, admin bool) any {
	if admin {
		Administrator(a.DB, r.UID())
	} else {
		Check(featureAvailable(a.DB, r.UID(), "soundboardPlus"), 403, "FEATURE_REQUIRED", "Soundboard Plus is required.")
	}
	select {
	case catalogUploads <- struct{}{}:
		defer func() { <-catalogUploads }()
	default:
		Fail(429, "BUSY", "Another catalog upload is processing. Try again.")
	}
	Check(r.R.ParseMultipartForm(512*1024) == nil, 400, "VALIDATION", "Upload a file under 512 KiB.")
	defer r.R.MultipartForm.RemoveAll()
	form := func(key string) string { return strings.TrimSpace(r.R.FormValue(key)) }
	kind, access, scope, slot := "sound", "soundboardPlus", "", 0
	if admin {
		kind, access, scope = form("kind"), form("access"), form("serverId")
		if value := form("freeSlot"); value != "" {
			Check(kind == "sound" && access == "free" && scope == "" && len(value) == 1 && value[0] >= '1' && value[0] <= '8', 400, "VALIDATION", "Use a free sound slot between 1 and 8.")
			slot = int(value[0] - '0')
		}
		Check(serviceIn(kind, catalogKinds...) && serviceIn(access, catalogAccess...), 400, "VALIDATION", "Invalid catalog item.")
		Check((access != "communityPlus" || scope != "") && (access != "awarded" || kind == "badge"), 400, "VALIDATION", "Invalid catalog access.")
	}
	label := VString(M{"label": form("label")}, "label", 1, 60, true)
	pack := VString(M{"pack": form("pack")}, "pack", 0, 40, true)
	Check(kind != "sound" || access != "free" || scope != "" || slot > 0 || pack != "", 400, "VALIDATION", "Give a free bonus sound a pack name.")
	file, _, err := r.R.FormFile("file")
	Check(err == nil, 400, "VALIDATION", "Choose a file.")
	defer file.Close()
	input, err := io.ReadAll(io.LimitReader(file, 512*1024+1))
	Check(err == nil && len(input) <= 512*1024, 400, "VALIDATION", "Upload a file under 512 KiB.")
	var data []byte
	var mime string
	if kind == "sound" {
		data, mime = validateCatalogSound(input)
	} else {
		data, mime = validateCatalogImage(input, kind)
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	return a.DB.Tx(func(tx *DB) any {
		requireLiveSession(tx, r)
		if admin {
			Administrator(tx, r.UID())
		} else {
			Check(featureAvailable(tx, r.UID(), "soundboardPlus"), 403, "FEATURE_REQUIRED", "Soundboard Plus is required.")
			Check(N(tx.One("SELECT COUNT(*) AS count FROM feature_catalog WHERE owner_id=? AND active=0 AND published=0", r.UID())["count"]) < 3, 409, "LIMIT", "You already have three pending sounds.")
		}
		stats := tx.One("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM feature_catalog")
		Check(N(stats["count"]) < 512 && N(stats["bytes"])+int64(len(data)) <= 32*1024*1024, 409, "LIMIT", "The catalog has reached its storage budget.")
		var server, freeSlot any
		if scope != "" {
			Check(tx.One("SELECT id FROM servers WHERE id=?", VID(scope)) != nil, 404, "NOT_FOUND", "Community not found.")
			server = scope
			if kind == "emoji" || kind == "sticker" {
				limit := int64(8)
				if communityEnabled(tx, scope) {
					limit = N(tx.One("SELECT community_emoji_slots FROM servers WHERE id=?", scope)["community_emoji_slots"])
				}
				Check(N(tx.One("SELECT COUNT(*) AS count FROM feature_catalog WHERE server_id=? AND kind IN ('emoji','sticker') AND (active=1 OR published=0)", scope)["count"]) < limit, 409, "LIMIT", "This community has reached its emoji and sticker slot limit.")
			}
		}
		if slot > 0 {
			freeSlot = slot
		}
		freeBytes, diskErr := mediaFreeBytes(a.C.DataDir)
		Check(diskErr == nil && freeBytes-int64(len(data)) >= int64(a.C.UploadReserveMiB)*mediaMiB, 507, "CATALOG_STORAGE", "Catalog storage is below its disk reserve.")
		catalogPutFile(filepath.Join(a.C.DataDir, "catalog"), digest, data)
		id := ID()
		var owner any
		if !admin {
			owner = r.UID()
		}
		tx.Run("INSERT INTO feature_catalog(id,kind,label,pack,digest,mime,bytes,access,server_id,free_slot,owner_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, kind, label, pack, digest, mime, len(data), access, server, freeSlot, owner)
		Audit(tx, r.UID(), "feature.catalog.upload", id, M{"kind": kind, "label": label})
		return M{"id": id, "active": false}
	})
}

var profileColumns = map[string]string{"avatar": "catalog_avatar", "badge": "profile_badge", "frame": "profile_frame", "banner": "profile_banner", "accent": "profile_accent"}

func (a *App) selectProfileAsset(r *Request) any {
	Strict(r.Body, "kind", "value", "requestId")
	kind := VEnum(r.Body, "kind", []string{"avatar", "badge", "frame", "banner", "accent"})
	value := VString(r.Body, "value", 0, 80, true)
	result := a.DB.Tx(func(tx *DB) any {
		requireLiveSession(tx, r)
		if value != "" {
			if kind == "accent" {
				Check(accentPattern.MatchString(value) && featureAvailable(tx, r.UID(), "profilePlus"), 403, "FEATURE_REQUIRED", "An accent color requires Profile Plus.")
			} else {
				item := tx.One("SELECT * FROM feature_catalog WHERE id=? AND kind=? AND owner_id IS NULL", VID(value), kind)
				Check(catalogUsable(tx, r.UID(), item, ""), 403, "FEATURE_REQUIRED", "This profile item is unavailable.")
				value = catalogURL(item)
			}
		}
		if kind == "badge" {
			awarded := Str(tx.One("SELECT profile_badge_award FROM users WHERE id=?", r.UID()), "profile_badge_award")
			Check(awarded == "", 409, "BADGE_AWARDED", "Your profile has an administrator-awarded badge.")
		}
		tx.Run("UPDATE users SET "+profileColumns[kind]+"=? WHERE id=?", value, r.UID())
		return M{"success": true}
	})
	a.Hub.Notify("state:changed", M{})
	a.Hub.Notify("voice:state:changed", M{})
	return result
}

func (a *App) awardProfileBadge(r *Request) any {
	Strict(r.Body, "id", "requestId")
	uid, id := r.Param("id"), VString(r.Body, "id", 0, 80, true)
	result := featureAdmin(r, func(tx *DB) any {
		accountFeatureView(tx, uid)
		value := ""
		if id != "" {
			item := tx.One("SELECT * FROM feature_catalog WHERE id=? AND kind='badge' AND access='awarded' AND active=1 AND server_id IS NULL", VID(id))
			Check(item != nil, 404, "NOT_FOUND", "This award badge is unavailable.")
			value = catalogURL(item)
		}
		tx.Run("UPDATE users SET profile_badge_award=? WHERE id=?", value, uid)
		Audit(tx, r.UID(), "feature.badge", uid, M{"id": id})
		return M{"success": true}
	})
	a.Hub.Notify("state:changed", M{})
	a.Hub.Notify("voice:state:changed", M{})
	return result
}

func validateCustomEmoji(tx *DB, uid, text string, conversation M) {
	if !strings.Contains(text, ":dx-") {
		return
	}
	var ids = map[string]bool{}
	for _, match := range customEmojiPattern.FindAllStringSubmatch(text, -1) {
		ids[match[1]] = true
	}
	Check(len(ids) <= 24, 400, "LIMIT", "A message can contain up to 24 different catalog emoji.")
	if len(ids) == 0 {
		return
	}
	server := ""
	if Str(conversation, "kind") == "channel" {
		server = Str(tx.One("SELECT server_id FROM channels WHERE conversation_id=?", conversation["id"]), "server_id")
	}
	for id := range ids {
		item := tx.One("SELECT * FROM feature_catalog WHERE id=? AND kind IN ('emoji','sticker')", id)
		Check(catalogUsable(tx, uid, item, server), 403, "FEATURE_REQUIRED", "This emoji or sticker is unavailable.")
	}
}
