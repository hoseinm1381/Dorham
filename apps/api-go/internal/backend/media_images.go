package backend

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	webp "github.com/gen2brain/webp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

type mediaImages struct {
	mu                                  sync.Mutex
	slots                               chan struct{}
	waiting                             chan struct{}
	closed                              chan struct{}
	once                                sync.Once
	active, queued, rejected, completed int
}

func newMediaImages() *mediaImages {
	return &mediaImages{slots: make(chan struct{}, 1), waiting: make(chan struct{}, 2), closed: make(chan struct{})}
}
func (p *mediaImages) acquire() func() {
	select {
	case <-p.closed:
		Fail(503, "IMAGE_BUSY", "Image processing is unavailable. Try again shortly.")
	default:
	}
	select {
	case p.slots <- struct{}{}:
	default:
		select {
		case p.waiting <- struct{}{}:
		default:
			p.mu.Lock()
			p.rejected++
			p.mu.Unlock()
			Fail(429, "IMAGE_BUSY", "Image processing is busy. Try again shortly.")
		}
		p.mu.Lock()
		p.queued++
		p.mu.Unlock()
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		var failed int
		select {
		case p.slots <- struct{}{}:
		case <-timer.C:
			failed = 429
		case <-p.closed:
			failed = 503
		}
		<-p.waiting
		p.mu.Lock()
		p.queued--
		if failed == 429 {
			p.rejected++
		}
		p.mu.Unlock()
		if failed != 0 {
			Fail(failed, "IMAGE_BUSY", "Image processing is busy. Try again shortly.")
		}
	}
	select {
	case <-p.closed:
		<-p.slots
		Fail(503, "IMAGE_BUSY", "Image processing is unavailable. Try again shortly.")
	default:
	}
	p.mu.Lock()
	p.active = 1
	p.mu.Unlock()
	return func() { p.mu.Lock(); p.active = 0; p.mu.Unlock(); <-p.slots }
}
func (p *mediaImages) close() { p.once.Do(func() { close(p.closed) }) }
func (p *mediaImages) metrics() M {
	p.mu.Lock()
	defer p.mu.Unlock()
	return M{"active": p.active, "queued": p.queued, "maxActive": 1, "maxQueued": 2, "rejected": p.rejected, "completed": p.completed, "threadsPerImage": 1}
}
func (p *mediaImages) resize(r *Request, avatar bool) ([]byte, []byte) {
	release := p.acquire()
	defer release()
	reader, e := r.R.MultipartReader()
	required := "INVALID_IMAGE"
	message := "Choose a PNG, JPG or WebP image."
	if avatar {
		required = "IMAGE_REQUIRED"
		message = "Upload a PNG, JPEG, or WebP image."
	}
	Check(e == nil, 400, required, message)
	var data []byte
	found := false
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		var budget *http.MaxBytesError
		if errors.As(err, &budget) {
			Fail(413, "REQUEST_ERROR", "Image upload exceeds the server request limit.")
		}
		Check(err == nil, 400, required, message)
		if part.FileName() == "" {
			Fail(400, "INVALID_IMAGE", "Upload exactly one image without additional fields.")
		}
		Check(!found, 400, "INVALID_IMAGE", "Upload exactly one image.")
		found = true
		kind, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
		Check(kind == "image/png" || kind == "image/jpeg" || kind == "image/webp", 400, required, message)
		data, e = io.ReadAll(io.LimitReader(part, 256*1024+1))
		Check(e == nil && len(data) <= 256*1024, 413, "REQUEST_ERROR", "Image exceeds the 256 KiB server upload limit.")
		Check(part.Close() == nil, 400, required, message)
	}
	Check(found && len(data) > 0, 400, required, message)
	config, _, e := image.DecodeConfig(bytes.NewReader(data))
	Check(e == nil && config.Width > 0 && config.Height > 0 && int64(config.Width)*int64(config.Height) <= 16000000, 400, "INVALID_IMAGE", "Image could not be decoded.")
	decoded, _, e := image.Decode(bytes.NewReader(data))
	Check(e == nil, 400, "INVALID_IMAGE", "Image could not be decoded.")
	decoded = mediaOrient(decoded, mediaOrientation(data))
	b := decoded.Bounds()
	side := b.Dx()
	if b.Dy() < side {
		side = b.Dy()
	}
	crop := image.Rect(b.Min.X+(b.Dx()-side)/2, b.Min.Y+(b.Dy()-side)/2, b.Min.X+(b.Dx()+side)/2, b.Min.Y+(b.Dy()+side)/2)
	out := image.NewRGBA(image.Rect(0, 0, 128, 128))
	xdraw.CatmullRom.Scale(out, out.Bounds(), decoded, crop, draw.Src, nil)
	var encoded bytes.Buffer
	e = webp.Encode(&encoded, out, webp.Options{Quality: 80, Method: 4})
	Check(e == nil, 400, "INVALID_IMAGE", "Image could not be decoded.")
	Check(encoded.Len() <= 96*1024, 400, "IMAGE_TOO_LARGE", "Compressed image is too large.")
	p.mu.Lock()
	p.completed++
	p.mu.Unlock()
	return data, encoded.Bytes()
}

// JPEG EXIF orientation is bounded and parsed without allocating attacker-sized TIFF values.
func mediaOrientation(data []byte) int {
	if len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		for off := 12; off+8 <= len(data); {
			size := int64(data[off+4]) | int64(data[off+5])<<8 | int64(data[off+6])<<16 | int64(data[off+7])<<24
			if size < 0 || size > int64(len(data)-off-8) {
				return 1
			}
			if string(data[off:off+4]) == "EXIF" {
				return mediaTIFFOrientation(data[off+8 : off+8+int(size)])
			}
			off += 8 + int(size) + int(size%2)
		}
		return 1
	}
	if len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n" {
		for off := 8; off+12 <= len(data); {
			size := int64(data[off])<<24 | int64(data[off+1])<<16 | int64(data[off+2])<<8 | int64(data[off+3])
			if size > int64(len(data)-off-12) {
				return 1
			}
			if string(data[off+4:off+8]) == "eXIf" {
				return mediaTIFFOrientation(data[off+8 : off+8+int(size)])
			}
			off += 12 + int(size)
		}
		return 1
	}
	if len(data) < 4 || data[0] != 255 || data[1] != 216 {
		return 1
	}
	for off := 2; off+4 <= len(data); {
		if data[off] != 255 {
			return 1
		}
		marker := data[off+1]
		if marker == 218 || marker == 217 {
			return 1
		}
		size := int(data[off+2])<<8 | int(data[off+3])
		if size < 2 || off+2+size > len(data) {
			return 1
		}
		p := data[off+4 : off+2+size]
		off += 2 + size
		if marker == 225 && len(p) >= 6 && string(p[:6]) == "Exif\x00\x00" {
			return mediaTIFFOrientation(p)
		}
	}
	return 1
}
func mediaTIFFOrientation(t []byte) int {
	if len(t) >= 6 && string(t[:6]) == "Exif\x00\x00" {
		t = t[6:]
	}
	if len(t) < 8 {
		return 1
	}
	little := string(t[:2]) == "II"
	if !little && string(t[:2]) != "MM" {
		return 1
	}
	u16 := func(i int) int {
		if i < 0 || i+2 > len(t) {
			return -1
		}
		if little {
			return int(t[i]) | int(t[i+1])<<8
		}
		return int(t[i])<<8 | int(t[i+1])
	}
	u32 := func(i int) int {
		if i < 0 || i+4 > len(t) {
			return -1
		}
		if little {
			return int(t[i]) | int(t[i+1])<<8 | int(t[i+2])<<16 | int(t[i+3])<<24
		}
		return int(t[i])<<24 | int(t[i+1])<<16 | int(t[i+2])<<8 | int(t[i+3])
	}
	if u16(2) != 42 {
		return 1
	}
	pos := u32(4)
	count := u16(pos)
	if pos < 0 || count < 0 || count > 4096 {
		return 1
	}
	for i := 0; i < count; i++ {
		at := pos + 2 + 12*i
		if at+12 > len(t) {
			return 1
		}
		if u16(at) == 274 && u16(at+2) == 3 && u32(at+4) == 1 {
			value := u16(at + 8)
			if value >= 1 && value <= 8 {
				return value
			}
		}
	}
	return 1
}
func mediaOrient(src image.Image, orientation int) image.Image {
	if orientation <= 1 || orientation > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	out := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			sx, sy := x, y
			switch orientation {
			case 2:
				sx = w - 1 - x
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sy = h - 1 - y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			out.Set(x, y, src.At(b.Min.X+sx, b.Min.Y+sy))
		}
	}
	return out
}
func mediaDirectoryBytes(dir string) int64 {
	entries, e := os.ReadDir(dir)
	mediaMust(e)
	var size int64
	for _, entry := range entries {
		if entry.Type().IsRegular() {
			info, e := entry.Info()
			mediaMust(e)
			size += info.Size()
		}
	}
	return size
}
func mediaRetire(dir, old string) {
	if old == "" || !strings.HasPrefix(old, "/avatars/") {
		return
	}
	name := filepath.Base(old)
	if mediaUUID.MatchString(strings.TrimSuffix(name, ".webp")) && strings.HasSuffix(name, ".webp") {
		os.Remove(filepath.Join(dir, name))
	}
}
func (m *Media) registerImages() {
	a := m.a
	dir := filepath.Join(a.C.DataDir, "avatars")
	upload := func(r *Request, server bool) any {
		uid, rid := r.UID(), mediaRequest(r.R.Header.Get("X-Request-Id"))
		sid := ""
		if server {
			sid = r.Param("id")
			a.Service.Member(a.DB, uid, sid, "manageChannels")
		} else {
			Check(!Bool(r.User, "guest"), 403, "GUEST_UPLOAD", "Guests cannot upload files.")
		}
		original, thumbnail := m.images.resize(r, !server)
		kind := "avatar.change"
		payload := M{"hash": Hash(base64.StdEncoding.EncodeToString(original))}
		if server {
			kind = "server.icon"
			payload = M{"serverId": sid, "digest": Hash(base64.StdEncoding.EncodeToString(original))}
		}
		retired, written := "", ""
		committed := false
		defer func() {
			if !committed && written != "" {
				os.Remove(filepath.Join(dir, written))
			}
		}()
		result := a.Service.Mutate(uid, rid, kind, payload, func(tx *DB) any {
			if server {
				a.Service.Member(tx, uid, sid, "manageChannels")
			}
			Check(mediaDirectoryBytes(dir)+int64(len(thumbnail)) <= int64(a.C.MaxAvatarsMiB)*mediaMiB, 507, "AVATAR_QUOTA", "Avatar storage is full.")
			name := ID() + ".webp"
			f, e := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
			mediaMust(e)
			written = name
			_, e = f.Write(thumbnail)
			ce := f.Close()
			mediaMust(e)
			mediaMust(ce)
			if server {
				retired = Str(tx.One("SELECT icon FROM servers WHERE id=?", sid), "icon")
				tx.Run("UPDATE servers SET icon=? WHERE id=?", "/avatars/"+name, sid)
				return M{"icon": "/avatars/" + name}
			}
			retired = Str(tx.One("SELECT avatar FROM users WHERE id=?", uid), "avatar")
			tx.Run("UPDATE users SET avatar=? WHERE id=?", "/avatars/"+name, uid)
			return M{"avatar": "/avatars/" + name}
		})
		committed = true
		mediaRetire(dir, retired)
		a.Hub.Notify("state:changed", M{})
		if !server {
			a.Hub.Notify("voice:changed", M{})
		}
		return result
	}
	a.Route("POST", "/api/v1/profile/avatar", true, func(r *Request) any { return upload(r, false) })
	a.Route("POST", "/api/v1/servers/{id}/icon", true, func(r *Request) any { return upload(r, true) })
	a.Route("DELETE", "/api/v1/servers/{id}/icon", true, func(r *Request) any {
		sid := r.Param("id")
		rid := mediaRequest(Str(r.Body, "requestId"))
		retired := ""
		result := a.Service.Mutate(r.UID(), rid, "server.icon.remove", M{"serverId": sid}, func(tx *DB) any {
			a.Service.Member(tx, r.UID(), sid, "manageChannels")
			retired = Str(tx.One("SELECT icon FROM servers WHERE id=?", sid), "icon")
			tx.Run("UPDATE servers SET icon=NULL WHERE id=?", sid)
			return M{"success": true}
		})
		mediaRetire(dir, retired)
		a.Hub.Notify("state:changed", M{})
		return result
	})
}
