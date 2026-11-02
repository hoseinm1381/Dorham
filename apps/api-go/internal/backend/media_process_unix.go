//go:build !windows

package backend

import "os/exec"

func mediaHideWindow(cmd *exec.Cmd) {}
