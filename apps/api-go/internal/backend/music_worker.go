package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

type musicJob struct {
	Endpoint, Token, File, URL, FFmpeg string
	PublicLink                         bool
	LowBandwidth                       bool
	Position                           int64
	Volume                             int
}

func (m *Music) runChannel(channel string, s musicState) {
	previous := m.processes[channel]
	m.cancelChannel(channel)
	if m.closed || s.Current == nil || s.Status != "buffering" {
		return
	}
	asset, ok := m.asset(m.a.DB, channel, s.Current.Track.ID, s.Current.Requester)
	if !ok || len(m.processes) >= envInt("MUSIC_MAX_ROOMS", 3) {
		s.Status = "error"
		s.Message = "Music is at capacity or this track was removed."
		s.Revision++
		m.save(m.a.DB, channel, s)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &musicProcess{epoch: ID(), cancel: cancel, startedAt: Now(), entry: s.Current.ID, done: make(chan struct{})}
	m.processes[channel] = p
	identity := musicIdentity + ":" + p.epoch + ":music"
	m.sessions.Store(channel, identity)
	token := mediaJWT(m.a.C.LivekitKey, m.a.C.LivekitSecret, identity, M{"roomJoin": true, "room": channel, "canSubscribe": false, "canPublish": true, "canPublishSources": []string{"microphone"}, "canPublishData": false, "canUpdateOwnMetadata": false}, 60)
	job := musicJob{Endpoint: m.a.C.LivekitURL, Token: token, File: asset.File, URL: asset.URL, PublicLink: asset.Source == "link", FFmpeg: m.ffmpeg, Position: s.Position, Volume: s.Volume, LowBandwidth: s.LowBandwidth}
	m.wg.Go(func() {
		if previous != nil {
			select {
			case <-previous.done:
			case <-ctx.Done():
				close(p.done)
				return
			}
		}
		ready, err := m.publish(ctx, p, channel, job)
		close(p.done)
		m.workerFinished(channel, p, ready, err)
	})
}

func (m *Music) publish(ctx context.Context, p *musicProcess, channel string, job musicJob) (ready bool, err error) {
	cmd := exec.CommandContext(ctx, m.worker)
	input, err := cmd.StdinPipe()
	if err != nil {
		return false, err
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		return false, err
	}
	cmd.Cancel = input.Close
	cmd.WaitDelay = 4 * time.Second
	cmd.Env = musicProcessEnv()
	if err = cmd.Start(); err != nil {
		return false, err
	}
	if err = json.NewEncoder(input).Encode(job); err != nil {
		input.Close()
		_ = cmd.Wait()
		return false, err
	}
	scan := bufio.NewScanner(output)
	for scan.Scan() {
		if scan.Text() == "ready" && !ready {
			ready = true
			m.workerReady(channel, p)
		}
	}
	if err := scan.Err(); err != nil {
		input.Close()
		_ = cmd.Wait()
		return ready, err
	}
	return ready, cmd.Wait()
}

func musicProcessEnv() []string {
	env := []string{}
	for _, key := range []string{"PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG"} {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

func (m *Music) workerReady(channel string, p *musicProcess) {
	changed := false
	defer func() {
		if changed {
			m.notify(channel)
		}
	}()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.processes[channel] != p {
		return
	}
	s := m.read(m.a.DB, channel)
	if s.Current == nil || s.Current.ID != p.entry || s.Status != "buffering" {
		return
	}
	p.readyAt = Now()
	s.Status = "playing"
	s.Revision++
	m.save(m.a.DB, channel, s)
	changed = true
}

func (m *Music) workerFinished(channel string, p *musicProcess, ready bool, err error) {
	changed := false
	defer func() {
		if changed {
			m.notify(channel)
		}
	}()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.processes[channel] != p {
		return
	}
	m.cancelChannel(channel)
	s := m.read(m.a.DB, channel)
	if s.Current == nil || s.Current.ID != p.entry {
		return
	}
	if err != nil || !ready {
		s.Message = "Playback interrupted. Resume to retry or choose the next track."
		s.Position = musicPosition(s, p, Now())
		s.Status = "error"
	} else {
		m.advance(m.a.DB, channel, &s, true)
	}
	s.Revision++
	m.save(m.a.DB, channel, s)
	changed = true
	m.runChannel(channel, s)
}

func (m *Music) upload(r *Request) any {
	Check(m.enabled() && m.ffprobe != "", 409, "MUSIC_UPLOAD", "Music uploads are unavailable.")
	Check(r.R.Header.Get("Content-Type") == "application/octet-stream", 415, "MUSIC_UPLOAD", "Choose an audio file.")
	channel, uid := r.Param("channel"), r.UID()
	list := VString(M{"list": r.Query("list")}, "list", 1, 80, false)
	title := VString(M{"name": r.Query("name")}, "name", 1, 100, true)
	Check(r.Query("rights") == "yes", 400, "MUSIC_RIGHTS", "Confirm you have permission to share this audio.")
	Check(r.R.ContentLength <= standardMusicMB*musicMB, 413, "MUSIC_UPLOAD", "The file is larger than 30 MB.")
	m.a.DB.Tx(func(tx *DB) any {
		m.checkUpload(tx, r, channel, list, 0)
		return nil
	})
	select {
	case m.uploads <- struct{}{}:
		defer func() { <-m.uploads }()
	default:
		Fail(429, "MUSIC_UPLOAD", "Another audio file is being processed. Try again shortly.")
	}
	dir := filepath.Join(m.a.C.DataDir, "music", "uploads")
	if err := os.MkdirAll(dir, 0700); err != nil {
		panic(err)
	}
	source, err := os.CreateTemp(dir, "source-*")
	if err != nil {
		panic(err)
	}
	defer os.Remove(source.Name())
	bytes, copyErr := io.Copy(source, io.LimitReader(r.R.Body, standardMusicMB*musicMB+1))
	closeErr := source.Close()
	Check(copyErr == nil && closeErr == nil && bytes > 0 && bytes <= standardMusicMB*musicMB, 400, "MUSIC_UPLOAD", "Choose a valid audio file smaller than 30 MB.")
	m.a.DB.Tx(func(tx *DB) any {
		m.checkUpload(tx, r, channel, list, bytes)
		return nil
	})
	id := ID()
	output := filepath.Join(dir, id+".ogg")
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(output)
		}
	}()
	ctx, cancel := context.WithTimeout(r.R.Context(), 35*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, m.ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mp3,aac,mov,wav,flac,ogg,matroska,webm", "-threads", "1", "-filter_threads", "1", "-i", source.Name(), "-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn", "-t", "601", "-ar", "48000", "-ac", "2", "-threads", "1", "-c:a", "libopus", "-b:a", "96k", "-f", "ogg", output)
	cmd.Env = musicProcessEnv()
	Check(cmd.Run() == nil, 400, "MUSIC_UPLOAD", "This file could not be decoded as supported audio.")
	duration := probeMusic(ctx, m.ffprobe, output)
	Check(duration >= 1000 && duration <= 600100, 400, "MUSIC_UPLOAD", "Music uploads must be between one second and ten minutes.")
	track := musicTrack{ID: id, Title: title, Artist: "Community upload", Duration: min(duration, 600000), Source: "upload", Explicit: r.Query("explicit") == "yes"}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.a.DB.Tx(func(tx *DB) any {
		m.checkUpload(tx, r, channel, list, bytes)
		tx.Run("INSERT INTO music_member_tracks(id,owner_id,list_id,title,track,bytes,created_at) VALUES(?,?,?,?,?,?,?)",
			id, uid, list, title, JSON(track), bytes, Now())
		return nil
	})
	keep = true
	return track
}

func (m *Music) checkUpload(tx *DB, r *Request, channel, list string, size int64) {
	state := m.read(tx, channel)
	access := m.access(tx, r, channel, state.Policy)
	Check(!state.Policy.Disabled && state.Policy.AllowUploads && access.request, 403, "MUSIC_UPLOAD", "Audio uploads are disabled in this channel.")
	Check(r.Query("explicit") != "yes" || state.Policy.AllowExplicit, 403, "MUSIC_UPLOAD", "Explicit audio is disabled in this channel.")
	Check(B(musicOwnList(tx, r.UID(), list)["public"]), 403, "MUSIC_PLAYLIST", "Choose a public playlist to upload audio.")
	allowance := musicAllowance(tx, r.UID())
	Check(size <= N(allowance["limitBytes"])-N(allowance["usedBytes"]), 413, "MUSIC_QUOTA", "This file would exceed your music storage allowance.")
}
