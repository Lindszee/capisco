#!/usr/bin/env python3
"""
Runs in the Cowork sandbox (no network needed). Takes the transcript.json
produced by process_episode.py (run on the user's Mac) and groups the
word-level timestamps into 25-45 word sentence-ish study cards, then buckets
those cards into ~5-minute blocks.

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


def clean_join(words):
    text = "".join(w["word"] for w in words)
    return text.strip()


def make_cards(words, min_words, max_words, min_leftover=8):
    cards = []
    group = []
    i = 0
    n = len(words)
    while i < n:
        group.append(words[i])
        w = words[i]["word"].strip()
        ends_sentence = bool(TERMINAL_PUNCT.search(w))
        if len(group) >= min_words and ends_sentence:
            cards.append(finalize(group))
            group = []
        elif len(group) >= max_words:
            # look back for the most recent terminal-punctuation word to split cleanly
            split_at = None
            for j in range(len(group) - 1, max(0, len(group) - 1 - (max_words - min_words)), -1):
                if TERMINAL_PUNCT.search(group[j]["word"].strip()):
                    split_at = j
                    break
            if split_at is not None and split_at >= min_words - 1:
                cards.append(finalize(group[:split_at + 1]))
                group = group[split_at + 1:]
            else:
                # no clean break found — hard cut at max_words
                cards.append(finalize(group))
                group = []
        i += 1
    if group:
        if len(group) >= min_leftover or not cards:
            cards.append(finalize(group))
        else:
            # merge tiny leftover into previous card
            prev_words = group  # just extend previous card's end time + text
            if cards:
                cards[-1]["italian"] += " " + clean_join(group)
                cards[-1]["end"] = group[-1]["end"]
    return cards


def finalize(group):
    return {
        "italian": clean_join(group),
        "start": round(group[0]["start"], 2),
        "end": round(group[-1]["end"], 2),
        "wordCount": len(group),
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

    words = transcript.get("words")
    if not words:
        raise SystemExit("transcript.json has no word-level timestamps — re-run process_episode.py (it now requests them).")

    cards = make_cards(words, args.min_words, args.max_words)
    blocks = bucket_into_blocks(cards, args.block_seconds)

    for block in blocks:
        for i, c in enumerate(block["cards"]):
            c["id"] = f"card-{i+1}"
            c["english"] = ""
            del c["wordCount"]

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
