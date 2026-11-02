package main

import (
	backend "dorham.local/backend/internal/backend"
	"fmt"
	"github.com/joho/godotenv"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	defer func() {
		if v := recover(); v != nil {
			log.Printf("startup failed: %v", v)
			os.Exit(1)
		}
	}()
	_ = godotenv.Load()
	c := backend.LoadConfig()
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		if len(os.Args) != 3 {
			panic("usage: dorham backup <new-private.sqlite>")
		}
		backend.OfflineBackup(c, os.Args[2])
		return
	}
	a := backend.NewApp(c)
	defer a.Close()
	listener, e := net.Listen("tcp", fmt.Sprintf("%s:%d", c.Host, c.Port))
	if e != nil {
		a.Close()
		panic(e)
	}
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)
	go func() { <-done; a.Close() }()
	log.Printf("Dorham 1.1.0 Go backend ready on %s database=%s", listener.Addr(), a.DB.Dialect)
	if e = a.Serve(listener); e != nil && e != http.ErrServerClosed {
		a.Close()
		panic(e)
	}
}
