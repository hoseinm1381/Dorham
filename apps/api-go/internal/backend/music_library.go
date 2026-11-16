package backend

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

func (m *Music) loadCatalog() error {
	if config := env("MUSIC_LIBRARY", ""); config != "" {
		f, err := os.Open(config)
		if err != nil {
			return err
		}
		defer f.Close()
		stat, err := f.Stat()
		if err != nil || stat.Size() > 1024*1024 {
			return errors.New("invalid music catalog file")
		}
		var list []musicAsset
		decoder := json.NewDecoder(f)
		decoder.DisallowUnknownFields()
		if err = decoder.Decode(&list); err != nil || len(list) > 500 {
			return errors.New("invalid music catalog")
		}
		for _, a := range list {
			if a.ID == "" || len(a.ID) > 70 || a.Title == "" || len(a.Title) > 180 || len(a.Artist) > 180 || len(a.Album) > 180 || strings.HasPrefix(a.ID, "starter-") {
				return errors.New("invalid music catalog metadata")
			}
			if _, duplicate := m.catalog[a.ID]; duplicate {
				return errors.New("duplicate music catalog track")
			}
			if a.URL != "" {
				u, err := url.Parse(a.URL)
				if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || a.File != "" || (u.Port() != "" && u.Port() != "443") {
					return errors.New("invalid music station")
				}
				a.Live = true
				a.Duration = 0
				a.Source = "radio"
			} else {
				if a.File == "" || filepath.IsAbs(a.File) || strings.Contains(a.File, ":") {
					return errors.New("invalid music catalog path")
				}
				base, err := filepath.EvalSymlinks(filepath.Dir(absolute(config)))
				if err != nil {
					return err
				}
				p, err := filepath.EvalSymlinks(filepath.Join(base, a.File))
				if err != nil {
					return err
				}
				relative, err := filepath.Rel(base, p)
				if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
					return errors.New("music file is outside the catalog directory")
				}
				info, err := os.Stat(p)
				if err != nil || !info.Mode().IsRegular() {
					return errors.New("music library file is unavailable")
				}
				if a.Duration < 1000 || a.Duration > 4*60*60*1000 {
					return errors.New("invalid catalog track duration")
				}
				a.File = p
				a.Live = false
				a.Source = "library"
			}
			m.catalog[a.ID] = a
		}
	}
	if err := m.seedMusic(); err != nil {
		return err
	}
	m.original = musicPlaylist{ID: originalPlaylistID, Name: "Dorham Originals", Shared: true, Original: true}
	for _, starter := range starterMusic {
		m.original.Tracks = append(m.original.Tracks, "starter-"+starter.id)
	}
	if path := env("MUSIC_ORIGINAL_PLAYLIST", ""); path != "" {
		if err := m.loadOriginalPlaylist(path); err != nil {
			return err
		}
	}
	return nil
}

func (m *Music) loadOriginalPlaylist(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return errors.New("invalid original music playlist file")
	}
	var configured struct {
		Name   string   `json:"name"`
		Tracks []string `json:"tracks"`
	}
	d := json.NewDecoder(file)
	d.DisallowUnknownFields()
	if err := d.Decode(&configured); err != nil {
		return errors.New("invalid original music playlist")
	}
	configured.Name = strings.TrimSpace(configured.Name)
	if TextLen(configured.Name) < 1 || TextLen(configured.Name) > 60 || len(configured.Tracks) == 0 || len(configured.Tracks) > 100 {
		return errors.New("invalid original music playlist name or size")
	}
	seen := map[string]bool{}
	for _, id := range configured.Tracks {
		asset, known := m.catalog[id]
		if !known || asset.Live || seen[id] {
			return errors.New("the original playlist must reference distinct catalog tracks")
		}
		seen[id] = true
	}
	m.original.Name, m.original.Tracks = configured.Name, configured.Tracks
	return nil
}

func probeMusic(ctx context.Context, ffprobe, path string) int64 {
	cmd := exec.CommandContext(ctx, ffprobe, "-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path)
	cmd.Env = musicProcessEnv()
	raw, err := cmd.Output()
	if err != nil {
		return 0
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > 10000 {
		return 0
	}
	return int64(math.Round(seconds * 1000))
}

var starterMusic = []struct {
	id, title string
	notes     [8]int
	bpm       float64
}{
	{"rain", "Evening Rain", [8]int{57, 60, 64, 67, 55, 60, 62, 64}, 82},
	{"caravan", "Night Caravan", [8]int{57, 58, 61, 64, 65, 64, 61, 58}, 104},
	{"sunrise", "First Light", [8]int{60, 64, 67, 71, 62, 65, 69, 72}, 116},
}

func (m *Music) seedMusic() error {
	dir := filepath.Join(m.a.C.DataDir, "music", "starter")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	for _, preset := range starterMusic {
		id := "starter-" + preset.id
		path := filepath.Join(dir, id+".wav")
		duration := int64(math.Round(16000 * 60 / preset.bpm))
		if _, err := os.Stat(path); os.IsNotExist(err) {
			if err := renderStarter(path, preset.notes, preset.bpm); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		m.catalog[id] = musicAsset{musicTrack: musicTrack{ID: id, Title: preset.title, Artist: "Dorham", Album: "Dorham Sessions", Duration: duration, Source: "library"}, File: path}
	}
	return nil
}

// These short original instrumentals are synthesized from preset note sequences.
func renderStarter(path string, notes [8]int, bpm float64) error {
	f, err := os.CreateTemp(filepath.Dir(path), "starter-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	rate := 22050
	beat := 60 / bpm
	samples := int(16 * beat * float64(rate))
	w := bufio.NewWriter(f)
	head := make([]byte, 44)
	copy(head, "RIFF")
	copy(head[8:], "WAVEfmt ")
	copy(head[36:], "data")
	binary.LittleEndian.PutUint32(head[4:], uint32(36+samples*2))
	binary.LittleEndian.PutUint32(head[16:], 16)
	binary.LittleEndian.PutUint16(head[20:], 1)
	binary.LittleEndian.PutUint16(head[22:], 1)
	binary.LittleEndian.PutUint32(head[24:], uint32(rate))
	binary.LittleEndian.PutUint32(head[28:], uint32(rate*2))
	binary.LittleEndian.PutUint16(head[32:], 2)
	binary.LittleEndian.PutUint16(head[34:], 16)
	binary.LittleEndian.PutUint32(head[40:], uint32(samples*2))
	_, _ = w.Write(head)
	var frame [2]byte
	for i := 0; i < samples; i++ {
		t := float64(i) / float64(rate)
		index := int(t / beat)
		offset := math.Mod(t, beat)
		freq := 440 * math.Exp2(float64(notes[index%len(notes)]-69)/12)
		p := 2 * math.Pi * freq * offset
		pulse := math.Min(1, offset*55) * math.Exp(-offset*6)
		bass := math.Sin(2*math.Pi*freq/4*offset) * math.Min(1, offset*25) * math.Exp(-offset*4)
		echo := math.Sin(p*1.5) * pulse * 0.12
		kick := math.Sin(2*math.Pi*(52*offset+2*(1-math.Exp(-48*offset)))) * math.Exp(-offset*28)
		fade := math.Min(1, math.Min(t*12, (float64(samples-i)/float64(rate))*3))
		mix := fade * (0.22*math.Sin(p)*pulse + 0.07*math.Sin(p*2)*pulse + 0.15*bass + echo + 0.08*kick)
		binary.LittleEndian.PutUint16(frame[:], uint16(int16(mix*30000)))
		_, _ = w.Write(frame[:])
	}
	if err = w.Flush(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
