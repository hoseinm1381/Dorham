//go:build !linux

package backend

import "os"

// Fail closed on platforms without a reliable change-time fingerprint.
func mediaFileVersion(info os.FileInfo) string { return "" }
