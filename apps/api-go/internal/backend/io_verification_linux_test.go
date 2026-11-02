package backend

import (
	"net/http/httptest"
	"os"
	"testing"
)

func TestLinuxVerificationReuseStillDetectsRestoredMtimeCorruption(t *testing.T) {
	m, id, data := mediaTestStore(t)
	serve := func(preview bool, method string) (err any) {
		defer func() { err = recover() }()
		req := httptest.NewRequest(method, "/download", nil)
		req.SetPathValue("id", id)
		m.serveAttachment(&Request{A: m.a, W: httptest.NewRecorder(), R: req, User: M{"id": "peer"}}, preview)
		return nil
	}
	if err := serve(false, "GET"); err != nil {
		t.Fatal(err)
	}
	if err := serve(true, "HEAD"); err != nil {
		t.Fatal(err)
	}
	if m.verifiedReads != 1 || m.verificationHits != 1 {
		t.Fatalf("verification was not shared: %d %d", m.verifiedReads, m.verificationHits)
	}
	path := m.file(id, false)
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 1
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, st.ModTime(), st.ModTime()); err != nil {
		t.Fatal(err)
	}
	if serve(false, "HEAD") == nil {
		t.Fatal("same-size, restored-mtime corruption bypassed verification")
	}
}
