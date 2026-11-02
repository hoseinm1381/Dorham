package backend

import (
	"path/filepath"
	"testing"
)

func TestConfigBlankOptionalPathsUseExistingNodeDefaults(t *testing.T) {
	data := t.TempDir()
	for key, value := range map[string]string{"NODE_ENV": "development", "DATA_DIR": data, "ATTACHMENT_DIR": "", "HOST": "", "PUBLIC_URL": "", "MEDIA_TRANSPORT": "mesh", "CLOUDFLARE_TURN_KEY_ID": "", "CLOUDFLARE_TURN_API_TOKEN": ""} {
		t.Setenv(key, value)
	}
	c := LoadConfig()
	if c.AttachmentDir != filepath.Join(data, "attachments") {
		t.Fatalf("blank optional attachment path escaped data directory: %s", c.AttachmentDir)
	}
	if c.Host != "127.0.0.1" || c.PublicURL != "http://localhost:3001" {
		t.Fatal("blank optional network values lost default behavior")
	}
	explicit := filepath.Join(t.TempDir(), "custom-files")
	t.Setenv("ATTACHMENT_DIR", explicit)
	if LoadConfig().AttachmentDir != explicit {
		t.Fatal("explicit attachment directory was overridden")
	}
}

func TestConfigSpeechCPULimitAndDeadline(t *testing.T) {
	for key, value := range map[string]string{"NODE_ENV": "development", "DATA_DIR": t.TempDir(), "MEDIA_TRANSPORT": "mesh", "CLOUDFLARE_TURN_KEY_ID": "", "CLOUDFLARE_TURN_API_TOKEN": "", "TTS_CPU_PERCENT": "0", "TTS_TIMEOUT_SECONDS": "0"} {
		t.Setenv(key, value)
	}
	if c := LoadConfig(); c.TTSCPUPercent != 0 || c.TTSTimeoutSeconds != 60 {
		t.Fatal("uncapped development defaults changed")
	}
	t.Setenv("TTS_CPU_PERCENT", "30")
	if c := LoadConfig(); c.TTSCPUPercent != 30 || c.TTSTimeoutSeconds != 300 || c.TTSIdleSeconds != 180 {
		t.Fatal("capped speech must allow slower synthesis without changing idle retention")
	}
	t.Setenv("TTS_TIMEOUT_SECONDS", "600")
	if LoadConfig().TTSTimeoutSeconds != 600 {
		t.Fatal("explicit speech deadline was ignored")
	}
	for _, pair := range [][2]string{{"TTS_CPU_PERCENT", "101"}, {"TTS_CPU_PERCENT", "-1"}, {"TTS_TIMEOUT_SECONDS", "3601"}, {"TTS_TIMEOUT_SECONDS", "-1"}} {
		t.Run(pair[0]+pair[1], func(t *testing.T) {
			t.Setenv(pair[0], pair[1])
			defer func() {
				if recover() == nil {
					t.Fatal("invalid speech resource configuration accepted")
				}
			}()
			LoadConfig()
		})
	}
}
