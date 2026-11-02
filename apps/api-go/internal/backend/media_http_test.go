package backend

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type mediaHTTPFixture struct {
	m      *Media
	tokens map[string]string
}

func newMediaHTTP(t *testing.T) mediaHTTPFixture {
	m, _, _ := mediaTestStore(t)
	a := m.a
	a.Mux = http.NewServeMux()
	a.Media = m
	a.Hub = &Hub{a: a, peers: map[string]*peer{}}
	a.Games = NewGames(a)
	t.Cleanup(a.Games.Close)
	a.C.UploadHardMiB = 8
	a.C.UploadSoftMiB = 4
	a.C.UploadSmallMiB = 2
	a.Service.C.MaxMessages = 1000
	m.RegisterRoutes()
	tokens := map[string]string{}
	for _, uid := range []string{"owner", "peer", "outsider"} {
		token := Token()
		tokens[uid] = token
		a.DB.Run("INSERT INTO sessions(id,user_id,access_hash,csrf,access_expires,expires_at,created_at) VALUES(?,?,?,?,?,?,?)", ID(), uid, Hash(token), Token(), Now()+60000, Now()+120000, Now())
	}
	return mediaHTTPFixture{m, tokens}
}
func (f mediaHTTPFixture) call(uid, method, path string, body any, kind string) *httptest.ResponseRecorder {
	var data []byte
	switch v := body.(type) {
	case []byte:
		data = v
	case nil:
	default:
		data = []byte(JSON(v))
		if kind == "" {
			kind = "application/json"
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	if uid != "" {
		req.Header.Set("Authorization", "Bearer "+f.tokens[uid])
	}
	if kind != "" {
		req.Header.Set("Content-Type", kind)
	}
	rec := httptest.NewRecorder()
	f.m.a.middleware(f.m.a.Mux).ServeHTTP(rec, req)
	return rec
}
func mediaHTTPJSON(t *testing.T, r *httptest.ResponseRecorder, status int) M {
	t.Helper()
	if r.Code != status {
		t.Fatalf("HTTP%d want%d: %s", r.Code, status, r.Body.String())
	}
	if r.Body.Len() == 0 {
		return M{}
	}
	return Obj(Parse(r.Body.String()))
}
func TestMediaHTTPUploadReservationTicketsAndQuota(t *testing.T) {
	f := newMediaHTTP(t)
	data := []byte("\x89PNG\r\n\x1a\nsmall upload")
	request := M{"conversationId": "dm", "name": "سلام.png", "size": len(data), "requestId": ID()}
	reserved := mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments", request, ""), 200)
	id := Str(reserved, "id")
	again := mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments", request, ""), 200)
	if Str(again, "id") != id {
		t.Fatal("reservation duplicated")
	}
	request["name"] = "other.png"
	mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments", request, ""), 409)
	mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments/"+id+"/content", data, "application/octet-stream"), 200)
	mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments/"+id+"/content", data, "application/octet-stream"), 200)
	draft := mediaHTTPJSON(t, f.call("owner", "GET", "/api/v1/attachments/"+id+"/status", nil, ""), 200)
	if !Bool(draft, "available") {
		t.Fatal("draft unavailable")
	}
	posted := f.m.a.Service.Send("owner", ID(), "dm", "", ServiceUndefined{}, []string{id}, false)
	if Str(Obj(posted["payload"]), "id") == "" {
		t.Fatal("attachment message missing")
	}
	mediaHTTPJSON(t, f.call("owner", "GET", "/api/v1/attachments/"+id+"/status", nil, ""), 410)
	preview := mediaHTTPJSON(t, f.call("peer", "POST", "/api/v1/attachments/"+id+"/preview", M{"requestId": ID()}, ""), 200)
	path := Str(preview, "path")
	rec := f.call("", "GET", path, nil, "")
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatalf("ticketed media=%d %s", rec.Code, rec.Body.String())
	}
	mediaHTTPJSON(t, f.call("", "GET", "/api/v1/attachments/"+id+"/media", nil, ""), 401)
	mediaHTTPJSON(t, f.call("outsider", "POST", "/api/v1/attachments/"+id+"/preview", M{"requestId": ID()}, ""), 403)
	old := path
	for i := 0; i < 32; i++ {
		preview = mediaHTTPJSON(t, f.call("peer", "POST", "/api/v1/attachments/"+id+"/preview", M{"requestId": ID()}, ""), 200)
	}
	mediaHTTPJSON(t, f.call("", "GET", old, nil, ""), 401)
	fresh := Str(preview, "path")
	rec = f.call("peer", "GET", "/api/v1/attachments/"+id+"/download", nil, "")
	if rec.Code != 200 || !strings.Contains(rec.Header().Get("Content-Disposition"), "filename*=UTF-8''") || !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatal("download did not preserve bytes/name")
	}
	f.m.a.DB.Run("DELETE FROM sessions WHERE user_id='peer'")
	mediaHTTPJSON(t, f.call("", "GET", fresh, nil, ""), 401)
	usage := mediaHTTPJSON(t, f.call("owner", "GET", "/api/v1/uploads/usage", nil, ""), 200)
	if Num(usage, "usedBytes") != int64(len(data)) {
		t.Fatal("idempotent upload charged twice", usage)
	}
	f.m.a.DB.Run("INSERT INTO attachment_usage(id,user_id,bytes,created_at) VALUES(?,?,?,?)", ID(), "owner", 300*mediaMiB, Now())
	mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments", M{"conversationId": "dm", "name": "quota.txt", "size": 1, "requestId": ID()}, ""), 429)
}
func TestMediaHTTPInvalidUploadIsReconciled(t *testing.T) {
	f := newMediaHTTP(t)
	request := M{"conversationId": "dm", "name": "malware.png", "size": 8, "requestId": ID()}
	id := Str(mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments", request, ""), 200), "id")
	mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments/"+id+"/content", []byte("MZbinary"), "application/octet-stream"), 400)
	if Str(f.m.a.DB.One("SELECT state FROM attachments WHERE id=?", id), "state") != "unavailable" {
		t.Fatal("invalid upload remained ready")
	}
	if _, e := os.Stat(f.m.file(id, true)); !os.IsNotExist(e) {
		t.Fatal("partial invalid upload retained")
	}
	mediaHTTPJSON(t, f.call("owner", "POST", "/api/v1/attachments", M{"conversationId": "dm", "name": "text.txt", "size": "1", "requestId": ID()}, ""), 400)
}
func TestMediaHTTPProfileAndServerIconPersistWebP(t *testing.T) {
	f := newMediaHTTP(t)
	a := f.m.a
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('server','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('server','owner','owner',?)", Now())
	img := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for y := 0; y < 30; y++ {
		for x := 0; x < 40; x++ {
			img.Set(x, y, color.RGBA{R: 180, B: 230, A: 255})
		}
	}
	var data bytes.Buffer
	png.Encode(&data, img)
	upload := func(route, rid string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		part, _ := form.CreatePart(map[string][]string{"Content-Disposition": {`form-data; name="image"; filename="image.png"`}, "Content-Type": {"image/png"}})
		part.Write(data.Bytes())
		form.Close()
		req := httptest.NewRequest("POST", route, &body)
		req.Header.Set("Authorization", "Bearer "+f.tokens["owner"])
		req.Header.Set("X-Request-Id", rid)
		req.Header.Set("Content-Type", form.FormDataContentType())
		rec := httptest.NewRecorder()
		a.middleware(a.Mux).ServeHTTP(rec, req)
		return rec
	}
	for _, test := range []struct{ route, field string }{{"/api/v1/profile/avatar", "avatar"}, {"/api/v1/servers/server/icon", "icon"}} {
		rid := ID()
		result := mediaHTTPJSON(t, upload(test.route, rid), 200)
		path := Str(result, test.field)
		again := mediaHTTPJSON(t, upload(test.route, rid), 200)
		if Str(again, test.field) != path {
			t.Fatal("retry wrote second image")
		}
		encoded, e := os.ReadFile(filepath.Join(a.C.DataDir, filepath.FromSlash(strings.TrimPrefix(path, "/"))))
		if e != nil {
			t.Fatal(e)
		}
		cfg, format, e := image.DecodeConfig(bytes.NewReader(encoded))
		if e != nil || format != "webp" || cfg.Width != 128 || cfg.Height != 128 {
			t.Fatal("invalid persisted WebP", format, cfg, e)
		}
		if len(encoded) > 96*1024 {
			t.Fatal("thumbnail exceeds budget")
		}
	}
	mediaHTTPJSON(t, f.call("owner", "DELETE", "/api/v1/servers/server/icon", M{"requestId": ID()}, ""), 200)
	if Str(a.DB.One("SELECT icon FROM servers WHERE id='server'"), "icon") != "" {
		t.Fatal("server icon removal")
	}
	metrics := f.m.images.metrics()
	if Num(metrics, "completed") != 4 {
		t.Fatal("image decoder did not run for retries", JSON(metrics), strconv.Itoa(int(Num(metrics, "completed"))))
	}
}
