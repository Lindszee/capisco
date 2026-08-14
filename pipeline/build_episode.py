#!/usr/bin/env python3
"""
Runs in the Cowork sandbox (no network needed; uses ffmpeg only).

Takes a finished draft.json (blocks/cards with "italian" AND "english" filled
in — Claude fills in the English by hand after segment_transcript.py runs)
plus the original audio.mp3, cuts one audio clip per card, and writes:
  - audio/<show>/<episode>/<block>/<card>.mp3
  - data/<show>/<episode>.json
  - registers the show in data/shows.json (if new)
  - registers the episode in data/<show>/episodes.json (if new)

Usage:
    python3 build_episode.py <draft.json> <audio.mp3> \\
        --app-root /root/italian-app \\
        --show non-ho-mai --show-title "Non Ho Mai" --show-color "#8B80F0" \\
        --episode ep1 --episode-title "Episode 1" --source-url "https://youtu.be/..."
"""

import argparse
import json
import os
import subprocess

PAD_BEFORE = 0.15
PAD_AFTER = 0.25


def cut_clip(audio_path, start, end, dest_path, duration):
    s = max(0, start - PAD_BEFORE)
    e = min(duration, end + PAD_AFTER)
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{s:.2f}", "-to", f"{e:.2f}", "-i", audio_path,
         "-ar", "44100", "-b:a", "128k", dest_path],
        capture_output=True, check=False
    )


def get_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True
    )
    return float(out.stdout.strip())


def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("draft_path")
    p.add_argument("audio_path")
    p.add_argument("--app-root", required=True)
    p.add_argument("--show", required=True)
    p.add_argument("--show-title", required=True)
    p.add_argument("--show-color", default="#5B4FE9")
    p.add_argument("--episode", required=True)
    p.add_argument("--episode-title", required=True)
    p.add_argument("--source-url", default="")
    args = p.parse_args()

    with open(args.draft_path, encoding="utf-8") as f:
        draft = json.load(f)

    duration = get_duration(args.audio_path)
    missing_english = 0

    for block in draft["blocks"]:
        for card in block["cards"]:
            if not card.get("english", "").strip():
                missing_english += 1
            dest = os.path.join(
                args.app_root, "audio", args.show, args.episode, block["id"], f"{card['id']}.mp3"
            )
            cut_clip(args.audio_path, card["start"], card["end"], dest, duration)
            card["audio"] = f"audio/{args.show}/{args.episode}/{block['id']}/{card['id']}.mp3"

    if missing_english:
        print(f"⚠ {missing_english} card(s) have no English translation yet — fill in draft.json's \"english\" fields before running this, or re-run after.")

    episode_json = {
        "id": args.episode,
        "title": args.episode_title,
        "sourceUrl": args.source_url,
        "blocks": draft["blocks"],
    }
    ep_path = os.path.join(args.app_root, "data", args.show, f"{args.episode}.json")
    save_json(ep_path, episode_json)

    # register show
    shows_path = os.path.join(args.app_root, "data", "shows.json")
    shows = load_json(shows_path, [])
    if not any(s["id"] == args.show for s in shows):
        shows.append({"id": args.show, "title": args.show_title, "color": args.show_color})
        save_json(shows_path, shows)

    # register episode
    eps_path = os.path.join(args.app_root, "data", args.show, "episodes.json")
    eps = load_json(eps_path, [])
    if not any(e["id"] == args.episode for e in eps):
        eps.append({"id": args.episode, "title": args.episode_title})
        save_json(eps_path, eps)

    total_cards = sum(len(b["cards"]) for b in draft["blocks"])
    print(f"✓ Built {args.show}/{args.episode}: {len(draft['blocks'])} blocks, {total_cards} cards")
    print(f"  {ep_path}")


if __name__ == "__main__":
    main()
