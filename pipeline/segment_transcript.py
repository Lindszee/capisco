#!/usr/bin/env python3
"""
Runs in the Cowork sandbox (no network needed). Takes the transcript.json
produced by process_episode.py (run on the user's Mac) and groups Whisper's
segment-level text into 25-45 word sentence-ish study cards, then buckets
those cards into ~5-minute blocks.

Note: text is reconstructed from "segments", not "words" — Whisper's
word-level tokens come back space-less and with contractions split apart
(e.g. "C'era" -> "C" + "era"), so they're only useful for precise timing,
not for readable text. Segment text is clean and properly spaced/punctuated.

Output: draft.json — cards with Italian text + timestamps, "english": ""
placeholders to be filled in afterwards (by Claude, reading the transcript
for context and writing natural translations).

Usage:
    python3 segment_transcript.py <transcript.json> <output draft.json> \\
        --min-words 25 --max-words 45 --block-seconds 300
"""

import argparse
import json
import re

TERMINAL_PUNCT = re.compile(r'[.!?…»"”]+$')


def join_text(segs):
    return " ".join(s["text"].strip() for s in segs if s["text"].strip()).strip()


def make_cards(segments, min_words, max_words, min_leftover=8):
    cards = []
    group = []
    for seg in segments:
        if not seg["text"].strip():
            continue
        group.append(seg)
        text = join_text(group)
        word_count = len(text.split())
        ends_sentence = bool(TERMINAL_PUNCT.search(text))
        if word_count >= min_words and ends_sentence:
            cards.append(finalize(group, text))
            group = []
        elif word_count >= max_words:
            # look back within the group for the latest point that both hits
            # min_words and ends on terminal punctuation, for a clean split
            split_at = None
            running = []
            for idx, s in enumerate(group):
                running.append(s)
                rtext = join_text(running)
                if len(rtext.split()) >= min_words and TERMINAL_PUNCT.search(rtext):
                    split_at = idx
            if split_at is not None:
                good_group = group[:split_at + 1]
                cards.append(finalize(good_group, join_text(good_group)))
                group = group[split_at + 1:]
            else:
                # no clean sentence break found — hard cut here
                cards.append(finalize(group, text))
                group = []
    if group:
        text = join_text(group)
        word_count = len(text.split())
        if word_count >= min_leftover or not cards:
            cards.append(finalize(group, text))
        else:
            # merge tiny leftover into the previous card
            if cards:
                cards[-1]["italian"] = (cards[-1]["italian"] + " " + text).strip()
                cards[-1]["end"] = group[-1]["end"]
    return cards


def finalize(group, text):
    return {
        "italian": text,
        "start": round(group[0]["start"], 2),
        "end": round(group[-1]["end"], 2),
    }


def bucket_into_blocks(cards, block_seconds):
    blocks = {}
    for c in cards:
        idx = int(c["start"] // block_seconds)
        blocks.setdefault(idx, []).append(c)
    out = []
    for idx in sorted(blocks.keys()):
        block_cards = blocks[idx]
        lo = idx * block_seconds
        hi = lo + block_seconds
        out.append({
            "id": f"block-{idx+1}",
            "label": f"{fmt(lo)}–{fmt(hi)}",
            "cards": block_cards,
        })
    return out


def fmt(seconds):
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("transcript_path")
    p.add_argument("draft_path")
    p.add_argument("--min-words", type=int, default=25)
    p.add_argument("--max-words", type=int, default=45)
    p.add_argument("--block-seconds", type=int, default=300)
    args = p.parse_args()

    with open(args.transcript_path, encoding="utf-8") as f:
        transcript = json.load(f)

    segments = transcript.get("segments")
    if not segments:
        raise SystemExit("transcript.json has no segments — re-run process_episode.py.")

    cards = make_cards(segments, args.min_words, args.max_words)
    blocks = bucket_into_blocks(cards, args.block_seconds)

    for block in blocks:
        for i, c in enumerate(block["cards"]):
            c["id"] = f"card-{i+1}"
            c["english"] = ""

    with open(args.draft_path, "w", encoding="utf-8") as f:
        json.dump({"blocks": blocks}, f, ensure_ascii=False, indent=2)

    total_cards = sum(len(b["cards"]) for b in blocks)
    print(f"✓ {len(blocks)} blocks, {total_cards} cards → {args.draft_path}")
    print("  Word count distribution:")
    counts = [len(c["italian"].split()) for b in blocks for c in b["cards"]]
    if counts:
        print(f"  min={min(counts)} max={max(counts)} avg={sum(counts)/len(counts):.1f}")


if __name__ == "__main__":
    main()
