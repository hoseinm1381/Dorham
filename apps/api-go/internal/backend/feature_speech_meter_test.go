package backend

import (
	"testing"
	"time"
)

func TestSpeechMeterAdminView(t *testing.T) {
	a, _ := integrationApp(t)
	admin, _, adminToken, _ := integrationSession(a, true)
	user, _, token, _ := integrationSession(a, true)
	other, _, _, _ := integrationSession(a, true)
	a.DB.Run("UPDATE users SET instance_admin=1 WHERE id=?", admin)
	month := time.Now().UTC().Format("2006-01")
	a.DB.Run("INSERT INTO feature_speech_usage(user_id,month,characters) VALUES(?,?,?)", user, month, 55)

	// Simulate upgrading an existing database with character history.
	a.DB.Run("DROP TABLE feature_speech_meter")
	a.DB.Run("DELETE FROM schema_migrations WHERE version=15")
	a.DB.migrate()

	usage := &speechTokenUsage{Input: 20, Output: 25}
	usage.InputDetails.Text = 20
	usage.OutputDetails.Audio = 25
	recordSpeechMeter(a.DB, user, month, "gpt-realtime-2.1-mini", true, usage)
	recordSpeechMeter(a.DB, user, month, "gpt-realtime-other", true, usage)
	recordSpeechMeter(a.DB, user, month, "gpt-realtime-2.1-mini", true, nil)
	recordSpeechMeter(a.DB, other, month, "gpt-realtime-2.1-mini", true, usage)
	recordSpeechMeter(a.DB, user, "2000-01", "gpt-realtime-2.1-mini", true, usage)

	path := "/api/v1/admin/features/users/" + user
	if w := integrationHTTP(a, "GET", path, "", token, "", "", nil); w.Code != 403 {
		t.Fatalf("regular account could read usage: %d", w.Code)
	}
	w := integrationHTTP(a, "GET", path, "", adminToken, "", "", nil)
	got := Obj(Obj(Parse(w.Body.String()))["ttsPlusUsage"])
	if w.Code != 200 || Str(got, "month") != month || N(got["characters"]) != 55 ||
		N(got["attempts"]) != 3 || N(got["reported"]) != 2 || N(got["priced"]) != 1 ||
		N(got["inputTokens"]) != 40 || N(got["outputTokens"]) != 50 || N(got["estimatedNanoUsd"]) != 512000 {
		t.Fatalf("unexpected metering view: %d %s", w.Code, w.Body)
	}
}
