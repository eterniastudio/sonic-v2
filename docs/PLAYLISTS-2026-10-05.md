# YouTube playlists

Paste a YouTube playlist or a video link containing `list=` into Download, choose **Review playlists**, select tracks, and choose **Queue selected**. Direct YouTube and SoundCloud tracks can be included in the same input. The existing export format, auto-start setting, metadata inspection, cancellation and retry behavior apply to each queued track.

Playlist enumeration is separate from media acquisition: only validated, canonical single-video URLs enter the existing queue. Enumeration preserves the configured browser-cookie setting, reads flat metadata without downloading media, caps capture at 8 MiB and time at 90 seconds, and is cancelled on user cancellation or shutdown. It permits one active inspection, up to five playlists per review, the first 500 entries per playlist, and at most 1,000 distinct tracks per review. Limits are displayed rather than silently implying the entire playlist was imported. Review rows paginate in groups of 50.

Known unavailable, duplicate, live and upcoming entries are skipped. Flat metadata does not guarantee availability; individual queued probes still validate each selected track. Active queue duplicates are filtered by the existing queue service. Metadata and links remain available for retry after an error; new pasted input is preserved while earlier requests complete.

Implementation reference: [yt-dlp's documented playlist and output options](https://github.com/yt-dlp/yt-dlp/blob/master/README.md).

## Verification

- Type checking and production build passed.
- All 156 unit tests passed, including seven new playlist tests covering URL validation, normalization, flat extraction arguments, bounds, bad metadata, missing tools, cancellation, shutdown and retry.
- All nine Download interface tests passed, including playlist selection, mixed direct links, pagination, queue failures, cancellation and preserving the next pasted batch.
- The new executable passed the isolated-profile playlist IPC/missing-engine smoke test. The real bridge validates requests, shows the setup error and leaves the existing queue unchanged.
- Executable: `release/sonic-playlists-20261005/win-unpacked/Sonic V2.exe`, including the new Sonic icon. Packaged main/preload/renderer entry and icon were compared to this build.

Evidence: `test-results/playlist-unit.log`, `playlist-ui-final.json`, `playlist-packaged-final.json`, `playlist-typecheck.log`, `playlist-build.log`, and `playlist-package.log`.

First attempts are retained: the UI test incorrectly expected an `Error:` prefix; the packaged smoke test incorrectly assumed its fixture queue was empty. Both test expectations were corrected and rerun successfully. No application change was needed for those failures. Live YouTube playlist enumeration/download was not exercised; network behavior is covered with extractor fixtures, not claimed as a live success.
