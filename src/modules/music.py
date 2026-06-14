# python -m nuitka --standalone --onefile music.py
# python -m nuitka --standalone --onefile --nofollow-import-to=yt_dlp.extractor.lazy_extractors --output-dir=build music.py
import yt_dlp
import json
import sys

def get_video_info(url: str) -> None:
    try:
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'noplaylist': True,
            'no_warnings': True,
            'format': 'bestaudio/best',
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios']
                }
            },
            'cache_dir': '/tmp/yt_dlp_cache'
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl: # type: ignore
            info = ydl.extract_info(url, download=False)

        formats = info.get('formats') or []

        audio_formats = [
            f for f in formats
            if f.get('acodec') not in (None, 'none')
            and f.get('vcodec') in (None, 'none')
            and f.get('url')
        ]
        if not audio_formats:
            audio_formats = [
                f for f in formats
                if f.get('acodec') not in (None, 'none') and f.get('url')
            ]

        if not audio_formats:
            print(json.dumps({'status': 'error', 'message': 'No audio format found!'}))

        best = max(audio_formats, key=lambda f: (f.get('abr') or 0, f.get('tbr') or 0))

        print(json.dumps({
            'status': 'success',
            'title': info.get('title'),
            'duration': info.get('duration'),
            'url': best['url'],
            'ext': best.get('ext'),
            'abr': best.get('abr'),
            'mimeType': best.get('mime_type')
        }))
    except Exception as e:
        print(json.dumps({'status': 'error', 'message': str(e)})) # type: ignore

if __name__ == '__main__':
    if len(sys.argv) > 1:
        get_video_info(sys.argv[1])
    else:
        print(json.dumps({'status': 'error', 'message': "URL not found!"}))