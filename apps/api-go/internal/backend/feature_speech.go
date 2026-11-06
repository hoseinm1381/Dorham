package backend

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const maxSpeechPlusAudio = 2 * 1024 * 1024

var speechPlusClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}
var speechPlusRequests = make(chan struct{}, 1)

func speechEndpointToken(endpoint string) (string, bool) {
	var approved map[string]string
	if json.Unmarshal([]byte(os.Getenv("DORHAM_TTS_PLUS_ENDPOINTS")), &approved) != nil {
		return "", false
	}
	token, ok := approved[endpoint]
	return token, ok
}

func speechEnabled(value M) bool {
	if !Bool(value, "enabled") {
		return false
	}
	endpoint := Str(value, "endpoint")
	token, approved := speechEndpointToken(endpoint)
	return approved && (endpoint != openAIRealtimeSpeechEndpoint || strings.TrimSpace(token) != "")
}

func validateSpeechSettings(value M) M {
	Strict(value, "enabled", "endpoint", "model", "voice", "label", "timeoutSeconds", "monthlyCharacters", "globalMonthlyCharacters", "requestId")
	enabled := VBool(value, "enabled")
	endpoint := VString(value, "endpoint", 0, 300, true)
	if endpoint != "" {
		u, err := url.Parse(endpoint)
		token, approved := speechEndpointToken(endpoint)
		https := err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Fragment == "" && u.RawQuery == "" && !u.ForceQuery
		realtime := endpoint == openAIRealtimeSpeechEndpoint && strings.TrimSpace(token) != ""
		Check(approved && (https || realtime), 400, "VALIDATION", "Choose a server-approved HTTPS speech or OpenAI Realtime endpoint.")
	}
	model := VString(value, "model", 0, 100, true)
	voice := VString(value, "voice", 0, 100, true)
	label := VString(value, "label", 1, 60, true)
	Check(endpoint != openAIRealtimeSpeechEndpoint || model == "" || strings.HasPrefix(model, "gpt-realtime-"), 400, "VALIDATION", "Choose a GPT Realtime model for the Realtime endpoint.")
	Check(!enabled || endpoint != "" && model != "" && voice != "", 400, "VALIDATION", "Configure an endpoint, model and voice before enabling TTS Plus.")
	monthly := VInt(value, "monthlyCharacters", 400, 1000000)
	global := VInt(value, "globalMonthlyCharacters", monthly, 10000000)
	return M{"enabled": enabled, "endpoint": endpoint, "model": model, "voice": voice, "label": label, "timeoutSeconds": VInt(value, "timeoutSeconds", 2, 15), "monthlyCharacters": monthly, "globalMonthlyCharacters": global}
}

func synthesizePlus(value M, text string, report func(*speechTokenUsage)) ([]byte, error) {
	select {
	case speechPlusRequests <- struct{}{}:
		defer func() { <-speechPlusRequests }()
	default:
		return nil, errors.New("speech provider is busy")
	}
	endpoint := Str(value, "endpoint")
	token, approved := speechEndpointToken(endpoint)
	if !approved {
		return nil, errors.New("speech provider is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(N(value["timeoutSeconds"]))*time.Second)
	defer cancel()
	if endpoint == openAIRealtimeSpeechEndpoint {
		return synthesizeRealtimeSpeech(ctx, websocket.DefaultDialer, token, Str(value, "model"), Str(value, "voice"), text, report)
	}
	payload := M{"model": value["model"], "voice": value["voice"], "input": text, "response_format": "wav"}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := speechPlusClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("speech provider request failed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxSpeechPlusAudio+1))
	if err != nil || len(data) > maxSpeechPlusAudio || !validPlusWAV(data) {
		return nil, errors.New("invalid speech provider WAV")
	}
	return data, nil
}

func validPlusWAV(data []byte) bool {
	if len(data) < 44 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WAVE" || int64(binary.LittleEndian.Uint32(data[4:])) != int64(len(data)-8) {
		return false
	}
	var bytesPerSecond, blockAlign int
	for offset := 12; offset+8 <= len(data); {
		kind := string(data[offset : offset+4])
		size := int(binary.LittleEndian.Uint32(data[offset+4:]))
		offset += 8
		if size > len(data)-offset {
			return false
		}
		body := data[offset : offset+size]
		switch kind {
		case "fmt ":
			if len(body) < 16 || binary.LittleEndian.Uint16(body) != 1 || binary.LittleEndian.Uint16(body[14:]) != 16 {
				return false
			}
			channels := int(binary.LittleEndian.Uint16(body[2:]))
			rate := int(binary.LittleEndian.Uint32(body[4:]))
			blockAlign = channels * 2
			bytesPerSecond = rate * blockAlign
			if channels < 1 || channels > 2 || rate < 8000 || rate > 48000 || int(binary.LittleEndian.Uint16(body[12:])) != blockAlign || int(binary.LittleEndian.Uint32(body[8:])) != bytesPerSecond {
				return false
			}
		case "data":
			return bytesPerSecond > 0 && size > 0 && size%blockAlign == 0 && size <= 45*bytesPerSecond
		}
		offset += size + size%2
	}
	return false
}

type speechPlusStats struct {
	requests, errors, fallbacks atomic.Int64
	retryAfter                  atomic.Int64
}

func (a *App) registerSpeechPlus() {
	a.Route("PUT", "/api/v1/features/speech", true, func(r *Request) any {
		Strict(r.Body, "voice", "requestId")
		voice := VEnum(r.Body, "voice", []string{"standard", "plus"})
		return a.DB.Tx(func(tx *DB) any {
			requireLiveSession(tx, r)
			if voice == "plus" {
				Check(featureAvailable(tx, r.UID(), "ttsPlus") && speechEnabled(featureSetting(tx, "speech")), 403, "FEATURE_REQUIRED", "TTS Plus is unavailable.")
			}
			tx.Run("UPDATE users SET speech_plus=? WHERE id=?", serviceBoolInt(voice == "plus"), r.UID())
			return M{"success": true}
		})
	})
	a.Route("POST", "/api/v1/admin/features/speech/preview", true, func(r *Request) any {
		var value M
		featureAdmin(r, func(tx *DB) any {
			Strict(r.Body, "settings", "text", "requestId")
			value = validateSpeechSettings(Obj(r.Body["settings"]))
			return nil
		})
		sample := VString(r.Body, "text", 1, 120, true)
		data, err := synthesizePlus(value, sample, nil)
		switch {
		case errors.Is(err, errRealtimeSpeechRegion):
			Fail(502, "SPEECH_PROVIDER_REGION", "The provider refused requests from this server's region.")
		case errors.Is(err, errRealtimeSpeechCredential):
			Fail(502, "SPEECH_PROVIDER_AUTH", "The provider refused authorization for this server credential.")
		case errors.Is(err, errRealtimeSpeechQuota):
			Fail(502, "SPEECH_PROVIDER_QUOTA", "The provider reported a quota or rate limit.")
		case errors.Is(err, errRealtimeSpeechMismatch):
			Fail(502, "SPEECH_PREVIEW_TEXT_CHANGED", "The speech transcript differed from the preview text.")
		}
		Check(err == nil, 502, "SPEECH_PREVIEW_FAILED", "The speech provider could not return a WAV preview.")
		return M{"wav": base64.StdEncoding.EncodeToString(data)}
	})
}

func reservePlusSpeech(tx *DB, uid, text, month string) M {
	if !featureAvailable(tx, uid, "ttsPlus") || !Bool(tx.One("SELECT speech_plus FROM users WHERE id=?", uid), "speech_plus") {
		return nil
	}
	value := featureSetting(tx, "speech")
	if !speechEnabled(value) {
		return nil
	}
	chars := int64(TextLen(strings.TrimSpace(text)))
	used := N(tx.One("SELECT characters FROM feature_speech_usage WHERE user_id=? AND month=?", uid, month)["characters"])
	total := N(tx.One("SELECT COALESCE(SUM(characters),0) AS total FROM feature_speech_usage WHERE month=?", month)["total"])
	if used+chars > N(value["monthlyCharacters"]) || total+chars > N(value["globalMonthlyCharacters"]) {
		return nil
	}
	tx.Run("INSERT INTO feature_speech_usage(user_id,month,characters) VALUES(?,?,?) ON CONFLICT(user_id,month) DO UPDATE SET characters=feature_speech_usage.characters+excluded.characters", uid, month, chars)
	return value
}

func (s *mediaSpeech) runPlus(job mediaSpeechJob) {
	defer func() {
		if recover() != nil {
			s.progress(job, 100, "finished")
		}
	}()
	if len(s.audience(job)) == 0 {
		s.progress(job, 100, "finished")
		return
	}
	s.progress(job, 0, "preparing")
	var data []byte
	if s.plusStats.retryAfter.Load() <= Now() {
		text := Str(job.Message, "content")
		month := speechMeterMonth()
		settings := Obj(s.m.a.DB.Tx(func(tx *DB) any { return reservePlusSpeech(tx, job.UID, text, month) }))
		if len(settings) > 0 {
			s.plusStats.requests.Add(1)
			var usage *speechTokenUsage
			audio, err := synthesizePlus(settings, text, func(reported *speechTokenUsage) { usage = reported })
			recordSpeechMeter(s.m.a.DB, job.UID, month, Str(settings, "model"), Str(settings, "endpoint") == openAIRealtimeSpeechEndpoint, usage)
			if err != nil {
				s.plusStats.errors.Add(1)
				if !errors.Is(err, errRealtimeSpeechMismatch) {
					s.plusStats.retryAfter.Store(Now() + 30000)
				}
			} else if featureAvailable(s.m.a.DB, job.UID, "ttsPlus") && speechEnabled(featureSetting(s.m.a.DB, "speech")) {
				data = audio
			}
		}
	}
	if len(data) > 0 {
		if s.waitFirst(job) {
			s.publish(job, data, 0, 1)
		}
		s.progress(job, 100, "finished")
		return
	}
	s.plusStats.fallbacks.Add(1)
	s.mu.Lock()
	if !s.closed && s.queued < 4 {
		s.queued++
		s.jobs <- job
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.progress(job, 100, "finished")
	s.notice(job.UID, "Speech is busy. Your text message was sent normally.")
}
