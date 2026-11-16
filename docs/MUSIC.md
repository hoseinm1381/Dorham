# Dorham Music

Music appears in server voice channels when the Go backend uses LiveKit and the operator enables Music. Open **Music** in the voice controls or select **Dorham Music** in the participants. Use the volume button on the participant row or the **Your listening** controls to change personal playback. DJs and channel managers get additional controls in the same player. No chat commands are needed.

## Local setup

Build the existing Go backend and web bundle from this checkout. Build the separate Go worker with `go build -trimpath -o dorham-music-worker ./` from `tools/music-worker`. Use the platform's executable extension when applicable. Install FFmpeg with the Opus encoder and FFprobe on the service host. Supply their absolute paths in the backend environment.

| Environment variable | Purpose |
| --- | --- |
| `MUSIC_ENABLED=true` | Enables Music when LiveKit and the worker are available. |
| `MUSIC_WORKER` | Absolute path to the publisher executable. |
| `MUSIC_FFMPEG`, `MUSIC_FFPROBE` | Absolute paths to the audio tools. FFprobe enables upload validation. |
| `MUSIC_LIBRARY` | Optional absolute path to the operator-managed library JSON. Built-in tracks are available without this file. |
| `MUSIC_MAX_ROOMS` | Maximum simultaneous publishing rooms. Defaults to three and should be validated on the target host. |

Use the official LiveKit server credentials already configured for the Go backend. The backend issues short-lived, room-scoped tokens and passes them to the worker's standard input. Allow the worker to reach LiveKit and separately approved station hosts. Keep the worker and FFmpeg updated and apply the service's CPU, memory, process and filesystem limits.

The database migration adds Music room state and the upload index. The starter audio and validated uploads live under `DATA_DIR/music`. Include both the database and this directory in backups. When the backend or publisher is restarted, interrupted playback is retained as paused with its last saved position. A DJ can resume from the player.

## Managed music library

The optional JSON is an array. A local file must be within the same directory tree as this catalog. Duration is in milliseconds. A live source is a direct HTTPS audio stream, with same-host redirects only. Use sources that permit playback to channel members.

The release catalogs are in `music-pack/`. Supply the catalog audio separately under `music-pack/audio/` when building the release fixture. Operator-provided audio and raw inputs in `new_musics/` stay local. The built-in starter library works without those files.

```json
[
  {
    "id": "shared-track",
    "title": "Shared track",
    "artist": "Artist name",
    "album": "Licensed collection",
    "duration": 173000,
    "file": "audio/shared-track.ogg",
    "explicit": false
  },
  {
    "id": "approved-station",
    "title": "Approved station",
    "artist": "Radio",
    "url": "https://example.com/direct-audio"
  }
]
```

Channel managers can control audio uploads in **Music settings**. Registered members can upload to their own public playlist from **Community**. The base allowance is 30 MB per account, measured from the source files. An administrator can grant additional megabytes to a particular account in **Dorham Monitor → People → Plus**. Each file can be up to 30 MB and ten minutes. The server validates the audio and stores a normalized Opus copy. Removing an upload frees its allowance.

Members can play a direct HTTPS audio URL from Library search or save a direct audio or M3U playlist URL in Community. Linked audio is fetched for playback and uses no upload allowance. An M3U import accepts up to 100 direct audio entries. Existing channel queue limits still apply. The publisher rejects non-public destinations and validates every redirect.

## Verification

The backend and worker each have Go tests. The browser check in `tests/music-browser-check.playwright` expects a local Go fixture on port 17889 with LiveKit, FFmpeg, FFprobe, Music enabled, the 28-track release catalog, the fixture bootstrap secret, a fresh database, and the production web bundle. Open a dedicated isolated Chrome session through Playwright CLI with synthetic media enabled, then use `run-code --filename tests/music-browser-check.playwright`. It exercises three independent accounts and measures decoded output.

Before a release, verify installer upgrades and a physical Android handset with the screen locked, and measure production-host capacity with voice and screen sharing active.


## The official playlist

The player pins a single `Dorham Originals` playlist in every enabled voice channel. Listeners can queue it when their role is allowed to request tracks. Members keep their own playlists alongside it. DJs can moderate the shared queue without changing the official list.

For the final playlist, add the authorized audio files and their metadata to `MUSIC_LIBRARY`. Set `MUSIC_ORIGINAL_PLAYLIST` to an absolute path to a JSON file with a display name and the ordered catalog IDs:

```json
{
  "name": "Dorham Originals",
  "tracks": ["shared-track", "another-catalog-track"]
}
```

The supplied file replaces the starter playlist. Every ID must point to a distinct catalog audio file. The starter playlist stays available for local development when the operator does not specify a file.
