package backend

import (
	"fmt"
	"os"
	"syscall"
)

// ctime invalidates a verified result even when mtime and size are restored.
func mediaFileVersion(info os.FileInfo) string {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return fmt.Sprintf("%d/%d/%d/%d", st.Dev, st.Ino, st.Ctim.Sec, st.Ctim.Nsec)
	}
	return ""
}
