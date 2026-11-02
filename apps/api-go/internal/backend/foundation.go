package backend

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

type M = map[string]any
type Rows = []M
type APIError struct {
	Status        int
	Code, Message string
}

func (e APIError) Error() string            { return e.Code + ": " + e.Message }
func Fail(status int, code, message string) { panic(APIError{status, code, message}) }
func Check(ok bool, status int, code, message string) {
	if !ok {
		Fail(status, code, message)
	}
}
func S(x any) string {
	if x == nil {
		return ""
	}
	switch v := x.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	case json.Number:
		return string(v)
	default:
		return fmt.Sprint(v)
	}
}
func F(x any) float64 {
	switch v := x.(type) {
	case float64:
		return v
	case float32:
		return float64(v)
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case int32:
		return float64(v)
	case uint64:
		return float64(v)
	case json.Number:
		f, _ := v.Float64()
		return f
	case bool:
		if v {
			return 1
		}
		return 0
	default:
		f, _ := strconv.ParseFloat(S(x), 64)
		return f
	}
}
func N(x any) int64 { return int64(F(x)) }
func B(x any) bool {
	switch v := x.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	default:
		return F(x) != 0
	}
}
func Obj(x any) M {
	if v, ok := x.(map[string]any); ok && v != nil {
		return v
	}
	return M{}
}
func Arr(x any) []any {
	switch v := x.(type) {
	case []any:
		if v != nil {
			return v
		}
	case []M:
		a := make([]any, len(v))
		for i := range v {
			a[i] = v[i]
		}
		return a
	case []string:
		a := make([]any, len(v))
		for i := range v {
			a[i] = v[i]
		}
		return a
	}
	return []any{}
}
func Str(m M, k string) string { return S(m[k]) }
func Num(m M, k string) int64  { return N(m[k]) }
func Bool(m M, k string) bool  { return B(m[k]) }
func Now() int64               { return time.Now().UnixMilli() }
func ID() string {
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func Token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func Hash(s string) string { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
func Equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(Hash(a)), []byte(Hash(b))) == 1
}
func JSON(x any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(x); err != nil {
		panic(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}
func Parse(s string) any {
	var v any
	d := json.NewDecoder(strings.NewReader(s))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		panic(err)
	}
	return v
}
func Clone(m M) M { return Obj(Parse(JSON(m))) }
func Merge(ms ...M) M {
	m := M{}
	for _, v := range ms {
		for k, x := range v {
			m[k] = x
		}
	}
	return m
}
func Strings(v any) []string {
	out := []string{}
	for _, x := range Arr(v) {
		out = append(out, S(x))
	}
	return out
}
func Contains(a []string, v string) bool {
	for _, x := range a {
		if x == v {
			return true
		}
	}
	return false
}
func TextLen(s string) int { return len(utf16.Encode([]rune(s))) }
func Optional(m M, key string, def any) any {
	if v, ok := m[key]; ok {
		return v
	}
	return def
}
func RecoverError(v any) APIError {
	switch e := v.(type) {
	case APIError:
		return e
	case *APIError:
		return *e
	case error:
		s := e.Error()
		if strings.Contains(s, "SQLITE_FULL") {
			return APIError{507, "STORAGE_FULL", "Storage is full. Contact the instance administrator."}
		}
		if strings.Contains(s, "constraint") || strings.Contains(s, "CONSTRAINT") || strings.Contains(s, "SQLSTATE 23505") {
			return APIError{409, "CONFLICT", "The record already exists or changed. Refresh and retry."}
		}
	}
	return APIError{500, "INTERNAL", "The request could not be completed."}
}
