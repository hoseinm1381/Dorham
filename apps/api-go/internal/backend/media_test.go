package backend

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	webp "golang.org/x/image/webp"
)

func TestMediaRanges(t *testing.T) {
	for _, test := range []struct {
		header           string
		size, start, end int64
		present, bad     bool
	}{
		{"", 100, 0, 99, false, false}, {"bytes=0-0", 100, 0, 0, true, false}, {"bytes=5-", 100, 5, 99, true, false}, {"bytes=-5", 100, 95, 99, true, false}, {"bytes=-500", 100, 0, 99, true, false}, {"bytes=1-999", 100, 1, 99, true, false},
		{"bytes=100-", 100, 0, 0, false, true}, {"bytes=-0", 100, 0, 0, false, true}, {"bytes=2-1", 100, 0, 0, false, true}, {"bytes=0-1,3-4", 100, 0, 0, false, true}, {"bytes=-", 100, 0, 0, false, true}, {"bytes=9999999999999999999999-", 100, 0, 0, false, true}, {"bytes=0-0", 0, 0, 0, false, true},
	} {
		t.Run(test.header, func(t *testing.T) {
			start, end, present, err := mediaByteRange(test.header, test.size)
			if (err != nil) != test.bad {
				t.Fatalf("error=%v", err)
			}
			if !test.bad && (start != test.start || end != test.end || present != test.present) {
				t.Fatalf("got %d-%d %v", start, end, present)
			}
		})
	}
}
func TestMediaSignatures(t *testing.T) {
	for _, test := range []struct {
		name   string
		prefix []byte
		mime   string
		upload bool
	}{
		{"photo.PNG", []byte("\x89PNG\r\n\x1a\n"), "image/png", true}, {"bad.png", []byte("not image"), "", false}, {"clip.mp4", []byte("0000ftypisom"), "video/mp4", true}, {"clip.mp4", []byte("not video"), "", true}, {"code.txt", []byte("MZexecutable"), "", false}, {"code.txt", []byte("\x7fELF"), "", false}, {"image.webp", []byte("RIFF0000WEBP"), "image/webp", true}, {"animated.gif", []byte("GIF89a"), "image/gif", true}, {"clip.webm", append([]byte{0x1a, 0x45, 0xdf, 0xa3}, []byte("webm")...), "video/webm", true},
	} {
		if got := mediaMIME(test.name, test.prefix); got != test.mime {
			t.Errorf("%s MIME=%q want%q", test.name, got, test.mime)
		}
		if got := mediaSignature(test.name, test.prefix); got != test.upload {
			t.Errorf("%s upload=%v", test.name, got)
		}
	}
}
func TestMediaJWTAuthenticatesAndExpires(t *testing.T) {
	raw := mediaJWT("key", "secret", "user:epoch", M{"roomJoin": true, "room": "voice", "canPublishSources": []string{"microphone"}}, 60)
	claims := mediaVerifyJWT(raw, "key", "secret")
	if Str(claims, "sub") != "user:epoch" || Str(Obj(claims["video"]), "room") != "voice" {
		t.Fatal("invalid claims")
	}
	for _, value := range []string{raw + "x", strings.Replace(raw, ".", "x", 1), "", "x.y.z"} {
		if mediaVerifyJWT(value, "key", "secret") != nil {
			t.Fatal("tampered accepted")
		}
	}
	if mediaVerifyJWT(raw, "key", "wrong") != nil || mediaVerifyJWT(raw, "wrong", "secret") != nil {
		t.Fatal("wrong credentials accepted")
	}
	if mediaVerifyJWT(mediaJWT("key", "secret", "id", M{}, -1), "key", "secret") != nil {
		t.Fatal("expired accepted")
	}
	parts := strings.Split(raw, ".")
	parts[0] = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	if mediaVerifyJWT(strings.Join(parts, "."), "key", "secret") != nil {
		t.Fatal("algorithm confusion accepted")
	}
}
func TestMediaImageOrientation(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 3))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(1, 2, color.NRGBA{B: 255, A: 255})
	rotated := mediaOrient(img, 6)
	if rotated.Bounds().Dx() != 3 || rotated.Bounds().Dy() != 2 {
		t.Fatal("rotation dimensions")
	}
	r, _, _, _ := rotated.At(2, 0).RGBA()
	if r != 65535 {
		t.Fatal("rotation pixel")
	}
	for _, data := range [][]byte{nil, []byte("\xff\xd8\xff"), []byte("\xff\xd8\xff\xe1\xff\xff")} {
		if mediaOrientation(data) != 1 {
			t.Fatal("malformed EXIF")
		}
	}
}
func TestMediaImageResizeAndReadAdmission(t *testing.T) {
	images := newMediaImages()
	defer images.close()
	img := image.NewRGBA(image.Rect(0, 0, 256, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 256; x++ {
			img.Set(x, y, color.RGBA{R: byte(x), G: byte(y), A: 255})
		}
	}
	var pngdata bytes.Buffer
	png.Encode(&pngdata, img)
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, e := form.CreatePart(map[string][]string{"Content-Disposition": {`form-data; name="file"; filename="a.png"`}, "Content-Type": {"image/png"}})
	if e != nil {
		t.Fatal(e)
	}
	part.Write(pngdata.Bytes())
	form.Close()
	request := httptest.NewRequest("POST", "/profile/avatar", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	original, encoded := images.resize(&Request{R: request}, true)
	if !bytes.Equal(original, pngdata.Bytes()) {
		t.Fatal("input digest bytes changed")
	}
	config, e := webp.DecodeConfig(bytes.NewReader(encoded))
	if e != nil || config.Width != 128 || config.Height != 128 {
		t.Fatalf("WebPthumbnail %v %+v", e, config)
	}
	// Admission is acquired before reading uploads; a fourth request must fail immediately.
	release := images.acquire()
	defer release()
	ready := make(chan struct{}, 2)
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			ready <- struct{}{}
			func() { defer func() { recover() }(); unlock := images.acquire(); unlock() }()
			done <- struct{}{}
		}()
	}
	<-ready
	<-ready
	deadline := time.Now().Add(time.Second)
	for {
		images.mu.Lock()
		queued := images.queued
		images.mu.Unlock()
		if queued == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("queue not entered")
		}
		time.Sleep(time.Millisecond)
	}
	if mediaSafe(func() { images.acquire() }) {
		t.Fatal("fourth decoder request accepted")
	}
	images.close()
	<-done
	<-done
}
func TestMediaTicketScopeExpiry(t *testing.T) {
	m := &Media{tickets: map[string]mediaTicket{Hash(strings.Repeat("a", 43)): {"session", "file", Now() + 1000}}}
	if m.ResolveTicket(strings.Repeat("a", 43), "file") != "session" {
		t.Fatal("valid ticket missing")
	}
	if m.ResolveTicket(strings.Repeat("a", 43), "other") != "" || m.ResolveTicket("short", "file") != "" {
		t.Fatal("unscoped ticket")
	}
	m.tickets[Hash(strings.Repeat("a", 43))] = mediaTicket{"session", "file", Now() - 1}
	if m.ResolveTicket(strings.Repeat("a", 43), "file") != "" {
		t.Fatal("expired ticket")
	}
}
