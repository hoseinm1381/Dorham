//go:build !linux

package backend

import (
	"errors"
	"os/exec"
)

type speechCPUGroup struct{}

func prepareSpeechCPU(_ *exec.Cmd, percent int) (*speechCPUGroup, func(), error) {
	if percent != 0 {
		return nil, func() {}, errors.New("TTS CPU isolation requires Linux cgroup v2")
	}
	return nil, func() {}, nil
}
func (g *speechCPUGroup) kill()      {}
func (g *speechCPUGroup) metrics() M { return M{"enabled": false} }
