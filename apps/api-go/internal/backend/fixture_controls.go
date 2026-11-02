//go:build dorhamtest

package backend

import (
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
)

// FixtureControls exposes the private hooks used by historical TypeScript
// regression tests. It is excluded from release binaries; callers must still
// provide the fixture program's random nonce and use its loopback-only RPC.
type FixtureControls struct {
	a            *App
	mu           sync.Mutex
	tx           *DB
	clock        atomic.Int64
	ticketOffset int64
}

func NewFixtureControls(a *App) *FixtureControls {
	c := &FixtureControls{a: a}
	previous := a.Games.now
	a.Games.now = func() int64 {
		if n := c.clock.Load(); n != 0 {
			return n
		}
		return previous()
	}
	return c
}
func (c *FixtureControls) DB() *DB {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tx != nil {
		return c.tx
	}
	return c.a.DB
}
func (c *FixtureControls) Close() { c.finish(false) }
func (c *FixtureControls) finish(commit bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.tx == nil {
		return
	}
	tx := c.tx
	c.tx = nil
	defer c.a.DB.mu.Unlock()
	if commit {
		if err := tx.tx.Commit(); err != nil {
			panic(err)
		}
	} else {
		tx.tx.Rollback()
	}
}
func (c *FixtureControls) Handle(b M) any {
	switch Str(b, "action") {
	case "sync":
		value := reflect.ValueOf(&c.a.C).Elem()
		for key, v := range Obj(b["config"]) {
			for i := 0; i < value.NumField(); i++ {
				if strings.EqualFold(value.Type().Field(i).Name, key) {
					raw, err := json.Marshal(v)
					if err != nil {
						panic(err)
					}
					if err = json.Unmarshal(raw, value.Field(i).Addr().Interface()); err != nil {
						panic(err)
					}
					break
				}
			}
		}
		c.a.Service.C = c.a.C
		if n := Num(b, "gameNow"); n != 0 {
			c.clock.Store(n)
		}
		// Date.now mocks in the old Node tests advance media-ticket time. Shift
		// only ticket deadlines by that reversible offset; the production
		// ResolveTicket authorization and expiry implementation remains intact.
		offset := Num(b, "ticketOffset")
		if offset != c.ticketOffset {
			c.a.Media.mu.Lock()
			for key, ticket := range c.a.Media.tickets {
				ticket.Expires += c.ticketOffset - offset
				c.a.Media.tickets[key] = ticket
			}
			c.a.Media.mu.Unlock()
			c.ticketOffset = offset
		}
		return M{"online": c.a.Hub.Users(), "viewers": c.a.Hub.Viewers()}
	case "games.get":
		return c.a.Games.View(Str(b, "uid"), Str(b, "id"))
	case "chess.get":
		return c.a.Games.ChessView(Str(b, "uid"), Str(b, "id"))
	case "games.tick", "chess.tick":
		c.a.Games.mu.Lock()
		defer c.a.Games.mu.Unlock()
		c.a.Games.tick()
		return M{}
	case "games.presence", "chess.presence":
		c.a.Games.Presence(Str(b, "uid"), Bool(b, "online"))
		return M{}
	case "games.reconcileVoice", "chess.reconcileVoice":
		c.a.Games.ReconcileVoice()
		return M{}
	case "games.close", "chess.close":
		c.a.Games.Close()
		return M{}
	case "attachments.cleanup":
		c.a.Media.Cleanup()
		return M{}
	case "hub.notify":
		c.a.Hub.Notify(Str(b, "kind"), b["payload"])
		return M{}
	case "hub.sockets":
		return c.a.Hub.Viewers()
	case "db.begin":
		c.mu.Lock()
		defer c.mu.Unlock()
		Check(c.tx == nil, 409, "FIXTURE_TX", "Fixture transaction already open")
		c.a.DB.mu.Lock()
		tx, e := c.a.DB.raw.Begin()
		if e != nil {
			c.a.DB.mu.Unlock()
			panic(e)
		}
		c.tx = &DB{raw: c.a.DB.raw, tx: tx, mu: c.a.DB.mu, Dialect: c.a.DB.Dialect}
		return M{}
	case "db.commit":
		c.finish(true)
		return M{}
	case "db.rollback":
		c.finish(false)
		return M{}
	}
	Fail(400, "FIXTURE", "Unknown private fixture control")
	return nil
}
