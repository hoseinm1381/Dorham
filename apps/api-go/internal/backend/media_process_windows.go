//go:build windows

package backend

import (
	"os/exec"
	"syscall"
)

func mediaHideWindow(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
