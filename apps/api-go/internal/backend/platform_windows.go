//go:build windows

package backend

import (
	"golang.org/x/sys/windows"
	"unsafe"
)

func processAlive(pid int) bool {
	h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if e != nil {
		return e == windows.ERROR_ACCESS_DENIED
	}
	defer windows.CloseHandle(h)
	var code uint32
	if windows.GetExitCodeProcess(h, &code) != nil {
		return true
	}
	return code == 259
}
func processCPU() M {
	var created, ended, kernel, user windows.Filetime
	if windows.GetProcessTimes(windows.CurrentProcess(), &created, &ended, &kernel, &user) != nil {
		return M{"user": 0, "system": 0}
	}
	micros := func(v windows.Filetime) uint64 { return (uint64(v.HighDateTime)<<32 | uint64(v.LowDateTime)) / 10 }
	return M{"user": micros(user), "system": micros(kernel)}
}
func processRSS() uint64 {
	type counters struct {
		Size, Faults                                                                    uint32
		Peak, Working, PeakPaged, Paged, PeakNonPaged, NonPaged, Pagefile, PeakPagefile uintptr
	}
	v := counters{}
	v.Size = uint32(unsafe.Sizeof(v))
	proc := windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")
	ok, _, _ := proc.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&v)), uintptr(v.Size))
	if ok == 0 {
		return 0
	}
	return uint64(v.Working)
}
