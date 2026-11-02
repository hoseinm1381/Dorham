package backend

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

func (a *App) acquireLock() {
	a.lockPath = filepath.Join(a.C.DataDir, "instance.lock")
	for attempt := 0; attempt < 2; attempt++ {
		f, e := os.OpenFile(a.lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e == nil {
			if _, e = f.WriteString(strconv.Itoa(os.Getpid())); e != nil {
				f.Close()
				panic(e)
			}
			f.Close()
			return
		}
		if !os.IsExist(e) {
			panic(e)
		}
		data, e := os.ReadFile(a.lockPath)
		if e != nil {
			panic(e)
		}
		pid, e := strconv.Atoi(strings.TrimSpace(string(data)))
		if e != nil || pid <= 0 {
			panic(fmt.Errorf("invalid instance.lock: verify the previous server before removing it"))
		}
		if processAlive(pid) {
			panic(fmt.Errorf("another server already owns this data directory"))
		}
		if e = os.Remove(a.lockPath); e != nil {
			panic(e)
		}
	}
	panic(fmt.Errorf("could not acquire instance lock"))
}
