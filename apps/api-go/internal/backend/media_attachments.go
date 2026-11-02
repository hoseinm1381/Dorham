package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"unicode/utf8"
)

var mediaExtensions = map[string]bool{".pdf": true, ".txt": true, ".md": true, ".csv": true, ".json": true, ".zip": true, ".7z": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".mp3": true, ".ogg": true, ".wav": true, ".mp4": true, ".webm": true}

func mediaRetention(size int64) int64 {
	if size <= 10*mediaMiB {
		return 7 * 86400000
	}
	return 86400000
}
func (m *Media) storage() M {
	row := m.a.DB.One("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state IN ('reserved','ready')")
	free, e := mediaFreeBytes(m.a.C.AttachmentDir)
	mediaMust(e)
	return M{"bytes": Num(row, "bytes"), "budget": int64(m.a.C.AttachmentBudgetMiB) * mediaMiB, "freeBytes": free, "reserveBytes": int64(m.a.C.UploadReserveMiB) * mediaMiB}
}
func (m *Media) Storage() M { return m.storage() }
func (m *Media) ResolveTicket(token, id string) string {
	if len(token) != 43 {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ticket, ok := m.tickets[Hash(token)]
	if !ok || ticket.File != id || ticket.Expires <= Now() {
		return ""
	}
	return ticket.Session
}
func (m *Media) available(uid, id string) M {
	row := m.a.DB.One("SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=? AND a.state='ready' AND a.expires_at>? AND m.deleted=0", id, Now())
	Check(row != nil, 410, "FILE_UNAVAILABLE", "This attachment has expired or is unavailable.")
	m.a.Service.Conversation(m.a.DB, uid, Str(row, "conversation_id"))
	return row
}
func (m *Media) reader(id string) func() {
	m.mu.Lock()
	count := 0
	for _, n := range m.readers {
		count += n
	}
	if count >= 4 {
		m.mu.Unlock()
		Fail(429, "DOWNLOAD_BUSY", "Downloads are busy. Retry shortly.")
	}
	m.readers[id]++
	m.mu.Unlock()
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		m.readers[id]--
		if m.readers[id] <= 0 {
			delete(m.readers, id)
		}
	}
}
func (m *Media) registerAttachments() {
	a := m.a
	a.Route("POST", "/api/v1/attachments", true, func(r *Request) any {
		Check(!Bool(r.User, "guest"), 403, "GUEST_UPLOAD", "Guests cannot upload files.")
		b := r.Body
		cid, name, rid, size := Str(b, "conversationId"), strings.TrimSpace(Str(b, "name")), mediaRequest(Str(b, "requestId")), Num(b, "size")
		valid := cid != "" && len(cid) <= 80 && utf8.RuneCountInString(name) > 0 && utf8.RuneCountInString(name) <= 180 && size >= 1 && size <= 100*mediaMiB && F(b["size"]) == float64(size)
		switch b["size"].(type) {
		case jsonNumber, float64, int, int64:
		default:
			valid = false
		}
		if _, ok := b["name"].(string); !ok {
			valid = false
		}
		if _, ok := b["conversationId"].(string); !ok {
			valid = false
		}
		for _, c := range name {
			if c < 32 || c == 127 || c == '/' || c == '\\' {
				valid = false
			}
		}
		Check(valid, 400, "VALIDATION", "Invalid attachment metadata.")
		Check(mediaExtensions[strings.ToLower(filepath.Ext(name))], 400, "FILE_TYPE", "This file type is not supported.")
		m.cleanupAttachments(size)
		storage := m.storage()
		return a.DB.Tx(func(tx *DB) any {
			a.Service.Conversation(tx, r.UID(), cid, true)
			old := tx.One("SELECT * FROM attachments WHERE user_id=? AND request_id=?", r.UID(), rid)
			if old != nil {
				Check(Str(old, "conversation_id") == cid && Str(old, "name") == name && Num(old, "size") == size, 409, "IDEMPOTENCY_CONFLICT", "Upload identifier already has different input.")
				return M{"id": old["id"], "state": old["state"], "expiresAt": Num(old, "expires_at")}
			}
			usage := tx.One("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE user_id=? AND created_at>?", r.UID(), Now()-86400000)
			Check(Num(usage, "bytes")+size <= 300*mediaMiB, 429, "UPLOAD_QUOTA", "The 300 MiB rolling daily upload allowance has been reached.")
			global := Num(tx.One("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE created_at>?", Now()-86400000), "bytes")
			Check(global+size <= int64(a.C.UploadHardMiB)*mediaMiB, 429, "UPLOAD_GLOBAL_HARD", "The shared daily upload allowance has been reached.")
			Check(global+size <= int64(a.C.UploadSoftMiB)*mediaMiB || size <= int64(a.C.UploadSmallMiB)*mediaMiB, 429, "UPLOAD_SMALL_ONLY", "Only files up to 2 MiB are allowed after the shared normal allowance is used. Compress pictures or try again later.")
			Check(tx.One("SELECT id FROM attachments WHERE user_id=? AND state='reserved'", r.UID()) == nil, 429, "UPLOAD_BUSY", "Finish or cancel your current upload first.")
			Check(Num(tx.One("SELECT COUNT(*) AS count FROM attachment_usage WHERE user_id=? AND created_at>?", r.UID(), Now()-86400000), "count") < 200, 429, "UPLOAD_COUNT", "At most 200 uploads are allowed per day.")
			pending := Num(tx.One("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state='reserved'"), "bytes")
			allocated := Num(tx.One("SELECT COALESCE(SUM(size),0) AS bytes FROM attachments WHERE state IN ('reserved','ready')"), "bytes")
			Check(allocated+size <= Num(storage, "budget") && Num(storage, "freeBytes")-pending-size >= Num(storage, "reserveBytes"), 507, "UPLOAD_STORAGE", "File storage has insufficient free space.")
			id, now := ID(), Now()
			expires := now + mediaRetention(size)
			tx.Run("INSERT INTO attachments(id,user_id,conversation_id,request_id,name,size,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)", id, r.UID(), cid, rid, name, size, "reserved", now, expires)
			tx.Run("INSERT INTO attachment_usage(id,user_id,bytes,created_at) VALUES(?,?,?,?)", id, r.UID(), size, now)
			return M{"id": id, "state": "reserved", "expiresAt": expires}
		})
	})
	a.Route("POST", "/api/v1/attachments/{id}/content", true, func(r *Request) any {
		id := mediaID(r.Param("id"))
		Check(!Bool(r.User, "guest"), 403, "GUEST_UPLOAD", "Guests cannot upload files.")
		m.mu.Lock()
		busy := len(m.writers) >= a.C.UploadConcurrency || m.writers[id]
		if !busy {
			m.writers[id] = true
		}
		m.mu.Unlock()
		Check(!busy, 429, "UPLOAD_BUSY", "Uploads are busy. Retry shortly.")
		owned, complete := false, false
		defer func() {
			m.mu.Lock()
			delete(m.writers, id)
			m.mu.Unlock()
			if owned && !complete {
				a.DB.Run("UPDATE attachments SET state='unavailable' WHERE id=? AND user_id=? AND state='reserved'", id, r.UID())
				os.Remove(m.file(id, true))
			}
		}()
		row := a.DB.One("SELECT * FROM attachments WHERE id=? AND user_id=?", id, r.UID())
		Check(row != nil, 404, "NOT_FOUND", "Upload is unavailable.")
		a.Service.Conversation(a.DB, r.UID(), Str(row, "conversation_id"), true)
		if Str(row, "state") == "ready" {
			return M{"id": id, "state": "ready"}
		}
		owned = Str(row, "state") == "reserved"
		Check(owned && Num(row, "created_at")+15*60000 >= Now(), 410, "UPLOAD_EXPIRED", "Upload reservation expired.")
		size := Num(row, "size")
		Check(r.R.ContentLength == size && strings.Split(r.R.Header.Get("Content-Type"), ";")[0] == "application/octet-stream", 400, "UPLOAD_SIZE", "Send exactly the reserved bytes as application/octet-stream.")
		f, e := os.OpenFile(m.file(id, true), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		mediaMust(e)
		defer f.Close()
		h := sha256.New()
		prefix := &mediaPrefix{max: 16}
		n, e := io.Copy(io.MultiWriter(f, h, prefix), io.LimitReader(r.R.Body, size+1))
		if e != nil || n != size {
			Fail(400, "UPLOAD_SIZE", "Upload was incomplete.")
		}
		mediaMust(f.Close())
		Check(mediaSignature(Str(row, "name"), prefix.bytes), 400, "FILE_TYPE", "File contents do not match the supported file type.")
		mediaMust(os.Rename(m.file(id, true), m.file(id, false)))
		a.DB.Run("UPDATE attachments SET state='ready',digest=? WHERE id=? AND state='reserved'", hex.EncodeToString(h.Sum(nil)), id)
		complete = true
		return M{"id": id, "state": "ready"}
	})
	a.Route("DELETE", "/api/v1/attachments/{id}", true, func(r *Request) any {
		id := mediaID(r.Param("id"))
		mediaRequest(Str(r.Body, "requestId"))
		m.mu.Lock()
		busy := m.writers[id]
		m.mu.Unlock()
		Check(!busy, 409, "UPLOAD_BUSY", "Cancel the active transfer before removing the reservation.")
		a.DB.Run("UPDATE attachments SET state='unavailable' WHERE id=? AND user_id=? AND message_id IS NULL", id, r.UID())
		m.cleanupAttachments(0)
		return M{"success": true}
	})
	a.Route("GET", "/api/v1/attachments/{id}/status", true, func(r *Request) any {
		row := a.DB.One("SELECT * FROM attachments WHERE id=? AND user_id=? AND message_id IS NULL AND state='ready' AND expires_at>?", r.Param("id"), r.UID(), Now())
		Check(row != nil, 410, "FILE_UNAVAILABLE", "This draft attachment has expired or is unavailable.")
		a.Service.Conversation(a.DB, r.UID(), Str(row, "conversation_id"), true)
		return M{"id": row["id"], "name": row["name"], "size": Num(row, "size"), "expiresAt": Num(row, "expires_at"), "available": true}
	})
	a.Route("GET", "/api/v1/uploads/usage", true, func(r *Request) any {
		limit := int64(300) * mediaMiB
		if Bool(r.User, "guest") {
			limit = 0
		}
		return M{"usedBytes": Num(a.DB.One("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE user_id=? AND created_at>?", r.UID(), Now()-86400000), "bytes"), "limitBytes": limit, "maxFileBytes": 100 * mediaMiB, "sharedUsedBytes": Num(a.DB.One("SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachment_usage WHERE created_at>?", Now()-86400000), "bytes"), "softBytes": int64(a.C.UploadSoftMiB) * mediaMiB, "hardBytes": int64(a.C.UploadHardMiB) * mediaMiB, "smallFileBytes": int64(a.C.UploadSmallMiB) * mediaMiB}
	})
	a.Route("POST", "/api/v1/attachments/{id}/preview", true, func(r *Request) any {
		mediaRequest(Str(r.Body, "requestId"))
		Check(len(r.Body) == 1, 400, "VALIDATION", "Unexpected preview input.")
		id := mediaID(r.Param("id"))
		m.available(r.UID(), id)
		m.mu.Lock()
		defer m.mu.Unlock()
		now := Now()
		owned := []string{}
		order := m.ticketOrder[:0]
		for _, k := range m.ticketOrder {
			t, ok := m.tickets[k]
			if !ok {
				continue
			}
			if t.Expires <= now {
				delete(m.tickets, k)
				continue
			}
			order = append(order, k)
			if t.Session == Str(r.Session, "id") {
				owned = append(owned, k)
			}
		}
		m.ticketOrder = order
		for len(owned) >= 32 {
			delete(m.tickets, owned[0])
			owned = owned[1:]
		}
		for len(m.tickets) >= 512 && len(m.ticketOrder) > 0 {
			delete(m.tickets, m.ticketOrder[0])
			m.ticketOrder = m.ticketOrder[1:]
		}
		ticket, expires := Token(), now+5*60000
		key := Hash(ticket)
		m.tickets[key] = mediaTicket{Str(r.Session, "id"), id, expires}
		m.ticketOrder = append(m.ticketOrder, key)
		return M{"path": "/api/v1/attachments/" + id + "/media?media_ticket=" + ticket, "expiresAt": expires}
	})
	a.Route("GET", "/api/v1/attachments/{id}/download", true, func(r *Request) any { return m.serveAttachment(r, false) })
	a.Route("GET", "/api/v1/attachments/{id}/media", true, func(r *Request) any { return m.serveAttachment(r, true) })
}

type mediaPrefix struct {
	max   int
	bytes []byte
}

func (p *mediaPrefix) Write(b []byte) (int, error) {
	if len(p.bytes) < p.max {
		n := p.max - len(p.bytes)
		if n > len(b) {
			n = len(b)
		}
		p.bytes = append(p.bytes, b[:n]...)
	}
	return len(b), nil
}
func mediaSignature(name string, p []byte) bool {
	hex := hex.EncodeToString(p)
	ext := strings.ToLower(filepath.Ext(name))
	if strings.HasPrefix(hex, "4d5a") || strings.HasPrefix(hex, "7f454c46") {
		return false
	}
	switch ext {
	case ".pdf":
		return strings.HasPrefix(string(p), "%PDF-")
	case ".png":
		return strings.HasPrefix(hex, "89504e470d0a1a0a")
	case ".jpg", ".jpeg":
		return strings.HasPrefix(hex, "ffd8ff")
	case ".gif":
		return strings.HasPrefix(string(p), "GIF8")
	case ".zip":
		return strings.HasPrefix(hex, "504b")
	case ".7z":
		return strings.HasPrefix(hex, "377abcaf271c")
	case ".webp":
		return len(p) >= 12 && string(p[8:12]) == "WEBP"
	}
	return true
}
func mediaMIME(name string, p []byte) string {
	ext := strings.ToLower(filepath.Ext(name))
	if !mediaSignature(name, p) {
		return ""
	}
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		if len(p) >= 6 && (string(p[:6]) == "GIF87a" || string(p[:6]) == "GIF89a") {
			return "image/gif"
		}
	case ".webp":
		if len(p) >= 12 && string(p[:4]) == "RIFF" && string(p[8:12]) == "WEBP" {
			return "image/webp"
		}
	case ".mp4":
		if len(p) >= 8 && string(p[4:8]) == "ftyp" {
			return "video/mp4"
		}
	case ".webm":
		if len(p) >= 4 && hex.EncodeToString(p[:4]) == "1a45dfa3" && strings.Contains(string(p), "webm") {
			return "video/webm"
		}
	}
	return ""
}

var mediaRangeRE = regexp.MustCompile(`^bytes=(\d*)-(\d*)$`)

func mediaByteRange(header string, size int64) (start, end int64, present bool, err error) {
	if header == "" {
		return 0, size - 1, false, nil
	}
	match := mediaRangeRE.FindStringSubmatch(header)
	if match == nil || (match[1] == "" && match[2] == "") {
		return 0, 0, false, fmt.Errorf("range")
	}
	end = size - 1
	if match[1] != "" {
		start, err = strconv.ParseInt(match[1], 10, 64)
		if err != nil {
			return
		}
		if match[2] != "" {
			end, err = strconv.ParseInt(match[2], 10, 64)
			if err != nil {
				return
			}
			if end >= size {
				end = size - 1
			}
		}
	} else {
		var suffix int64
		suffix, err = strconv.ParseInt(match[2], 10, 64)
		if err != nil {
			return
		}
		if suffix == 0 {
			return 0, 0, false, fmt.Errorf("range")
		}
		start = size - suffix
		if start < 0 {
			start = 0
		}
	}
	if start >= size || end < start || start < 0 {
		return 0, 0, false, fmt.Errorf("range")
	}
	return start, end, true, nil
}
func (m *Media) serveAttachment(r *Request, preview bool) any {
	id := mediaID(r.Param("id"))
	release := m.reader(id)
	defer release()
	row := m.available(r.UID(), id)
	filename := m.file(id, false)
	f, e := os.Open(filename)
	if e == nil {
		defer f.Close()
	}
	var info os.FileInfo
	if e == nil {
		info, e = f.Stat()
	}
	invalid := func() {
		if !preview {
			m.a.DB.Run("UPDATE attachments SET state='unavailable' WHERE id=?", id)
		}
		Fail(410, "FILE_UNAVAILABLE", "This attachment is missing or corrupted.")
	}
	if e != nil || !info.Mode().IsRegular() || info.Size() != Num(row, "size") {
		invalid()
	}
	mime := func() string {
		mime := ""
		key := fmt.Sprintf("%s/%d/%d/%s", Str(row, "digest"), info.Size(), info.ModTime().UnixNano(), mediaFileVersion(info))
		m.verifyMu.Lock()
		defer m.verifyMu.Unlock()
		{
			m.mu.Lock()
			cached := m.checked[id]
			m.mu.Unlock()
			if cached.Key == key && cached.Expires > Now() && cached.Info != nil && os.SameFile(cached.Info, info) && mediaFileVersion(info) != "" {
				mime = cached.MIME
				atomic.AddInt64(&m.verificationHits,1)
			}
		}
		if mime == "" {
			digest, prefix, e := mediaHashReader(f)
			atomic.AddInt64(&m.verifiedReads,1)
			if e != nil || digest == "" || digest != Str(row, "digest") {
				invalid()
			}
			mime = mediaMIME(Str(row, "name"), prefix)
			if mime == "" {
				mime = "application/octet-stream"
			}
			after, err := f.Stat()
			if err != nil || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) || mediaFileVersion(after) != mediaFileVersion(info) {
				invalid()
			}
			{
				m.mu.Lock()
				if len(m.checked) >= 64 {
					for k := range m.checked {
						delete(m.checked, k)
						break
					}
				}
				m.checked[id] = mediaChecked{Key: key, MIME: mime, Expires: Now() + 60000, Info: info}
				m.mu.Unlock()
			}
		}
		if preview {
			Check(mime != "application/octet-stream", 415, "PREVIEW_UNSUPPORTED", "This file cannot be previewed. Download it to view.")
		}
		return mime
	}()
	r.Header("X-Content-Type-Options", "nosniff")
	r.Header("Content-Security-Policy", "sandbox; default-src 'none'")
	start, end, present := int64(0), info.Size()-1, false
	if preview {
		r.Header("Content-Type", mime)
		r.Header("Content-Disposition", "inline")
		r.Header("Cache-Control", "private, no-store")
		r.Header("Referrer-Policy", "no-referrer")
		r.Header("Accept-Ranges", "bytes")
		start, end, present, e = mediaByteRange(r.R.Header.Get("Range"), info.Size())
		if e != nil {
			r.Header("Content-Range", fmt.Sprintf("bytes */%d", info.Size()))
			r.W.WriteHeader(416)
			return nil
		}
	} else {
		r.Header("Content-Type", "application/octet-stream")
		r.Header("Cache-Control", "no-store")
		encoded := url.PathEscape(Str(row, "name"))
		encoded = strings.ReplaceAll(encoded, "'", "%27")
		encoded = strings.ReplaceAll(encoded, "(", "%28")
		encoded = strings.ReplaceAll(encoded, ")", "%29")
		r.Header("Content-Disposition", fmt.Sprintf("attachment; filename=\"download%s\"; filename*=UTF-8''%s", filepath.Ext(Str(row, "name")), encoded))
	}
	r.Header("Content-Length", strconv.FormatInt(end-start+1, 10))
	if present {
		r.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, info.Size()))
		r.W.WriteHeader(http.StatusPartialContent)
	} else {
		r.W.WriteHeader(http.StatusOK)
	}
	if r.R.Method != "HEAD" {
		_, _ = io.CopyN(r.W, io.NewSectionReader(f, start, end-start+1), end-start+1)
	}
	return nil
}
func (m *Media) cleanupAttachments(required int64, forceScan ...bool) {
	m.mu.Lock()
	if m.sweeping {
		m.mu.Unlock()
		return
	}
	m.sweeping = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.sweeping = false; m.mu.Unlock() }()
	a := m.a
	storage := m.storage()
	reclaimed := int64(0)
	for _, row := range a.DB.All("SELECT * FROM attachments WHERE state<>'removed' AND (state<>'reserved' OR created_at<?) ORDER BY CASE WHEN expires_at<? OR state<>'ready' THEN 0 ELSE 1 END,created_at LIMIT 100", Now()-15*60000, Now()) {
		id := Str(row, "id")
		m.mu.Lock()
		active := m.writers[id] || m.readers[id] > 0
		m.mu.Unlock()
		if active || !mediaUUID.MatchString(id) {
			continue
		}
		expired := Num(row, "expires_at") < Now() || Str(row, "state") != "ready"
		pressure := Num(storage, "bytes")-reclaimed+required > Num(storage, "budget") || Num(storage, "freeBytes")+reclaimed-required < Num(storage, "reserveBytes")
		if !expired && !pressure {
			continue
		}
		a.DB.Run("UPDATE attachments SET state='unavailable' WHERE id=?", id)
		removed := true
		for _, partial := range []bool{false, true} {
			e := os.Remove(m.file(id, partial))
			if e != nil && !os.IsNotExist(e) {
				removed = false
			}
		}
		if removed {
			reclaimed += Num(row, "size")
			a.DB.Run("UPDATE attachments SET state='removed' WHERE id=?", id)
		}
		if Str(row, "message_id") != "" && a.DB.One("SELECT id FROM messages WHERE id=?", row["message_id"]) != nil {
			event := a.DB.Tx(func(tx *DB) any {
				return a.Service.Event(tx, Str(row, "conversation_id"), "message", a.Service.MessageView(tx, Str(row, "message_id")))
			})
			a.Hub.Notify("conversation:event", event)
		}
	}
	// A bounded cursor prevents directory reconciliation from retaining all names.
	a.DB.Run("DELETE FROM attachment_usage WHERE id IN (SELECT id FROM attachment_usage WHERE created_at<? LIMIT 1000)", Now()-86400000)
	m.scanMu.Lock()
	defer m.scanMu.Unlock()
	if Now() < m.nextScan && (len(forceScan)==0 || !forceScan[0]) {
		return
	}
	if m.scan == nil {
		m.scan, _ = os.Open(a.C.AttachmentDir)
	}
	if m.scan != nil {
		entries, e := m.scan.ReadDir(100)
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || len(name) != 40 && len(name) != 41 {
				continue
			}
			ext := filepath.Ext(name)
			id := strings.TrimSuffix(name, ext)
			if !mediaUUID.MatchString(id) || (ext != ".bin" && ext != ".part") {
				continue
			}
			m.mu.Lock()
			active := m.writers[id] || m.readers[id] > 0
			m.mu.Unlock()
			if !active && a.DB.One("SELECT id FROM attachments WHERE id=?", id) == nil {
				os.Remove(filepath.Join(a.C.AttachmentDir, name))
			}
		}
		if e == io.EOF || len(entries) < 100 {
			m.scan.Close()
			m.scan = nil
			m.nextScan = Now() + 5*60000
		}
	}
}
