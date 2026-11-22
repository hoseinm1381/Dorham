package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
)

type job struct {
	Endpoint, Token, File, URL, FFmpeg string
	PublicLink                         bool
	LowBandwidth                       bool
	Position                           int64
	Volume                             int
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--resolve-link" {
		if resolveRequest(os.Stdin, os.Stdout) != nil {
			os.Exit(1)
		}
		return
	}
	input := bufio.NewReaderSize(os.Stdin, 8192)
	line, err := input.ReadSlice('\n')
	var work job
	if err != nil || json.Unmarshal(line, &work) != nil {
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Hour)
	go func() { _, _ = io.Copy(io.Discard, input); cancel() }()
	err = publish(ctx, work)
	cancel()
	if err != nil {
		// Keep provider URLs and the short-lived token out of child process logs.
		os.Exit(1)
	}
}

func publish(ctx context.Context, work job) error {
	disconnected := make(chan struct{}, 1)
	room, err := lksdk.ConnectToRoomWithToken(work.Endpoint, work.Token, &lksdk.RoomCallback{OnDisconnected: func() {
		select {
		case disconnected <- struct{}{}:
		default:
		}
	}}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		return err
	}
	defer room.Disconnect()
	if ctx.Err() != nil {
		return ctx.Err()
	}

	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1", "-filter_threads", "1"}
	var input io.Reader
	if work.URL != "" {
		body, err := openStation(ctx, work.URL, work.PublicLink)
		if err != nil {
			return err
		}
		defer body.Close()
		input = body
		args = append(args, "-protocol_whitelist", "pipe", "-format_whitelist", "mp3,aac,flac,ogg,wav,mov,matroska,webm", "-i", "pipe:0")
	} else {
		args = append(args, "-protocol_whitelist", "file", "-ss", strconv.FormatFloat(float64(work.Position)/1000, 'f', 3, 64), "-i", work.File)
	}
	gain := strconv.FormatFloat(float64(work.Volume)/100, 'f', 2, 64)
	filter := "loudnorm=I=-20:TP=-3:LRA=11,volume=" + gain + ",alimiter=limit=0.80:level=0"
	if work.URL != "" {
		filter = "volume=" + gain + ",alimiter=limit=0.80:level=0"
	}
	channels, bitrate := "2", "96k"
	if work.LowBandwidth { channels, bitrate = "1", "48k" }
	args = append(args, "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", filter, "-ar", "48000", "-ac", channels, "-c:a", "libopus", "-application", "audio", "-b:a", bitrate, "-fec", "1", "-packet_loss", "10", "-frame_duration", "20", "-page_duration", "20000", "-flush_packets", "1", "-f", "ogg", "pipe:1")
	ff := exec.CommandContext(ctx, work.FFmpeg, args...)
	ff.Stdin = input
	ff.WaitDelay = 2 * time.Second
	output, err := ff.StdoutPipe()
	if err != nil {
		return err
	}
	if err = ff.Start(); err != nil {
		return err
	}
	waited := false
	defer func() {
		if !waited {
			_ = ff.Process.Kill()
			_ = output.Close()
			_ = ff.Wait()
		}
	}()
	done := make(chan struct{}, 1)
	track, err := lksdk.NewLocalReaderTrack(output, webrtc.MimeTypeOpus, lksdk.ReaderTrackWithOnWriteComplete(func() { done <- struct{}{} }))
	if err != nil {
		return err
	}
	defer track.Close()
	_, err = room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "Dorham Music", Source: livekit.TrackSource_MICROPHONE, Stereo: true})
	if err != nil {
		return err
	}
	fmt.Println("ready")
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-disconnected:
		return errors.New("media connection ended")
	case <-done:
		waited = true
		return ff.Wait()
	}
}

func publicStationIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsMulticast() &&
		!netip.MustParsePrefix("100.64.0.0/10").Contains(ip) && !netip.MustParsePrefix("192.0.0.0/24").Contains(ip) &&
		!netip.MustParsePrefix("64:ff9b::/96").Contains(ip) && !netip.MustParsePrefix("64:ff9b:1::/48").Contains(ip) && !netip.MustParsePrefix("2002::/16").Contains(ip)
}

func openStation(ctx context.Context, source string, public bool) (io.ReadCloser, error) {
	response, err := fetchMusicSource(ctx, source, !public)
	if err != nil {
		return nil, err
	}
	if public {
		content, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if !musicLinkAudio(content, strings.ToLower(path.Ext(response.Request.URL.Path))) {
			response.Body.Close()
			return nil, errors.New("source no longer returns direct audio")
		}
	}
	return response.Body, nil
}
func fetchMusicSource(ctx context.Context, source string, sameHost bool) (*http.Response, error) {
	origin, err := url.Parse(source)
	if err != nil || !validStationURL(origin) {
		return nil, errors.New("invalid station address")
	}
	host := origin.Hostname()
	transport := &http.Transport{TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 8 * time.Second, DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			h, port, err := net.SplitHostPort(address)
			if err != nil || (sameHost && !strings.EqualFold(h, host)) || port != "443" {
				return nil, errors.New("station address changed")
			}
			ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", h)
			if err != nil || len(ips) == 0 {
				return nil, errors.New("station DNS failed")
			}
			for _, ip := range ips {
				if !publicStationIP(ip) {
					return nil, errors.New("station IP was blocked")
				}
			}
			dialer := net.Dialer{Timeout: 5 * time.Second}
			for _, ip := range ips {
				if conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port)); err == nil {
					return conn, nil
				}
			}
			return nil, errors.New("station connection failed")
		},
	}
	client := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !validStationURL(req.URL) || (sameHost && !strings.EqualFold(req.URL.Hostname(), host)) {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", source, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, errors.New("station unavailable")
	}
	return resp, nil
}
