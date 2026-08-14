#!/usr/bin/env python3
"""
Run this on YOUR Mac (regular Terminal, not inside Cowork) — it needs normal internet access.

What it does:
  1. Downloads the audio from a YouTube link (yt-dlp)
  2. Splits it into <25MB chunks (Whisper API's file size limit)
  3. Transcribes each chunk with OpenAI's Whisper API (word-accurate, with timestamps)
  4. Stitches the chunks back into one transcript with correct absolute timestamps
  5. Saves the full audio + transcript.json + meta.json into an output folder

You then hand that output folder to Claude, who does the rest (sentence
segmentation into study cards, translation, per-card audio clipping, and
building/deploying the app).

Setup (one-time), in your Mac's Terminal.app:
    pip3 install yt-dlp requests
    brew install ffmpeg          # if you don't already have it

Usage:
    python3 process_episode.py "https://youtu.be/GHIXwFF7w38" \\
        --openai-key sk-... \\
        --show non-ho-mai \\
        --episode ep1 \\
        --out ./output

The OpenAI key is only used locally on your machine to call the API directly —
it is never sent to or stored by Claude.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import time

def die(msg):
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)

def check_deps():
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        die("Missing dependency 'yt-dlp'. Run:  pip3 install yt-dlp requests")
    try:
        import requests  # noqa: F401
    except ImportError:
        die("Missing dependency 'requests'. Run:  pip3 install yt-dlp requests")
    if subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0:
        die("ffmpeg not found. Run:  brew install ffmpeg")
    if subprocess.run(["which", "ffprobe"], capture_output=True).returncode != 0:
        die("ffprobe not found (usually comes with ffmpeg). Run:  brew install ffmpeg")


def download_audio(url, out_dir):
    import yt_dlp
    audio_path = os.path.join(out_dir, "audio")
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": audio_path + ".%(ext)s",
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "192",
        }],
        "quiet": False,
        "no_warnings": True,
    }
    print("→ Downloading audio via yt-dlp...")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
    final_path = audio_path + ".mp3"
    if not os.path.exists(final_path):
        die(f"Expected downloaded file at {final_path} but it's missing.")
    meta = {
        "sourceUrl": url,
        "title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),
    }
    return final_path, meta


def get_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True
    )
    return float(out.stdout.strip())


def cut_chunk(src_path, start, length, dest_path):
    subprocess.run(
        ["ffmpeg", "-y", "-ss", str(start), "-t", str(length), "-i", src_path,
         "-c", "copy", dest_path],
        capture_output=True
    )


def transcribe_chunk(requests, api_key, chunk_path, lang):
    with open(chunk_path, "rb") as f:
        for attempt in range(3):
            try:
                resp = requests.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    data=[
                        ("model", "whisper-1"),
                        ("language", lang),
                        ("response_format", "verbose_json"),
                        ("timestamp_granularities[]", "segment"),
                        ("timestamp_granularities[]", "word"),
                    ],
                    files={"file": (os.path.basename(chunk_path), f, "audio/mpeg")},
                    timeout=600,
                )
                if resp.status_code == 200:
                    return resp.json()
                print(f"  (attempt {attempt+1}) API error {resp.status_code}: {resp.text[:300]}")
            except Exception as e:
                print(f"  (attempt {attempt+1}) request failed: {e}")
            time.sleep(3)
            f.seek(0)
    die(f"Failed to transcribe {chunk_path} after 3 attempts.")


def main():
    p = argparse.ArgumentParser(description="Download + transcribe a YouTube episode for Capisco.")
    p.add_argument("url", help="YouTube video URL")
    p.add_argument("--openai-key", required=True, help="Your OpenAI API key (sk-...)")
    p.add_argument("--show", required=True, help="Show slug, e.g. non-ho-mai")
    p.add_argument("--episode", required=True, help="Episode slug, e.g. ep1")
    p.add_argument("--out", default="./output", help="Output base folder")
    p.add_argument("--lang", default="it", help="Language code for transcription (default: it)")
    p.add_argument("--chunk-minutes", type=float, default=15.0, help="Chunk length in minutes for the Whisper API's 25MB limit")
    args = p.parse_args()

    check_deps()
    import requests

    out_dir = os.path.join(args.out, f"{args.show}-{args.episode}")
    os.makedirs(out_dir, exist_ok=True)

    audio_path, meta = download_audio(args.url, out_dir)
    duration = get_duration(audio_path)
    print(f"→ Audio downloaded: {duration/60:.1f} minutes")

    chunk_len = args.chunk_minutes * 60
    n_chunks = math.ceil(duration / chunk_len)
    all_segments = []
    all_words = []

    with tempfile.TemporaryDirectory() as tmp:
        for i in range(n_chunks):
            start = i * chunk_len
            length = min(chunk_len, duration - start)
            chunk_path = os.path.join(tmp, f"chunk_{i}.mp3")
            print(f"→ Splitting chunk {i+1}/{n_chunks} ({start/60:.1f}–{(start+length)/60:.1f} min)...")
            cut_chunk(audio_path, start, length, chunk_path)
            size_mb = os.path.getsize(chunk_path) / (1024 * 1024)
            if size_mb > 25:
                die(f"Chunk {i+1} is {size_mb:.1f}MB, over the 25MB Whisper limit. Re-run with a smaller --chunk-minutes.")
            print(f"→ Transcribing chunk {i+1}/{n_chunks} ({size_mb:.1f}MB)...")
            result = transcribe_chunk(requests, args.openai_key, chunk_path, args.lang)
            for seg in result.get("segments", []):
                all_segments.append({
                    "start": round(seg["start"] + start, 2),
                    "end": round(seg["end"] + start, 2),
                    "text": seg["text"].strip(),
                })
            for w in result.get("words", []):
                all_words.append({
                    "start": round(w["start"] + start, 2),
                    "end": round(w["end"] + start, 2),
                    "word": w["word"],
                })

    transcript = {
        "language": args.lang,
        "duration": duration,
        "segments": all_segments,
        "words": all_words,
    }
    with open(os.path.join(out_dir, "transcript.json"), "w", encoding="utf-8") as f:
        json.dump(transcript, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n✓ Done. Wrote to {out_dir}/")
    print("    audio.mp3")
    print("    transcript.json")
    print("    meta.json")
    print("\nNext: send this whole folder to Claude (attach it in chat, or if your Mac")
    print("is connected to the Cowork session, tell Claude the folder path) and Claude")
    print("will handle sentence segmentation, translation, clip-cutting, and building the app.")


if __name__ == "__main__":
    main()
