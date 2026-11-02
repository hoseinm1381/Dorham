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
