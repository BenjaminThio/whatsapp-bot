"""
music_engine.py - resolve a YouTube (or other) URL to a direct media stream URL
plus metadata, using yt-dlp. Prints a single JSON object to stdout.

Usage:  python music_engine.py <url>

Output JSON shape (matches the bot's MusicInfo interface):
  {
    "status": "success" | "error",
    "title": str | null,
    "duration": number | null,
    "url": str,            # direct stream URL
    "ext": str | null,
    "abr": number | null,  # audio bitrate
    "mimeType": str | null,
    "message": str         # only on error
  }

This is the cross-platform source equivalent of music.exe. On Windows the bot
runs the compiled .exe; on Termux/Linux it runs this via system Python.

Install:  pip install yt-dlp
"""
import sys
import json
import traceback


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def main() -> None:
    try:
        import yt_dlp
    except ImportError as e:
        emit({"status": "error", "url": "", "title": None, "duration": None,
              "ext": None, "abr": None, "mimeType": None,
              "message": f"yt-dlp not installed: {e}. Run: pip install yt-dlp"})
        sys.exit(0)  # exit 0 so the bot reads our JSON error rather than a crash

    if len(sys.argv) < 2:
        emit({"status": "error", "url": "", "title": None, "duration": None,
              "ext": None, "abr": None, "mimeType": None,
              "message": "No URL provided."})
        sys.exit(0)

    url = sys.argv[1]

    # Prefer a combined audio+video MP4 the bot can send as a video message.
    # Fall back to best available. We don't download - just resolve the URL.
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "format": "best[ext=mp4][height<=720]/best[height<=720]/best",
        "noplaylist": True,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        # If extract_info returned a playlist entry, drill into the first item
        if info.get("_type") == "playlist" and info.get("entries"):
            info = info["entries"][0]

        stream_url = info.get("url")
        if not stream_url:
            # Some formats nest the URL under requested_formats
            fmts = info.get("requested_formats") or []
            if fmts:
                stream_url = fmts[0].get("url")

        if not stream_url:
            emit({"status": "error", "url": "", "title": info.get("title"),
                  "duration": info.get("duration"), "ext": None, "abr": None,
                  "mimeType": None, "message": "Could not resolve a stream URL."})
            sys.exit(0)

        emit({
            "status": "success",
            "title": info.get("title"),
            "duration": info.get("duration"),
            "url": stream_url,
            "ext": info.get("ext"),
            "abr": info.get("abr"),
            "mimeType": info.get("mimetype") or info.get("ext"),
        })

    except Exception as e:
        # Print the traceback to stderr for server logs, but emit a clean JSON
        # error to stdout so the bot can show a friendly message.
        traceback.print_exc(file=sys.stderr)
        emit({"status": "error", "url": "", "title": None, "duration": None,
              "ext": None, "abr": None, "mimeType": None,
              "message": str(e)})
        sys.exit(0)


if __name__ == "__main__":
    main()