package backend

import (
	"context"
	"database/sql"
	"fmt"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type DB struct {
	raw            *sql.DB
	tx             *sql.Tx
	mu             *sync.Mutex
	Dialect        string
	memo           map[string][]M
	memoRows       int
	memoGeneration uint64
	txState        *transactionState
}

type transactionState struct {
	ctx        context.Context
	done       atomic.Bool
	generation atomic.Uint64
}

func (d *DB) checkTransaction() {
	if d.txState == nil {
		return
	}
	if d.txState.done.Load() {
		panic(sql.ErrTxDone)
	}
	if err := d.txState.ctx.Err(); err != nil {
		panic(err)
	}
}

// Snapshot reuses identical reads only within the caller's serialized SQL
// transaction. Copies prevent callers from modifying cached rows. Mutations
// invalidate the snapshot immediately; authorization never survives a commit.
func (d *DB) Snapshot() *DB {
	Check(d.tx != nil, 500, "INTERNAL", "Read snapshots require a transaction")
	d.checkTransaction()
	return &DB{raw: d.raw, tx: d.tx, mu: d.mu, Dialect: d.Dialect, memo: map[string][]M{}, txState: d.txState, memoGeneration: d.txState.generation.Load()}
}
func copyRows(rows []M) []M {
	out := make([]M, len(rows))
	for i, row := range rows {
		out[i] = Merge(row)
	}
	return out
}

// SQL blobs and custom driver values have different semantics from their JSON
// representation. Only primitive arguments used by permission reads are cached.
func snapshotArguments(args []any) bool {
	for _, arg := range args {
		switch arg.(type) {
		case nil, string, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		default:
			return false
		}
	}
	return true
}

func OpenDB(c Config) *DB {
	if e := os.MkdirAll(c.DataDir, 0700); e != nil {
		panic(e)
	}
	driver, dsn, dialect := "sqlite", filepath.Join(c.DataDir, "dorham.sqlite"), "sqlite"
	if c.DatabaseURL != "" {
		driver, dsn, dialect = "pgx", c.DatabaseURL, "postgres"
	}
	raw, e := sql.Open(driver, dsn)
	if e != nil {
		panic(e)
	}
	raw.SetMaxOpenConns(1)
	raw.SetMaxIdleConns(1)
	d := &DB{raw: raw, mu: &sync.Mutex{}, Dialect: dialect}
	if dialect == "sqlite" {
		for _, q := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000", "PRAGMA auto_vacuum=INCREMENTAL", "PRAGMA journal_size_limit=16777216", "PRAGMA wal_autocheckpoint=1000"} {
			d.Run(q)
		}
		page := N(d.One("PRAGMA page_size")["page_size"])
		d.Run(fmt.Sprintf("PRAGMA max_page_count=%d", int64(c.MaxDatabaseMiB)*1048576/page))
	}
	initialize := func(tx *DB) any {
		for _, q := range baseSchema {
			tx.Run(q)
		}
		tx.Run("INSERT INTO schema_migrations(version,applied_at) VALUES(1,?) ON CONFLICT(version) DO NOTHING", Now())
		return nil
	}
	// The PostgreSQL serialization row does not exist on a fresh instance until
	// bootstrap DDL finishes. Subsequent migrations use the normal locked Tx path.
	if dialect == "postgres" {
		initialize(d)
	} else {
		d.Tx(initialize)
	}
	d.migrate()
	return d
}
func (d *DB) query(q string) string {
	if d.Dialect != "postgres" {
		return q
	}
	var out strings.Builder
	quoted := false
	param := 1
	for i := 0; i < len(q); i++ {
		v := q[i]
		if v == '\'' {
			if quoted && i+1 < len(q) && q[i+1] == '\'' {
				out.WriteString("''")
				i++
				continue
			}
			quoted = !quoted
		}
		if v == '?' && !quoted {
			fmt.Fprintf(&out, "$%d", param)
			param++
		} else {
			out.WriteByte(v)
		}
	}
	return out.String()
}
func (d *DB) lock() func() {
	if d.tx != nil {
		return func() {}
	}
	d.mu.Lock()
	return d.mu.Unlock
}
func (d *DB) All(q string, args ...any) []M {
	args = sqlArguments(args)
	unlock := d.lock()
	defer unlock()
	d.checkTransaction()
	cacheKey := ""
	if d.memo != nil && d.memoGeneration != d.txState.generation.Load() {
		d.memo = map[string][]M{}
		d.memoRows = 0
		d.memoGeneration = d.txState.generation.Load()
	}
	if d.memo != nil && snapshotArguments(args) && strings.HasPrefix(strings.ToUpper(strings.TrimSpace(q)), "SELECT ") {
		cacheKey = JSON([]any{q, args})
		if rows, ok := d.memo[cacheKey]; ok {
			return copyRows(rows)
		}
	}
	q = d.query(q)
	var rows *sql.Rows
	var e error
	if d.tx != nil {
		rows, e = d.tx.Query(q, args...)
	} else {
		rows, e = d.raw.Query(q, args...)
	}
	if e != nil {
		panic(e)
	}
	defer rows.Close()
	cols, e := rows.Columns()
	if e != nil {
		panic(e)
	}
	out := []M{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if e = rows.Scan(ptrs...); e != nil {
			panic(e)
		}
		m := M{}
		for i, k := range cols {
			if b, ok := vals[i].([]byte); ok {
				m[k] = string(b)
			} else {
				m[k] = vals[i]
			}
		}
		out = append(out, m)
	}
	if e = rows.Err(); e != nil {
		panic(e)
	}
	if cacheKey != "" && len(d.memo) < 1024 && d.memoRows+len(out) <= 2048 {
		d.memo[cacheKey] = copyRows(out)
		d.memoRows += len(out)
	}
	return out
}
func (d *DB) One(q string, args ...any) M {
	rows := d.All(q, args...)
	if len(rows) == 0 {
		return nil
	}
	return rows[0]
}
func (d *DB) Run(q string, args ...any) {
	args = sqlArguments(args)
	unlock := d.lock()
	defer unlock()
	d.checkTransaction()
	if d.txState != nil {
		d.txState.generation.Add(1)
	}
	var e error
	if d.tx != nil {
		_, e = d.tx.Exec(d.query(q), args...)
	} else {
		_, e = d.raw.Exec(d.query(q), args...)
	}
	if e != nil {
		panic(e)
	}
}

func sqlArguments(args []any) []any {
	for i, v := range args {
		if b, ok := v.(bool); ok {
			if b {
				args[i] = int64(1)
			} else {
				args[i] = int64(0)
			}
		}
	}
	return args
}
func (d *DB) Tx(fn func(*DB) any) (result any) {
	if d.tx != nil {
		d.checkTransaction()
		return fn(d)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tx, e := d.raw.BeginTx(ctx, nil)
	if e != nil {
		panic(e)
	}
	defer tx.Rollback()
	state := &transactionState{ctx: ctx}
	defer state.done.Store(true)
	child := &DB{raw: d.raw, tx: tx, mu: d.mu, Dialect: d.Dialect, txState: state}
	if d.Dialect == "postgres" {
		child.One("SELECT id FROM global_locks WHERE id=1 FOR UPDATE")
	}
	result = fn(child)
	if e = tx.Commit(); e != nil {
		panic(e)
	}
	return result
}
func (d *DB) Close() {
	if d.Dialect == "sqlite" {
		d.Run("PRAGMA wal_checkpoint(TRUNCATE)")
	}
	if e := d.raw.Close(); e != nil {
		panic(e)
	}
}
func (d *DB) Backup(destination string) {
	Check(d.Dialect == "sqlite", 400, "BACKUP", "PostgreSQL backups require pg_dump")
	_, e := os.Stat(destination)
	Check(os.IsNotExist(e), 409, "BACKUP_EXISTS", "Backup destination already exists")
	d.Run("VACUUM INTO ?", destination)
}
func (d *DB) migrate() {
	for version := 2; version <= 11; version++ {
		v := version
		d.Tx(func(tx *DB) any {
			if tx.One("SELECT version FROM schema_migrations WHERE version=?", v) != nil {
				return nil
			}
			for _, q := range expansionSchema[v] {
				tx.Run(q)
			}
			if v == 3 {
				for _, r := range tx.All("SELECT response FROM mutations WHERE operation='invite.create' ORDER BY created_at DESC LIMIT 5000") {
					func() {
						defer func() { _ = recover() }()
						code := Str(Obj(Parse(Str(r, "response"))), "code")
						if len(code) >= 10 && len(code) <= 100 {
							tx.Run("UPDATE invites SET code=? WHERE hash=? AND expires_at>? AND remaining>0", code, Hash(code), Now())
						}
					}()
				}
			}
			tx.Run("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", v, Now())
			return nil
		})
	}
}
