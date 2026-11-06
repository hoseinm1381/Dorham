package backend

import (
	"log"
	"time"
)

func speechMeterMonth() string { return time.Now().UTC().Format("2006-01") }

const speechMeterSchema = `CREATE TABLE feature_speech_meter (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	month TEXT NOT NULL,
	attempts BIGINT NOT NULL,
	reported BIGINT NOT NULL,
	priced BIGINT NOT NULL,
	input_tokens BIGINT NOT NULL,
	output_tokens BIGINT NOT NULL,
	estimated_nano_usd BIGINT NOT NULL,
	PRIMARY KEY(user_id,month)
)`

type speechTokenDetails struct {
	Text  int64 `json:"text_tokens"`
	Audio int64 `json:"audio_tokens"`
	Image int64 `json:"image_tokens"`
}

type speechTokenUsage struct {
	Input        int64 `json:"input_tokens"`
	Output       int64 `json:"output_tokens"`
	InputDetails struct {
		speechTokenDetails
		Cached        int64              `json:"cached_tokens"`
		CachedDetails speechTokenDetails `json:"cached_tokens_details"`
	} `json:"input_token_details"`
	OutputDetails speechTokenDetails `json:"output_token_details"`
}

func (u *speechTokenUsage) valid() bool {
	return u != nil && u.Input >= 0 && u.Output >= 0 &&
		u.Input <= 128000 && u.Output <= 32000 && u.Input+u.Output > 0
}

// OpenAI's published GPT-Realtime-2.1 Mini rates, in nano-USD per token.
// Missing or inconsistent modality details leave the estimate unavailable.
func (u *speechTokenUsage) estimate(model string) (int64, bool) {
	in, out := u.InputDetails, u.OutputDetails
	cached := in.CachedDetails
	if model != "gpt-realtime-2.1-mini" ||
		!tokenBreakdownMatches(in.speechTokenDetails, u.Input) ||
		!tokenBreakdownMatches(out, u.Output) ||
		!tokenBreakdownMatches(cached, in.Cached) ||
		cached.Text > in.Text || cached.Audio > in.Audio || cached.Image > in.Image || out.Image != 0 {
		return 0, false
	}
	return (in.Text-cached.Text)*600 + cached.Text*60 +
		(in.Audio-cached.Audio)*10000 + cached.Audio*300 +
		(in.Image-cached.Image)*800 + cached.Image*80 +
		out.Text*2400 + out.Audio*20000, true
}

func tokenBreakdownMatches(details speechTokenDetails, total int64) bool {
	return details.Text >= 0 && details.Text <= total &&
		details.Audio >= 0 && details.Audio <= total &&
		details.Image >= 0 && details.Image <= total &&
		details.Text+details.Audio+details.Image == total
}

func recordSpeechMeter(db *DB, uid, month, model string, realtime bool, usage *speechTokenUsage) {
	// A storage error in the usage meter should never interrupt speech playback.
	defer func() {
		if recover() != nil {
			log.Print("dorham: could not record TTS Plus usage")
		}
	}()
	var reported, priced, input, output, cost int64
	if realtime && usage.valid() {
		reported, input, output = 1, usage.Input, usage.Output
		if estimate, ok := usage.estimate(model); ok {
			priced, cost = 1, estimate
		}
	}
	db.Run(`INSERT INTO feature_speech_meter(user_id,month,attempts,reported,priced,input_tokens,output_tokens,estimated_nano_usd)
		SELECT id,?,1,?,?,?,?,? FROM users WHERE id=? AND deleted_at IS NULL
		ON CONFLICT(user_id,month) DO UPDATE SET attempts=feature_speech_meter.attempts+1,
		reported=feature_speech_meter.reported+excluded.reported, priced=feature_speech_meter.priced+excluded.priced,
		input_tokens=feature_speech_meter.input_tokens+excluded.input_tokens, output_tokens=feature_speech_meter.output_tokens+excluded.output_tokens,
		estimated_nano_usd=feature_speech_meter.estimated_nano_usd+excluded.estimated_nano_usd`,
		month, reported, priced, input, output, cost, uid)
}

func speechMeterView(db *DB, uid, month string) M {
	quota := db.One("SELECT characters FROM feature_speech_usage WHERE user_id=? AND month=?", uid, month)
	row := db.One("SELECT attempts,reported,priced,input_tokens,output_tokens,estimated_nano_usd FROM feature_speech_meter WHERE user_id=? AND month=?", uid, month)
	return M{"month": month, "characters": N(quota["characters"]), "attempts": N(row["attempts"]),
		"reported": N(row["reported"]), "priced": N(row["priced"]), "inputTokens": N(row["input_tokens"]),
		"outputTokens": N(row["output_tokens"]), "estimatedNanoUsd": N(row["estimated_nano_usd"])}
}
