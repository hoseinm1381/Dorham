package backend

import (
	"math"
	"regexp"
	"strings"
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)

func VString(m M, k string, min, max int, trim bool, optional ...bool) string {
	v, ok := m[k]
	if !ok && len(optional) > 0 && optional[0] {
		return ""
	}
	s, is := v.(string)
	Check(is, 400, "VALIDATION", k+": Expected string")
	if trim {
		s = strings.TrimSpace(s)
		m[k] = s
	}
	Check(TextLen(s) >= min && TextLen(s) <= max, 400, "VALIDATION", k+": Invalid length")
	return s
}
func VBool(m M, k string, optional ...bool) bool {
	v, ok := m[k]
	if !ok && len(optional) > 0 && optional[0] {
		return false
	}
	b, is := v.(bool)
	Check(is, 400, "VALIDATION", k+": Expected boolean")
	return b
}
func VInt(m M, k string, min, max int64, optional ...bool) int64 {
	v, ok := m[k]
	if !ok && len(optional) > 0 && optional[0] {
		return 0
	}
	switch v.(type) {
	case float64, int, int64, jsonNumber:
	default:
		Fail(400, "VALIDATION", k+": Expected integer")
	}
	n := F(v)
	Check(!math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= float64(min) && n <= float64(max), 400, "VALIDATION", k+": Invalid integer")
	return int64(n)
}

// Alias keeps JSON decoder number checks centralized.
func VEnum(m M, k string, allowed []string, optional ...bool) string {
	if _, ok := m[k]; !ok && len(optional) > 0 && optional[0] {
		return ""
	}
	s := VString(m, k, 1, 100, false)
	Check(Contains(allowed, s), 400, "VALIDATION", k+": Invalid value")
	return s
}
func VUUID(s string) string {
	Check(uuidPattern.MatchString(s), 400, "VALIDATION", "Invalid request identifier")
	return s
}
func RID(m M) string { return VUUID(VString(m, "requestId", 36, 36, false)) }
func VID(s string) string {
	Check(TextLen(s) >= 1 && TextLen(s) <= 80, 400, "VALIDATION", "Invalid identifier")
	return s
}
func Strict(m M, keys ...string) {
	for k := range m {
		Check(Contains(keys, k), 400, "VALIDATION", "Unrecognized key: "+k)
	}
}
func VPermissions(x any) M {
	m, ok := x.(map[string]any)
	Check(ok, 400, "VALIDATION", "Expected permissions object")
	Strict(m, "view", "write", "speak", "share", "manageChannels", "manageMembers", "moderate", "createInvites")
	for k := range m {
		VBool(m, k)
	}
	return m
}
func VMessage(m M) M {
	return CoreMessageBody(m)
}
