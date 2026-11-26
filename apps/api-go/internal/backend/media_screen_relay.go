package backend

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
)

const (
	screenRelayPrefix = "dorham-screen:"
	screenRelayFPS    = 6
	screenRelayEdge   = 240
)

type screenRelayKey struct {
	room, lease, publisher string
}

type screenRelayJob struct {
	key    screenRelayKey
	ctx    context.Context
	cancel context.CancelFunc
}

type screenRelayManager struct {
	m       *Media
	ffmpeg  string
	slots   int
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	mu      sync.Mutex
	jobs    map[string]*screenRelayJob
	retryAt map[string]time.Time
}

func newScreenRelayManager(m *Media) *screenRelayManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &screenRelayManager{m: m, ctx: ctx, cancel: cancel, jobs: make(map[string]*screenRelayJob), retryAt: make(map[string]time.Time)}
}

func (s *screenRelayManager) start() {
	if s.m.a.C.MediaTransport != "livekit" {
		return
	}
	s.slots = min(envInt("SCREEN_RELAY_SLOTS", 1, true), 3)
	if s.slots == 0 {
		return
	}
	path, err := exec.LookPath(envDefault("SCREEN_RELAY_FFMPEG", "ffmpeg"))
	if err != nil {
		log.Print("screen relay unavailable: FFmpeg was not found")
		return
	}
	s.ffmpeg = path
	s.wg.Go(func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-ticker.C:
				s.reconcile()
			}
		}
	})
}

func (s *screenRelayManager) close() {
	s.cancel()
	s.wg.Wait()
}

func (s *screenRelayManager) valid(db *DB, room, identity string) bool {
	lease := strings.TrimPrefix(identity, screenRelayPrefix)
	s.mu.Lock()
	job := s.jobs[lease]
	s.mu.Unlock()
	if job == nil || job.key.room != room || job.ctx.Err() != nil {
		return false
	}
	return db.One("SELECT id FROM share_leases WHERE id=? AND channel_id=? AND expires_at>?", lease, room, Now()) != nil
}

func (s *screenRelayManager) reconcile() {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("screen relay reconciliation failed: %T", p)
		}
	}()
	now := Now()
	rows := s.m.a.DB.All(`SELECT l.id,l.user_id,l.channel_id,v.epoch
		FROM share_leases l
		JOIN voice_members v ON v.user_id=l.user_id AND v.channel_id=l.channel_id
		JOIN users u ON u.id=l.user_id
		WHERE l.expires_at>? AND v.heartbeat>=? AND u.banned=0 AND u.must_change_password=0
		AND EXISTS (SELECT 1 FROM voice_members viewer WHERE viewer.channel_id=l.channel_id AND viewer.user_id<>l.user_id AND viewer.heartbeat>=?)
		ORDER BY l.started_at,l.id`, now, now-30000, now-30000)
	active := make(map[string]screenRelayKey, len(rows))
	keys := make([]screenRelayKey, 0, len(rows))
	for _, row := range rows {
		key := screenRelayKey{Str(row, "channel_id"), Str(row, "id"), Str(row, "user_id") + ":" + Str(row, "epoch")}
		active[key.lease] = key
		keys = append(keys, key)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for lease, job := range s.jobs {
		if active[lease] != job.key {
			job.cancel()
		}
	}
	for lease := range s.retryAt {
		if _, ok := active[lease]; !ok {
			delete(s.retryAt, lease)
		}
	}
	for _, key := range keys {
		if s.ctx.Err() != nil || len(s.jobs) >= s.slots {
			break
		}
		if s.jobs[key.lease] != nil || time.Now().Before(s.retryAt[key.lease]) {
			continue
		}
		ctx, cancel := context.WithCancel(s.ctx)
		job := &screenRelayJob{key: key, ctx: ctx, cancel: cancel}
		s.jobs[key.lease] = job
		s.wg.Go(func() {
			err := s.run(ctx, key)
			if err != nil && ctx.Err() == nil {
				log.Printf("screen relay stopped: %v", err)
			}
			cancel()
			s.mu.Lock()
			delete(s.jobs, key.lease)
			s.retryAt[key.lease] = time.Now().Add(2 * time.Second)
			s.mu.Unlock()
		})
	}
}

type screenRelayInput struct {
	track       *webrtc.TrackRemote
	participant *lksdk.RemoteParticipant
	width       uint16
	height      uint16
}

func (s *screenRelayManager) run(ctx context.Context, key screenRelayKey) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	callback := lksdk.NewRoomCallback()
	inputs := make(chan screenRelayInput, 1)
	callback.OnTrackPublished = func(pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		if p.Identity() == key.publisher && pub.Source() == livekit.TrackSource_SCREEN_SHARE {
			_ = pub.SetSubscribed(true)
		}
	}
	callback.OnTrackSubscribed = func(track *webrtc.TrackRemote, pub *lksdk.RemoteTrackPublication, p *lksdk.RemoteParticipant) {
		if p.Identity() != key.publisher || pub.Source() != livekit.TrackSource_SCREEN_SHARE {
			return
		}
		info := pub.TrackInfo()
		select {
		case inputs <- screenRelayInput{track, p, uint16(min(info.Width, 4096)), uint16(min(info.Height, 4096))}:
		default:
		}
	}
	callback.OnDisconnected = cancel

	c := s.m.a.C
	address := c.LivekitAPIURL
	if address == "" {
		address = c.LivekitURL
	}
	token := mediaJWT(c.LivekitKey, c.LivekitSecret, screenRelayPrefix+key.lease, M{
		"roomJoin": true, "room": key.room, "canSubscribe": true, "canPublish": true,
		"canPublishSources": []string{"camera"}, "canPublishData": false, "canUpdateOwnMetadata": false,
	}, 60)
	room, err := lksdk.ConnectToRoomWithToken(address, token, callback,
		lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(5*time.Second), lksdk.WithLogger(logger.GetDiscardLogger()))
	if err != nil {
		return errors.New("could not connect to LiveKit")
	}
	defer room.Disconnect()
	if publisher := room.GetParticipantByIdentity(key.publisher); publisher != nil {
		for _, publication := range publisher.TrackPublications() {
			if remote, ok := publication.(*lksdk.RemoteTrackPublication); ok {
				callback.OnTrackPublished(remote, publisher)
			}
		}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(12 * time.Second):
		return errors.New("screen publication was unavailable")
	case input := <-inputs:
		return s.transcode(ctx, room, input)
	}
}

func screenRelaySize(width, height uint16) (int, int) {
	w, h := int(width), int(height)
	if w < 2 || h < 2 {
		return 426, screenRelayEdge
	}
	short := min(screenRelayEdge, w, h)
	long := min(512, max(w, h)*short/min(w, h))
	if w < h {
		return short &^ 1, long &^ 1
	}
	return long &^ 1, short &^ 1
}

func (s *screenRelayManager) transcode(ctx context.Context, room *lksdk.Room, input screenRelayInput) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	codec := input.track.Codec().MimeType
	if !strings.EqualFold(codec, webrtc.MimeTypeVP8) && !strings.EqualFold(codec, webrtc.MimeTypeVP9) {
		return errors.New("unsupported screen codec")
	}
	width, height := screenRelaySize(input.width, input.height)
	filter := fmt.Sprintf("fps=%d,scale=%d:%d:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=fast_bilinear,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1", screenRelayFPS, width, height, width, height)
	cmd := exec.CommandContext(ctx, s.ffmpeg,
		"-hide_banner", "-loglevel", "error", "-protocol_whitelist", "pipe",
		"-threads", "1", "-max_pixels", "4194304", "-probesize", "32", "-analyzeduration", "0", "-f", "ivf", "-i", "pipe:0",
		"-an", "-filter_threads", "1", "-vf", filter, "-pix_fmt", "yuv420p", "-c:v", "libvpx",
		"-threads", "1", "-deadline", "realtime", "-cpu-used", "8", "-lag-in-frames", "0",
		"-b:v", "70k", "-minrate", "70k", "-maxrate", "70k", "-bufsize", "70k", "-max-intra-rate", "160",
		"-g", "12", "-flush_packets", "1", "-f", "ivf", "pipe:1")
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return err
	}
	detached := context.AfterFunc(ctx, func() {
		_ = input.track.SetReadDeadline(time.Now())
		_ = in.Close()
	})
	inputDone := make(chan struct{})
	go func() {
		defer close(inputDone)
		defer in.Close()
		_ = writeScreenRelayInput(ctx, input, in, codec)
	}()
	defer func() {
		cancel()
		<-inputDone
		detached()
		_ = cmd.Wait()
	}()
	reader, header, err := ivfreader.NewWith(out)
	if err != nil || header.FourCC != "VP80" {
		return errors.New("FFmpeg did not produce VP8 video")
	}
	// Publish only when the encoder has actually produced a frame. Existing
	// clients ignore this server-only camera source and keep their direct feed.
	frame, _, err := reader.ParseNextFrame()
	if err != nil {
		return errors.New("FFmpeg did not produce a video frame")
	}
	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000})
	if err != nil {
		return err
	}
	publication, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Source: livekit.TrackSource_CAMERA, Name: "Dorham low bandwidth", VideoWidth: width, VideoHeight: height,
	})
	if err != nil {
		return fmt.Errorf("could not publish low-bandwidth video: %w", err)
	}
	defer room.LocalParticipant.UnpublishTrack(publication.SID())
	for ctx.Err() == nil {
		if err := track.WriteSample(media.Sample{Data: frame, Duration: time.Second / screenRelayFPS}, nil); err != nil {
			return err
		}
		frame, _, err = reader.ParseNextFrame()
		if err != nil {
			return err
		}
	}
	return ctx.Err()
}

func writeScreenRelayInput(ctx context.Context, input screenRelayInput, output io.Writer, codec string) error {
	// RTP video already uses a 90 kHz clock. Keep its exact timestamps so the
	// decoder sees the right intervals even as the publisher reduces its FPS.
	writer, err := ivfwriter.NewWith(output, ivfwriter.WithCodec(codec), ivfwriter.WithWidthAndHeight(input.width, input.height),
		ivfwriter.WithFrameRate(1, 90000), ivfwriter.WithDirectPTS())
	if err != nil {
		return err
	}
	input.participant.WritePLI(input.track.SSRC())
	packets := 0
	for ctx.Err() == nil {
		_ = input.track.SetReadDeadline(time.Now().Add(10 * time.Second))
		packet, _, err := input.track.ReadRTP()
		if err != nil {
			return err
		}
		packets++
		// Guard the depacketizer against an unbounded unfinished frame.
		if packets > 2048 || len(packet.Payload) > 1500 {
			return errors.New("screen frame exceeds the relay input limit")
		}
		if err := writer.WriteRTP(packet); err != nil {
			return err
		}
		if packet.Marker {
			packets = 0
		}
	}
	return ctx.Err()
}
