package backend

import (
	"crypto/sha256"
)

type mediaSpeechReuse struct {
	chunks         [][]byte
	bytes, expires int64
}

func (s *mediaSpeech) removeReuse(key [32]byte) {
	s.reuseBytes -= s.reuse[key].bytes
	delete(s.reuse, key)
}
func (s *mediaSpeech) evictReuse() {
	var oldest [32]byte
	expiry := int64(1 << 62)
	for key, entry := range s.reuse {
		if entry.expires < expiry {
			oldest, expiry = key, entry.expires
		}
	}
	s.removeReuse(oldest)
}
func (s *mediaSpeech) reused(text string) [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := sha256.Sum256([]byte(text))
	if entry, ok := s.reuse[key]; ok {
		if entry.expires > Now() {
			s.cacheHits++
			return entry.chunks
		}
		s.removeReuse(key)
	}
	return nil
}
func (s *mediaSpeech) remember(text string, chunks [][]byte) {
	if s.worker.underPressure() {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	var size int64
	for _, chunk := range chunks {
		size += int64(len(chunk))
	}
	budget := int64(s.m.a.C.TTSAudioCacheMiB) * mediaMiB
	if size == 0 || size > budget {
		return
	}
	key := sha256.Sum256([]byte(text))
	if _, ok := s.reuse[key]; ok {
		s.removeReuse(key)
	}
	for len(s.reuse) > 0 && (len(s.reuse) >= 16 || s.audioBytes+s.reuseBytes+size > budget) {
		s.evictReuse()
	}
	if s.audioBytes+s.reuseBytes+size > budget {
		return
	}
	s.reuse[key] = mediaSpeechReuse{chunks, size, Now() + 120000}
	s.reuseBytes += size
}
