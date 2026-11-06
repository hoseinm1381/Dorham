package backend

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRealtimeSpeechWAV(t *testing.T) {
	const model = "gpt-realtime-2.1-mini"
	const message = "سلام، Dorham! بازی ۲"
	const providerTranscript = "سلام دورهم بازی ۲"
	first, second := []byte{1, 0, 2, 0}, []byte{3, 0, 4, 0}
	tests := []struct {
		name, transcript, status string
		invalidAudio, wrongItem  bool
		wantMismatch             bool
	}{
		{name: "mixed Persian and English", transcript: "سلام DORHAM! بازي 2", status: "completed"},
		{name: "reworded message", transcript: providerTranscript, status: "completed", wantMismatch: true},
		{name: "missing transcript", status: "completed", wantMismatch: true},
		{name: "incomplete response", transcript: message, status: "incomplete"},
		{name: "bad base64", transcript: message, status: "completed", invalidAudio: true},
		{name: "wrong audio item", transcript: message, status: "completed", wrongItem: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/realtime" || r.URL.Query().Get("model") != model || r.Header.Get("Authorization") != "Bearer offline-fixture" {
					t.Error("incorrect Realtime connection")
					http.Error(w, "invalid test connection", http.StatusBadRequest)
					return
				}
				upgrader := websocket.Upgrader{}
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				if conn.WriteJSON(M{"type": "session.created"}) != nil {
					return
				}
				var request M
				if err := conn.ReadJSON(&request); err != nil {
					t.Error(err)
					return
				}
				response := Obj(request["response"])
				item := Obj(Arr(response["input"])[0])
				output := Obj(Obj(response["audio"])["output"])
				format := Obj(output["format"])
				if Str(request, "type") != "response.create" || Str(response, "conversation") != "none" ||
					Str(response, "tool_choice") != "none" || len(Arr(response["tools"])) != 0 ||
					Str(Obj(Arr(item["content"])[0]), "text") != message || Str(output, "voice") != "marin" ||
					Str(format, "type") != "audio/pcm" || N(format["rate"]) != realtimeSpeechSampleRate {
					t.Error("incorrect Realtime speech payload")
					return
				}
				if conn.WriteJSON(M{"type": "response.created", "response": M{"id": "resp_fixture"}}) != nil {
					return
				}
				for _, chunk := range [][]byte{first, second} {
					encoded := base64.StdEncoding.EncodeToString(chunk)
					if test.invalidAudio {
						encoded = "!"
					}
					if conn.WriteJSON(M{"type": "response.output_audio.delta", "response_id": "resp_fixture", "item_id": "audio_fixture", "delta": encoded}) != nil {
						return
					}
				}
				if test.transcript != "" {
					itemID := "audio_fixture"
					if test.wrongItem {
						itemID = "other_audio"
					}
					_ = conn.WriteJSON(M{"type": "response.output_audio_transcript.done", "response_id": "resp_fixture", "item_id": itemID, "transcript": test.transcript})
				}
				_ = conn.WriteJSON(M{"type": "response.done", "response": M{"id": "resp_fixture", "status": test.status,
					"usage": M{"input_tokens": 20, "output_tokens": 30,
						"input_token_details":  M{"text_tokens": 20, "cached_tokens": 10, "cached_tokens_details": M{"text_tokens": 10}},
						"output_token_details": M{"text_tokens": 5, "audio_tokens": 25}}}})
			}))
			defer server.Close()
			tlsConfig := server.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
			tlsConfig.ServerName = "127.0.0.1"
			dialer := &websocket.Dialer{
				TLSClientConfig: tlsConfig,
				NetDialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
					if addr != "api.openai.com:443" {
						return nil, errors.New("unexpected Realtime host")
					}
					var local net.Dialer
					return local.DialContext(ctx, network, server.Listener.Addr().String())
				},
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			var usage *speechTokenUsage
			audio, err := synthesizeRealtimeSpeech(ctx, dialer, "offline-fixture", model, "marin", message, func(value *speechTokenUsage) { usage = value })
			if !test.invalidAudio && !test.wrongItem {
				if !usage.valid() {
					t.Fatal("provider usage was lost")
				}
				if price, ok := usage.estimate(model); !ok || price != 518600 {
					t.Fatalf("unexpected provider cost: %d, %v", price, ok)
				}
			}
			if test.wantMismatch {
				if !errors.Is(err, errRealtimeSpeechMismatch) || len(audio) != 0 {
					t.Fatal("changed or missing transcript was accepted")
				}
			} else if test.status != "completed" || test.invalidAudio || test.wrongItem {
				if err == nil || len(audio) != 0 {
					t.Fatal("partial or invalid audio was accepted")
				}
			} else if err != nil || !validPlusWAV(audio) || binary.LittleEndian.Uint32(audio[24:]) != realtimeSpeechSampleRate ||
				!bytes.Equal(audio[44:], append(append([]byte(nil), first...), second...)) {
				t.Fatalf("did not return one 24 kHz WAV containing both chunks: %v", err)
			}
		})
	}
}

func TestRealtimeSpeechSettings(t *testing.T) {
	a, _ := integrationApp(t)
	admin, _, token, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET instance_admin=1 WHERE id=?", admin)
	fake := "wss://fixture.invalid/v1/realtime"
	value := M{"enabled": true, "endpoint": openAIRealtimeSpeechEndpoint, "model": "gpt-realtime-2.1-mini", "voice": "marin", "label": "AI voice", "timeoutSeconds": 6, "monthlyCharacters": 400, "globalMonthlyCharacters": 800}
	store := func() int {
		return integrationHTTP(a, "PUT", "/api/v1/admin/features/settings/speech", "", token, "", "", value).Code
	}
	t.Setenv("DORHAM_TTS_PLUS_ENDPOINTS", JSON(M{openAIRealtimeSpeechEndpoint: "", fake: "fixture"}))
	if store() != http.StatusBadRequest {
		t.Fatal("Realtime was enabled with an empty credential")
	}
	t.Setenv("DORHAM_TTS_PLUS_ENDPOINTS", JSON(M{openAIRealtimeSpeechEndpoint: "offline-fixture", fake: "fixture"}))
	if store() != http.StatusOK || !speechEnabled(featureSetting(a.DB, "speech")) {
		t.Fatal("approved Realtime configuration was rejected")
	}
	if strings.Contains(JSON(featureSetting(a.DB, "speech")), "offline-fixture") {
		t.Fatal("Realtime credential entered the database")
	}
	value["model"] = "tts-1"
	if store() != http.StatusBadRequest {
		t.Fatal("Realtime accepted a legacy speech model")
	}
	value["endpoint"], value["model"] = fake, "gpt-realtime-2.1-mini"
	if store() != http.StatusBadRequest {
		t.Fatal("Realtime accepted a different WebSocket host")
	}
}
