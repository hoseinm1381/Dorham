package backend

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	DataDir, DatabaseURL, Host, PublicURL                                                                                    string
	Port, MaxUsers, MaxOnline, MaxVoice, RoomShares, GlobalShares, RetentionDays, MaxMessages, MaxDatabaseMiB, MaxAvatarsMiB int
	Origins, StunURLs, TurnURLs, TrustedProxies                                                                              []string
	Secure, Production, RegistrationOpen, GuestsEnabled                                                                      bool
	BootstrapSecret, MediaTransport, LivekitURL, LivekitAPIURL, LivekitKey, LivekitSecret                                    string
	ScreenMaxBitrate, ScreenMaxFrameRate, StandardShareSlots, MaxGuests                                                      int
	TurnUsername, TurnPassword, TurnSecret, CloudflareTurnKeyID, CloudflareTurnAPIToken                                      string
	AttachmentDir                                                                                                            string
	AttachmentBudgetMiB, UploadReserveMiB, UploadConcurrency, UploadSoftMiB, UploadHardMiB, UploadSmallMiB                   int
	MediaAdmissionSecret                                                                                                     string
	TTSIdleSeconds, TTSAudioCacheMiB, TTSCPUPercent, TTSTimeoutSeconds                                                       int
	// Test overrides are accepted only by explicitly enabled, loopback-only fixtures.
	RateLimit bool
}

func env(k, d string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return d
}
func envDefault(k, d string) string {
	if value := os.Getenv(k); value != "" {
		return value
	}
	return d
}
func envInt(k string, d int, zero ...bool) int {
	s := env(k, "")
	if s == "" {
		return d
	}
	n, e := strconv.Atoi(s)
	if e != nil || n < 0 || (n == 0 && (len(zero) == 0 || !zero[0])) {
		panic(fmt.Errorf("invalid %s", k))
	}
	return n
}
func envList(k, d string) []string {
	out := []string{}
	for _, v := range strings.Split(env(k, d), ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
func absolute(s string) string {
	v, e := filepath.Abs(s)
	if e != nil {
		panic(e)
	}
	return v
}
func LoadConfig() Config {
	production := env("NODE_ENV", "") == "production"
	host := "127.0.0.1"
	if production {
		host = "0.0.0.0"
	}
	data := absolute(envDefault("DATA_DIR", "./data"))
	c := Config{DataDir: data, DatabaseURL: env("DATABASE_URL", ""), Host: envDefault("HOST", host), Port: envInt("SERVER_PORT", 3001), PublicURL: envDefault("PUBLIC_URL", "http://localhost:3001"),
		Origins: envList("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3001,capacitor://localhost,https://localhost,dorham://app"), Secure: production || env("COOKIE_SECURE", "") == "true", Production: production, RateLimit: true,
		BootstrapSecret: env("BOOTSTRAP_ADMIN_SECRET", ""), RegistrationOpen: env("REGISTRATION_OPEN", "") != "false", MaxUsers: envInt("MAX_USERS", 100), MaxOnline: envInt("MAX_ONLINE_USERS", 20), MaxVoice: envInt("MAX_VOICE_PARTICIPANTS", 16),
		RoomShares: envInt("MAX_ROOM_SHARES", 0, true), GlobalShares: envInt("MAX_GLOBAL_SHARES", 0, true), RetentionDays: envInt("MESSAGE_RETENTION_DAYS", 90), MaxMessages: envInt("MAX_MESSAGES", 50000), MaxDatabaseMiB: envInt("MAX_DATABASE_MIB", 256), MaxAvatarsMiB: envInt("MAX_AVATARS_MIB", 16),
		StunURLs: envList("STUN_URLS", ""), TurnURLs: envList("TURN_URLS", ""), TurnUsername: env("TURN_USERNAME", ""), TurnPassword: env("TURN_PASSWORD", ""), TurnSecret: env("TURN_SECRET", ""), CloudflareTurnKeyID: env("CLOUDFLARE_TURN_KEY_ID", ""), CloudflareTurnAPIToken: env("CLOUDFLARE_TURN_API_TOKEN", ""),
		MediaTransport: env("MEDIA_TRANSPORT", "mesh"), LivekitURL: env("LIVEKIT_URL", ""), LivekitAPIURL: env("LIVEKIT_API_URL", ""), LivekitKey: env("LIVEKIT_API_KEY", ""), LivekitSecret: env("LIVEKIT_API_SECRET", ""),
		ScreenMaxBitrate: envInt("SCREEN_MAX_BITRATE", 1500000), ScreenMaxFrameRate: envInt("SCREEN_MAX_FRAME_RATE", 30), StandardShareSlots: envInt("STANDARD_SHARE_SLOTS", 3), TrustedProxies: envList("TRUSTED_PROXIES", ""), GuestsEnabled: env("GUESTS_ENABLED", "") != "false", MaxGuests: envInt("MAX_GUESTS", 100),
		AttachmentDir: absolute(envDefault("ATTACHMENT_DIR", filepath.Join(data, "attachments"))), AttachmentBudgetMiB: envInt("ATTACHMENT_BUDGET_MIB", 2048), UploadReserveMiB: envInt("UPLOAD_FREE_RESERVE_MIB", 2048), UploadConcurrency: envInt("UPLOAD_CONCURRENCY", 2), UploadSoftMiB: envInt("UPLOAD_DAILY_SOFT_MIB", 512), UploadHardMiB: envInt("UPLOAD_DAILY_HARD_MIB", 1024), UploadSmallMiB: envInt("UPLOAD_SMALL_FILE_MIB", 2),
		MediaAdmissionSecret: env("MEDIA_ADMISSION_SECRET", ""), TTSIdleSeconds: envInt("TTS_IDLE_SECONDS", 180), TTSAudioCacheMiB: envInt("TTS_AUDIO_CACHE_MIB", 8), TTSCPUPercent: envInt("TTS_CPU_PERCENT", 0, true), TTSTimeoutSeconds: envInt("TTS_TIMEOUT_SECONDS", 0, true)}
	if c.TTSCPUPercent > 100 {
		panic("TTS_CPU_PERCENT must be between 0 and 100")
	}
	if c.TTSTimeoutSeconds == 0 {
		c.TTSTimeoutSeconds = 60
		if c.TTSCPUPercent > 0 {
			c.TTSTimeoutSeconds = 300
		}
	}
	if c.TTSTimeoutSeconds > 3600 {
		panic("TTS_TIMEOUT_SECONDS must be at most 3600")
	}
	Check((c.CloudflareTurnKeyID == "") == (c.CloudflareTurnAPIToken == ""), 500, "CONFIG", "Both Cloudflare TURN credentials required")
	Check(c.MediaTransport == "mesh" || c.MediaTransport == "livekit", 500, "CONFIG", "Invalid MEDIA_TRANSPORT")
	Check(c.MediaTransport != "livekit" || (c.LivekitURL != "" && c.LivekitKey != "" && c.LivekitSecret != ""), 500, "CONFIG", "LiveKit credentials required")
	Check(c.ScreenMaxBitrate >= 64000 && c.ScreenMaxBitrate <= 10000000 && c.ScreenMaxFrameRate <= 30, 500, "CONFIG", "Invalid screen publishing policy")
	Check(c.AttachmentDir != c.DataDir && c.AttachmentDir != filepath.VolumeName(c.AttachmentDir)+string(filepath.Separator), 500, "CONFIG", "ATTACHMENT_DIR must be a dedicated directory")
	Check(c.UploadHardMiB >= c.UploadSoftMiB && c.UploadSmallMiB <= 100, 500, "CONFIG", "Invalid shared upload policy")
	Check(c.MediaAdmissionSecret == "" || len(c.MediaAdmissionSecret) >= 32, 500, "CONFIG", "Invalid media admission secret")
	Check(c.TTSIdleSeconds <= 3600 && c.TTSAudioCacheMiB <= 64, 500, "CONFIG", "Invalid TTS budget")
	Check(!production || strings.HasPrefix(c.PublicURL, "https://"), 500, "CONFIG", "Production PUBLIC_URL must use HTTPS")
	return c
}
