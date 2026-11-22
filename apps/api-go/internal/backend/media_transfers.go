package backend

import (
	"io"
	"os"
	"strconv"
	"strings"
)

func (m *Media) resumableUpload(r *Request, id string) M {
	row := m.a.DB.One("SELECT * FROM attachments WHERE id=? AND user_id=?", id, r.UID())
	Check(row != nil, 404, "NOT_FOUND", "Upload is unavailable.")
	m.a.Service.Conversation(m.a.DB, r.UID(), Str(row, "conversation_id"), true)
	state := Str(row, "state")
	Check(Num(row, "expires_at") > Now() && (state == "ready" || state == "reserved" && Num(row, "resume_until") > Now()), 410, "UPLOAD_EXPIRED", "Upload reservation expired.")
	return row
}

func (m *Media) uploadOffset(id string) int64 {
	for _, partial := range []bool{true, false} {
		info, err := os.Stat(m.file(id, partial))
		if err == nil && info.Mode().IsRegular() {
			return info.Size()
		}
	}
	return 0
}

func (m *Media) uploadChunk(r *Request) any {
	id := mediaID(r.Param("id"))
	Check(!Bool(r.User, "guest"), 403, "GUEST_UPLOAD", "Guests cannot upload files.")
	m.mu.Lock()
	busy := len(m.writers) >= m.a.C.UploadConcurrency || m.writers[id]
	if !busy {
		m.writers[id] = true
	}
	m.mu.Unlock()
	Check(!busy, 429, "UPLOAD_BUSY", "Uploads are busy. Retry shortly.")
	defer func() { m.mu.Lock(); delete(m.writers, id); m.mu.Unlock() }()
	row := m.resumableUpload(r, id)
	size := Num(row, "size")
	if Str(row, "state") == "ready" {
		return M{"offset": size, "state": "ready"}
	}
	offset, err := strconv.ParseInt(r.Query("offset"), 10, 64)
	current, count := m.uploadOffset(id), r.R.ContentLength
	Check(err == nil && offset >= 0 && offset == current && count >= 0 && count <= mediaMiB && count <= size-current, 409, "UPLOAD_OFFSET", "The upload offset changed. Resume from the saved position.")
	Check(strings.Split(r.R.Header.Get("Content-Type"), ";")[0] == "application/octet-stream" && (count > 0 || offset == size), 400, "UPLOAD_SIZE", "Send a file chunk or finalize the upload.")
	if count > 0 {
		f, err := os.OpenFile(m.file(id, true), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
		mediaMust(err)
		written, err := io.CopyN(f, r.R.Body, count)
		closeErr := f.Close()
		Check(err == nil && closeErr == nil && written == count, 400, "UPLOAD_INTERRUPTED", "Upload paused. Continue from the saved position.")
		current += written
	}
	if current < size {
		return M{"offset": current, "state": "reserved"}
	}
	path := m.file(id, true)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		path = m.file(id, false)
	}
	f, err := os.Open(path)
	mediaMust(err)
	digest, prefix, err := mediaHashReader(f)
	closeErr := f.Close()
	mediaMust(err)
	mediaMust(closeErr)
	if !mediaSignature(Str(row, "name"), prefix) {
		m.a.DB.Run("UPDATE attachments SET state='unavailable' WHERE id=? AND state='reserved'", id)
		Fail(400, "FILE_TYPE", "File contents do not match the supported file type.")
	}
	if path == m.file(id, true) {
		mediaMust(os.Rename(path, m.file(id, false)))
	}
	m.a.DB.Run("UPDATE attachments SET state='ready',digest=? WHERE id=? AND state='reserved'", digest, id)
	return M{"offset": size, "state": "ready"}
}
