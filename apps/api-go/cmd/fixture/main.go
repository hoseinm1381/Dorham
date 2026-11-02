//go:build dorhamtest

// This program is an isolated test fixture, never a release executable.
package main

import (
	"bytes"
	backend "dorham.local/backend/internal/backend"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func fixtureWAV() []byte {
	rate, n := 22050, 11025
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+n*2))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate*2))
	binary.Write(&b, binary.LittleEndian, uint16(2))
	binary.Write(&b, binary.LittleEndian, uint16(16))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(n*2))
	for i := 0; i < n; i++ {
		binary.Write(&b, binary.LittleEndian, int16(math.Sin(float64(i)*2*math.Pi*440/float64(rate))*4000))
	}
	return b.Bytes()
}
func main() {
	nonce := os.Getenv("DORHAM_FIXTURE_NONCE")
	if len(nonce) < 20 {
		panic("explicit fixture nonce required")
	}
	c := backend.LoadConfig()
	if port := os.Getenv("DORHAM_FIXTURE_PORT"); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil {
			panic(err)
		}
		c.Port = value
	}
	c.Host = "127.0.0.1"
	c.Secure = false
	c.Production = false
	c.RateLimit = false
	temp, _ := filepath.Abs(os.TempDir())
	rel, e := filepath.Rel(temp, c.DataDir)
	if e != nil || strings.HasPrefix(rel, "..") || !strings.HasPrefix(filepath.Base(c.DataDir), "dorham-") {
		panic("fixture must use an owned temporary data directory")
	}
	a := backend.NewApp(c)
	defer a.Close()
	controls := backend.NewFixtureControls(a)
	defer controls.Close()
	if os.Getenv("DORHAM_TTS_FIXTURE") == "1" {
		a.Media.SetSpeechSynthesizer(func(text string, cold func()) ([]byte, error) {
			if os.Getenv("DORHAM_TTS_LOADING_FIXTURE") == "1" {
				cold()
			}
			return fixtureWAV(), nil
		})
	}
	// Reflection exists only in the fixture binary and only at a random loopback
	// endpoint. It lets unchanged TypeScript regression tests inspect their own DB.
	a.Route("POST", "/__fixture/"+nonce, false, func(r *backend.Request) any {
		host, _, _ := net.SplitHostPort(r.R.RemoteAddr)
		if host != "127.0.0.1" && host != "::1" {
			backend.Fail(403, "FIXTURE", "Loopback required")
		}
		switch backend.Str(r.Body, "op") {
		case "control":
			return controls.Handle(r.Body)
		case "db.all":
			return controls.DB().All(backend.Str(r.Body, "query"), backend.Arr(r.Body["args"])...)
		case "db.one":
			return backend.M{"value": controls.DB().One(backend.Str(r.Body, "query"), backend.Arr(r.Body["args"])...)}
		case "shutdown":
			go func() { time.Sleep(20 * time.Millisecond); a.Close() }()
			return backend.M{"success": true}
		case "db.run":
			controls.DB().Run(backend.Str(r.Body, "query"), backend.Arr(r.Body["args"])...)
			return backend.M{"success": true}
		case "db.backup":
			a.DB.Backup(backend.Str(r.Body, "destination"))
			return backend.M{"success": true}
		case "service":
			name := backend.Str(r.Body, "name")
			if len(name) == 0 {
				panic("method required")
			}
			name = strings.ToUpper(name[:1]) + name[1:]
			if name == "Dm" {
				name = "DM"
			}
			method := reflect.ValueOf(a.Service).MethodByName(name)
			if !method.IsValid() {
				backend.Fail(400, "FIXTURE", "Unsupported fixture method "+name)
			}
			args := backend.Arr(r.Body["args"])
			t := method.Type()
			converted := []reflect.Value{}
			for i, v := range args {
				var target reflect.Type
				if t.IsVariadic() && i >= t.NumIn()-1 {
					target = t.In(t.NumIn() - 1).Elem()
				} else {
					target = t.In(i)
				}
				if v == nil {
					converted = append(converted, reflect.Zero(target))
					continue
				}
				if target == reflect.TypeOf(a.DB) {
					converted = append(converted, reflect.ValueOf(controls.DB()))
					continue
				}
				if target.Kind() == reflect.Interface {
					converted = append(converted, reflect.ValueOf(v))
					continue
				}
				data, _ := json.Marshal(v)
				dest := reflect.New(target)
				if e := json.Unmarshal(data, dest.Interface()); e != nil {
					panic(e)
				}
				converted = append(converted, dest.Elem())
			}
			result := method.Call(converted)
			if len(result) == 0 {
				return backend.M{"success": true}
			}
			return result[0].Interface()
		default:
			backend.Fail(400, "FIXTURE", "Unknown fixture operation")
		}
		return nil
	})
	listener, e := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", c.Port))
	if e != nil {
		panic(e)
	}
	fmt.Println(backend.JSON(backend.M{"fixtureURL": "http://" + listener.Addr().String(), "pid": os.Getpid()}))
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		select {
		case <-signals:
			a.Close()
		case <-time.After(30 * time.Minute):
			a.Close()
		}
	}()
	a.Serve(listener)
}
