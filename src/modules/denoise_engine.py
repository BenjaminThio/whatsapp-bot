"""
Reads audio bytes from stdin, applies a high-pass filter and noise reduction,
and writes OGG/Opus bytes to stdout. Status/errors go to stderr.

Output format is OGG/Opus because WhatsApp renders that natively as a voice
note (play button, waveform, etc) and treats raw WAV as an unreliable attachment.
"""
import sys
import io
import traceback
import subprocess
import shutil
from typing import cast


def report_and_exit(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    sys.exit(code)


def main() -> None:
    # Imports inside main so failures get reported to stderr
    try:
        import numpy as np
        from scipy.signal import butter, sosfilt
        import soundfile as sf
        import noisereduce as nr
    except ImportError as e:
        print(f"FATAL: Missing dependency: {e}", file=sys.stderr)
        print("Install with: pip install numpy scipy soundfile noisereduce", file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(f"FATAL: Unexpected import error: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(2)

    # ffmpeg is required for the OGG/Opus output stage
    if not shutil.which("ffmpeg"):
        report_and_exit(
            "ffmpeg is not on PATH. Install it (choco install ffmpeg, or ffmpeg.org)\n"
            "and ensure 'ffmpeg' is accessible from the command line.", code=2
        )

    # Read input bytes
    try:
        input_data = sys.stdin.buffer.read()
    except Exception as e:
        report_and_exit(f"Error reading stdin: {e}")

    if not input_data:
        report_and_exit("Error: No input audio provided on stdin.")

    print(f"Received {len(input_data)} bytes from stdin.", file=sys.stderr)

    # Decode audio (soundfile first, ffmpeg fallback for tricky codecs)
    data = None
    rate = None
    try:
        with io.BytesIO(input_data) as in_io:
            data, rate = sf.read(in_io)
        print(f"Decoded via soundfile: {len(data)} samples @ {rate} Hz", file=sys.stderr)
    except Exception as sf_err:
        print(f"soundfile couldn't decode directly ({sf_err}); trying ffmpeg...", file=sys.stderr)
        try:
            proc = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error",
                 "-i", "pipe:0",
                 "-f", "wav",
                 "-acodec", "pcm_s16le",
                 "-ar", "48000",
                 "pipe:1"],
                input=input_data,
                capture_output=True,
                timeout=60,
            )
            if proc.returncode != 0:
                report_and_exit(
                    f"ffmpeg decode failed (code {proc.returncode}):\n"
                    f"{proc.stderr.decode('utf-8', errors='replace')}"
                )
            with io.BytesIO(proc.stdout) as wav_io:
                data, rate = sf.read(wav_io)
            print(f"Decoded via ffmpeg: {len(data)} samples @ {rate} Hz", file=sys.stderr)
        except subprocess.TimeoutExpired:
            report_and_exit("ffmpeg timed out converting audio.")
        except Exception as e:
            report_and_exit(f"ffmpeg decode fallback failed: {e}")

    # DSP
    if data.ndim > 1:
        data = data.T

    def apply_high_pass(audio, sr, cutoff: int = 80):
        sos = cast(np.ndarray, butter(N=6, Wn=cutoff, btype="highpass", output="sos", fs=sr))
        if audio.ndim > 1:
            out = audio.copy()
            for i in range(audio.shape[0]):
                out[i] = sosfilt(sos, audio[i])
            return out
        return cast(np.ndarray, sosfilt(sos, audio))

    try:
        data = apply_high_pass(data, rate)
        print("High-pass filter applied.", file=sys.stderr)
    except Exception as e:
        report_and_exit(f"High-pass filter failed: {e}")

    try:
        noise_len = int(0.5 * rate)
        if data.shape[-1] < noise_len:
            noise_len = max(1, data.shape[-1] // 4)
        noise_part = data[..., :noise_len]

        reduced_noise = nr.reduce_noise(
            y=data,
            sr=rate,
            stationary=True,
            y_noise=noise_part,
            prop_decrease=0.95,
            time_constant_s=2.0,
            n_jobs=1,
        )
        print("Noise reduction applied.", file=sys.stderr)
    except Exception as e:
        report_and_exit(f"Noise reduction failed: {e}")

    if reduced_noise.ndim > 1:
        reduced_noise = reduced_noise.T

    # Encode result as WAV in memory, then pipe through ffmpeg => OGG/Opus
    # WhatsApp plays OGG/Opus natively (it's the codec used for voice notes).
    # Sending raw WAV results in a broken/unplayable audio bubble.
    try:
        with io.BytesIO() as wav_io:
            sf.write(wav_io, reduced_noise, rate, format="WAV")
            wav_bytes = wav_io.getvalue()
        print(f"Encoded intermediate WAV: {len(wav_bytes)} bytes", file=sys.stderr)

        # Convert WAV => OGG/Opus (mono, 48kHz, 32 kbps - matches WhatsApp voice notes)
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error",
             "-i", "pipe:0",
             "-c:a", "libopus",
             "-b:a", "32k",
             "-ar", "48000",
             "-ac", "1",
             "-application", "voip",   # tuned for speech
             "-f", "ogg",
             "pipe:1"],
            input=wav_bytes,
            capture_output=True,
            timeout=60,
        )
        if proc.returncode != 0:
            report_and_exit(
                f"ffmpeg encode to OGG/Opus failed (code {proc.returncode}):\n"
                f"{proc.stderr.decode('utf-8', errors='replace')}"
            )

        opus_bytes = proc.stdout
        sys.stdout.buffer.write(opus_bytes)
        sys.stdout.flush()
        print(f"Wrote {len(opus_bytes)} bytes (OGG/Opus) to stdout.", file=sys.stderr)
    except subprocess.TimeoutExpired:
        report_and_exit("ffmpeg timed out encoding output.")
    except Exception as e:
        report_and_exit(f"Output encoding failed: {e}")


if __name__ == "__main__":
    main()