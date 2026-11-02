package backend

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func cappedPNG(t *testing.T, size int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 50, G: 150, B: 220, A: 255})
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	if size > out.Len() {
		out.Write(make([]byte, size-out.Len()))
	}
	return out.Bytes()
}
func imageCapRequest(t *testing.T, f mediaHTTPFixture, route string, image []byte, padding int, streamed bool) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	header := map[string][]string{"Content-Disposition": {`form-data; name="image"; filename="test.png"`}, "Content-Type": {"image/png"}}
	if padding < 0 {
		header["X-Envelope-Padding"] = []string{strings.Repeat("x", -padding)}
	}
	part, err := w.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(image); err != nil {
		t.Fatal(err)
	}
	if padding > 0 {
		field, e := w.CreateFormField("extra")
		if e != nil {
			t.Fatal(e)
		}
		field.Write(make([]byte, padding))
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", route, bytes.NewReader(body.Bytes()))
	if streamed {
		r.ContentLength = -1
		r.Body = io.NopCloser(bytes.NewReader(body.Bytes()))
	}
	r.Header.Set("Content-Type", w.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+f.tokens["owner"])
	r.Header.Set("X-Request-Id", ID())
	rec := httptest.NewRecorder()
	f.m.a.middleware(f.m.a.Mux).ServeHTTP(rec, r)
	return rec
}
func TestIntegrationProfileAndIconImageFileCapsBeforeDecode(t *testing.T) {
	f := newMediaHTTP(t)
	a := f.m.a
	a.DB.Run("INSERT INTO servers(id,name,owner_id,created_at) VALUES('image-caps','Server','owner',?)", Now())
	a.DB.Run("INSERT INTO members(server_id,user_id,role,joined_at) VALUES('image-caps','owner','owner',?)", Now())
	for _, route := range []string{"/api/v1/profile/avatar", "/api/v1/servers/image-caps/icon"} {
		accepted := imageCapRequest(t, f, route, cappedPNG(t, 256*1024), 0, false)
		if accepted.Code != 200 {
			t.Fatalf("exact256KiB image rejected at%s:HTTP%d %s", route, accepted.Code, accepted.Body.String())
		}
		before := Num(f.m.images.metrics(), "completed")
		for _, payload := range [][]byte{cappedPNG(t, 256*1024+1), bytes.Repeat([]byte("x"), 256*1024+1)} {
			r := imageCapRequest(t, f, route, payload, 0, false)
			if r.Code != 413 {
				t.Fatalf("oversized raw image reached decoder at%s:HTTP%d %s", route, r.Code, r.Body.String())
			}
			if Num(f.m.images.metrics(), "completed") != before {
				t.Fatal("oversized image was decoded or encoded")
			}
		}
	}
	files, err := os.ReadDir(filepath.Join(a.C.DataDir, "avatars"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("rejected image uploads left extra files: %d", len(files))
	}
}
func TestIntegrationImageMultipartEnvelopeBudget(t *testing.T) {
	f := newMediaHTTP(t)
	before := Num(f.m.images.metrics(), "completed")
	for _, streamed := range []bool{false, true} {
		// A single allowed file with an oversized header tests the envelope
		// budget independently of the separate prohibition on form fields.
		r := imageCapRequest(t, f, "/api/v1/profile/avatar", cappedPNG(t, 0), -513*1024, streamed)
		if r.Code != 413 {
			t.Fatalf("multipart body exceeding512KiB streamed=%v gotHTTP%d: %s", streamed, r.Code, r.Body.String())
		}
		if Num(f.m.images.metrics(), "completed") != before {
			t.Fatal("oversized envelope reached image decoding")
		}
	}
}

func TestIntegrationImageUploadRejectsExtraFormFields(t *testing.T) {
	f := newMediaHTTP(t)
	r := imageCapRequest(t, f, "/api/v1/profile/avatar", cappedPNG(t, 0), 1, false)
	if r.Code != 400 {
		t.Fatalf("file plus forbidden formfield returnedHTTP%d: %s", r.Code, r.Body.String())
	}
	if Num(f.m.images.metrics(), "completed") != 0 {
		t.Fatal("image with forbidden formfield was encoded")
	}
}
