package backend

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestMediaSFUTransientUnavailableRetriesOnceAndFailsClosed(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		recover    bool
		calls      int32
	}{
		{"temporary removal", "unavailable", true, 2},
		{"persistent failure", "unavailable", false, 2},
		{"permission denial", "permission_denied", false, 1},
		{"already removed", "not_found", false, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			m, _, _ := mediaTestStore(t)
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				if r.URL.Path != "/twirp/livekit.RoomService/RemoveParticipant" {
					t.Error("wrong control method")
				}
				if scenario.recover && n == 2 {
					json.NewEncoder(w).Encode(M{})
					return
				}
				w.WriteHeader(http.StatusServiceUnavailable)
				json.NewEncoder(w).Encode(M{"code": scenario.code})
			}))
			defer server.Close()
			m.a.C.LivekitAPIURL = server.URL
			_, err := m.twirp("RemoveParticipant", M{"room": "voice", "identity": "owner:epoch"}, M{"roomAdmin": true, "room": "voice"})
			if calls.Load() != scenario.calls || (err == nil) != scenario.recover {
				t.Fatalf("calls=%d error=%v", calls.Load(), err)
			}
			if !scenario.recover {
				failure, ok := err.(*mediaSFUError)
				if !ok || failure.code != scenario.code {
					t.Fatalf("control failure lost: %v", err)
				}
			}
		})
	}
}
