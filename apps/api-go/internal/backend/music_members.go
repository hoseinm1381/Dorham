package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const musicMB int64 = 1000000
const standardMusicMB int64 = 30

type musicMemberList struct {
	ID     string       `json:"id"`
	Name   string       `json:"name"`
	Owner  string       `json:"owner"`
	Owned  bool         `json:"owned"`
	Public bool         `json:"public"`
	Tracks []musicTrack `json:"tracks"`
}
type musicResolvedLink struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

func musicAllowance(tx *DB, uid string) M {
	bonus := N(tx.One("SELECT bonus_mb FROM music_allowances WHERE user_id=?", uid)["bonus_mb"])
	used := N(tx.One("SELECT COALESCE(SUM(bytes),0) AS used FROM music_member_tracks WHERE owner_id=?", uid)["used"])
	return M{"baseMB": standardMusicMB, "bonusMB": bonus, "usedBytes": used, "limitBytes": (standardMusicMB + bonus) * musicMB}
}

func (m *Music) registerMemberMusic(base string) {
	m.a.Route("GET", base+"/community", true, func(r *Request) any {
		Check(m.enabled(), 409, "MUSIC_UNAVAILABLE", "Music is unavailable on this server.")
		r.Header("Cache-Control", "no-store")
		channel, uid := r.Param("channel"), r.UID()
		return m.a.DB.Tx(func(tx *DB) any {
			s := m.read(tx, channel)
			p := m.access(tx, r, channel, s.Policy)
			query := strings.TrimSpace(r.Query("q"))
			Check(TextLen(query) <= 80, 400, "VALIDATION", "Search is too long.")
			filters := "%" + query + "%"
			lists := []musicMemberList{}
			rows := tx.All("SELECT l.*,u.display_name FROM music_member_lists l JOIN users u ON u.id=l.owner_id WHERE u.deleted_at IS NULL AND u.banned=0 AND (l.owner_id=? OR (l.public=1 AND (LOWER(l.name) LIKE LOWER(?) OR LOWER(u.display_name) LIKE LOWER(?) OR EXISTS (SELECT 1 FROM music_member_tracks t WHERE t.list_id=l.id AND LOWER(t.title) LIKE LOWER(?))))) ORDER BY CASE WHEN l.owner_id=? THEN 0 ELSE 1 END,l.created_at DESC,l.id LIMIT 60", uid, filters, filters, filters, uid)
			for _, row := range rows {
				list := musicMemberList{ID: Str(row, "id"), Name: Str(row, "name"), Owner: Str(row, "display_name"), Owned: Str(row, "owner_id") == uid, Public: B(row["public"]), Tracks: []musicTrack{}}
				for _, track := range tx.All("SELECT track FROM music_member_tracks WHERE list_id=? ORDER BY created_at,id LIMIT 100", list.ID) {
					t := readMemberTrack(track)
					if list.Owned || allowedMusic(s.Policy, t) {
						list.Tracks = append(list.Tracks, t)
					}
				}
				lists = append(lists, list)
			}
			return M{"lists": lists, "allowance": musicAllowance(tx, uid), "canEdit": p.request && !s.Policy.Disabled, "canUpload": p.request && s.Policy.AllowUploads && !s.Policy.Disabled && m.ffprobe != ""}
		})
	})
	m.a.Route("POST", base+"/community", true, m.changeMemberMusic)
	m.a.Route("GET", "/api/v1/admin/music/users/{id}", true, func(r *Request) any {
		Administrator(m.a.DB, r.UID())
		id := r.Param("id")
		Check(m.a.DB.One("SELECT id FROM users WHERE id=? AND guest=0 AND deleted_at IS NULL", id) != nil, 404, "NOT_FOUND", "Account not found.")
		return musicAllowance(m.a.DB, id)
	})
	m.a.Route("POST", "/api/v1/admin/music/users/{id}", true, func(r *Request) any {
		id := r.Param("id")
		Strict(r.Body, "requestId", "bonusMB")
		n := VInt(r.Body, "bonusMB", 0, 8192)
		return m.a.Service.Mutate(r.UID(), RID(r.Body), "admin.music.allowance", M{"target": id, "bonusMB": n}, func(tx *DB) any {
			Administrator(tx, r.UID())
			Check(tx.One("SELECT id FROM users WHERE id=? AND guest=0 AND deleted_at IS NULL", id) != nil, 404, "NOT_FOUND", "Account not found.")
			tx.Run("INSERT INTO music_allowances(user_id,bonus_mb) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET bonus_mb=excluded.bonus_mb", id, n)
			Audit(tx, r.UID(), "admin.music.allowance", id, M{"bonusMB": n})
			return musicAllowance(tx, id)
		})
	})
}

func readMemberTrack(row M) musicTrack {
	var track musicTrack
	if err := json.Unmarshal([]byte(Str(row, "track")), &track); err != nil {
		panic(err)
	}
	return track
}

func musicOwnList(tx *DB, uid, list string) M {
	row := tx.One("SELECT * FROM music_member_lists WHERE id=? AND owner_id=?", list, uid)
	Check(row != nil, 404, "MUSIC_PLAYLIST", "Your playlist was not found.")
	return row
}

func (m *Music) changeMemberMusic(r *Request) any {
	Check(m.enabled(), 409, "MUSIC_UNAVAILABLE", "Music is unavailable on this server.")
	channel, uid := r.Param("channel"), r.UID()
	action := VEnum(r.Body, "action", []string{"create", "visibility", "addLink", "rename", "remove", "delete"})
	rid := RID(r.Body)
	var resolved []musicResolvedLink
	if action == "addLink" {
		m.a.DB.Tx(func(tx *DB) any {
			s := m.read(tx, channel)
			Check(m.access(tx, r, channel, s.Policy).request && !s.Policy.Disabled, 403, "MUSIC_REQUEST", "Playlist editing is unavailable for your role.")
			musicOwnList(tx, uid, VString(r.Body, "list", 1, 80, false))
			return nil
		})
		resolved = m.followMusicLink(r.R.Context(), VString(r.Body, "url", 8, 2048, true))
	}
	paths := []string{}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.a.Service.Mutate(uid, rid, "music.library."+action, M{"channel": channel, "command": r.Body}, func(tx *DB) any {
		s := m.read(tx, channel)
		Check(m.access(tx, r, channel, s.Policy).request && !s.Policy.Disabled, 403, "MUSIC_REQUEST", "Playlist editing is unavailable for your role.")
		if action == "create" {
			id := ID()
			tx.Run("INSERT INTO music_member_lists(id,owner_id,name,public,created_at) VALUES(?,?,?,?,?)", id, uid, VString(r.Body, "name", 1, 60, true), serviceBoolInt(VBool(r.Body, "public")), Now())
			return M{"id": id}
		}
		list := Str(musicOwnList(tx, uid, VString(r.Body, "list", 1, 80, false)), "id")
		switch action {
		case "visibility":
			tx.Run("UPDATE music_member_lists SET public=? WHERE id=?", serviceBoolInt(VBool(r.Body, "public")), list)
		case "rename":
			tx.Run("UPDATE music_member_lists SET name=? WHERE id=?", VString(r.Body, "name", 1, 60, true), list)
		case "addLink":
			for i, item := range resolved {
				m.insertMusicLink(tx, uid, list, item, Now()+int64(i))
			}
			return M{"added": len(resolved)}
		case "remove":
			id := VString(r.Body, "track", 1, 80, false)
			if track := tx.One("SELECT bytes FROM music_member_tracks WHERE id=? AND list_id=?", id, list); track != nil {
				if N(track["bytes"]) > 0 {
					paths = append(paths, m.memberAudioPath(id))
				}
				tx.Run("DELETE FROM music_member_tracks WHERE id=? AND list_id=?", id, list)
			}
		case "delete":
			for _, row := range tx.All("SELECT id FROM music_member_tracks WHERE list_id=? AND bytes>0", list) {
				paths = append(paths, m.memberAudioPath(Str(row, "id")))
			}
			tx.Run("DELETE FROM music_member_lists WHERE id=?", list)
		}
		return M{"ok": true}
	})
	for _, path := range paths {
		_ = os.Remove(path)
	}
	return out
}

func (m *Music) insertMusicLink(tx *DB, uid, list string, item musicResolvedLink, at int64) musicAsset {
	asset := musicAsset{musicTrack: musicTrack{ID: ID(), Title: item.Title, Artist: "Linked audio", Source: "link", Live: true}, URL: item.URL}
	var listID any
	if list != "" {
		listID = list
	}
	tx.Run("INSERT INTO music_member_tracks(id,owner_id,list_id,title,track,url,bytes,created_at) VALUES(?,?,?,?,?,?,?,?)", asset.ID, uid, listID, asset.Title, JSON(asset.musicTrack), asset.URL, 0, at)
	return asset
}

func (m *Music) memberAudioPath(id string) string {
	return filepath.Join(m.a.C.DataDir, "music", "uploads", id+".ogg")
}
func (m *Music) memberAsset(tx *DB, id, uid string) (musicAsset, bool) {
	row := tx.One("SELECT t.*,l.public,u.banned,u.deleted_at FROM music_member_tracks t JOIN users u ON u.id=t.owner_id LEFT JOIN music_member_lists l ON l.id=t.list_id WHERE t.id=?", id)
	if row == nil || B(row["banned"]) || row["deleted_at"] != nil {
		return musicAsset{}, false
	}
	t := readMemberTrack(row)
	isPublic := B(row["public"])
	owned := uid != "" && uid == Str(row, "owner_id")
	if !isPublic && !owned {
		return musicAsset{}, false
	}
	asset := musicAsset{musicTrack: t, URL: Str(row, "url")}
	if t.Source == "upload" {
		asset.File = m.memberAudioPath(id)
	}
	return asset, true
}

func (m *Music) followMusicLink(ctx context.Context, source string) []musicResolvedLink {
	u, err := url.Parse(source)
	Check(err == nil && u.Scheme == "https" && u.User == nil && u.Hostname() != "", 400, "MUSIC_SOURCE", "Paste a direct HTTPS audio or M3U playlist link.")
	select {
	case m.linkSlots <- struct{}{}:
		defer func() { <-m.linkSlots }()
	default:
		Fail(429, "MUSIC_SOURCE", "Music link lookup is busy. Try again shortly.")
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, m.worker, "--resolve-link")
	cmd.Env = musicProcessEnv()
	cmd.Stdin = bytes.NewReader([]byte(JSON(M{"url": source})))
	raw, e := cmd.Output()
	var links []musicResolvedLink
	Check(e == nil && len(raw) < 1024*1024 && json.Unmarshal(raw, &links) == nil && len(links) > 0 && len(links) <= 100, 400, "MUSIC_SOURCE", "This link did not provide supported audio or an M3U track list.")
	return links
}
