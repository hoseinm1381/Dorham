package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

type resolvedLink struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

func resolveMusicLink(source string) ([]resolvedLink, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	response, err := stationRequest(ctx, source, false)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	content, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	extension := strings.ToLower(path.Ext(response.Request.URL.Path))
	if extension == ".m3u" || extension == ".m3u8" || content == "audio/x-mpegurl" || content == "application/vnd.apple.mpegurl" || content == "application/x-mpegurl" {
		scanner := bufio.NewScanner(io.LimitReader(response.Body, 512000))
		scanner.Buffer(make([]byte, 2048), 8192)
		links := []resolvedLink{}
		title := ""
		for scanner.Scan() {
			line := strings.TrimSpace(strings.TrimPrefix(scanner.Text(), "\ufeff"))
			if strings.HasPrefix(line, "#EXT-X-") {
				return nil, errors.New("HLS is not a track playlist")
			}
			if strings.HasPrefix(line, "#EXTINF:") {
				_, title, _ = strings.Cut(line, ",")
			} else if line != "" && !strings.HasPrefix(line, "#") {
				relative, err := url.Parse(line)
				if err != nil {
					return nil, err
				}
				target := response.Request.URL.ResolveReference(relative)
				if !validStationURL(target) || len(target.String()) > 2048 {
					return nil, errors.New("invalid playlist track")
				}
				links = append(links, resolvedLink{URL: target.String(), Title: linkTitle(target, title)})
				title = ""
				if len(links) > 100 {
					return nil, errors.New("playlist too large")
				}
			}
		}
		if scanner.Err() != nil || len(links) == 0 {
			return nil, errors.New("invalid playlist")
		}
		return links, nil
	}
	if !musicLinkAudio(content, extension) {
		return nil, errors.New("a direct audio URL is required")
	}
	return []resolvedLink{{URL: response.Request.URL.String(), Title: linkTitle(response.Request.URL, "")}}, nil
}

func musicLinkAudio(content, extension string) bool {
	if strings.HasPrefix(content, "audio/") {
		return true
	}
	if content != "application/octet-stream" && content != "" {
		return false
	}
	switch extension {
	case ".mp3", ".aac", ".m4a", ".mp4", ".wav", ".flac", ".ogg", ".opus", ".webm":
		return true
	}
	return false
}
func validStationURL(u *url.URL) bool {
	return u != nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && (u.Port() == "" || u.Port() == "443") && u.Fragment == ""
}
func linkTitle(u *url.URL, title string) string {
	if title == "" {
		file := path.Base(u.Path)
		title = strings.TrimSpace(strings.TrimSuffix(file, path.Ext(file)))
	}
	if title == "" || title == "/" || title == "." {
		title = u.Hostname()
	}
	title = strings.Map(func(c rune) rune {
		if c < 32 || c == 127 {
			return -1
		}
		return c
	}, title)
	chars := []rune(title)
	return string(chars[:min(110, len(chars))])
}

func resolveRequest(input io.Reader, output io.Writer) error {
	var job struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(io.LimitReader(input, 8192)).Decode(&job); err != nil {
		return err
	}
	result, err := resolveMusicLink(job.URL)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(result)
}

func stationRequest(ctx context.Context, source string, sameHost bool) (*http.Response, error) {
	return fetchMusicSource(ctx, source, sameHost)
}
