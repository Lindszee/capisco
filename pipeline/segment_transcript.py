#!/usr/bin/env python3
"""
Runs in the Cowork sandbox (no network needed). Takes the transcript.json
produced by process_episode.py (run on the user's Mac) and groups Whisper's
segment-level text into study cards targeting 30-40 seconds of AUDIO
DURATION each, then buckets those cards into ~5-minute blocks.

Cards are sized by duration, not word count: fast, punchy dialogue
(sitcoms, arguments, banter) packs a lot of words into very few seconds, so
a word-count target produces cards that are far too short to comfortably
listen to. Duration is what actually matters for a "listen to a card" study
flow.

Note: text is reconstructed from "segments", not "words" — Whisper's
word-level tokens come back space-less and with contractions split apart
(e.g. "C'era" -> "C" + "era"), so they're only useful for precise timing,
not for readable text. Segment text is clean and properly spaced/punctuated.

Output: draft.json — cards with Italian text + timestamps, "english": ""
placeholders to be filled in afterwards (by Claude, reading the transcript
for context and writing natural translations).

Usage:
    python3 segment_transcript.py <transcript.json> <output draft.json> \\
        --min-duration 20 --ideal-min 30 --ideal-max 40 --max-duration 55 \\
        --block-seconds 300
"""

import argparse
import json
import re

TERMINAL_PUNCT = re.compile(r'[.!?…»"”]+$')


def join_text(segs):
    return " ".join(s["text"].strip() for s in segs if s["text"].strip()).strip()


def make_cards(segments, min_duration, ideal_min, ideal_max, max_duration, min_leftover_duration=None):
    if min_leftover_duration is None:
        # A trailing leftover shorter than the hard floor always merges into
        # the previous card, rather than standing alone as a too-short card
        # (this only affects the very last group at the end of the episode).
        min_leftover_duration = min_duration
    cards = []
    group = []
    for seg in segments:
        if not seg["text"].strip():
            continue
        group.append(seg)
        dur = group[-1]["end"] - group[0]["start"]
        ends_sentence = TERMINAL_PUNCT.search(seg["text"].strip()) is not None

        if dur >= max_duration:
            # Hard ceiling reached — handle this FIRST, before the looser
            # "ends_sentence" rules below. Otherwise a group that overshot
            # max_duration because it found no terminal punctuation for a
            # long stretch gets taken whole the moment it finally hits one
            # (dur >= ideal_max and ends_sentence would match unconditionally,
            # regardless of how far past max_duration dur has drifted).
            # Forced cut: look back within the group for the latest point
            # that both clears min_duration and ends on terminal punctuation.
            split_at = None
            # Fallback for dense, punctuation-poor dialogue (fast banter,
            # overlapping lines) where no clean sentence break clears the
            # floor: the latest point that's still within [min_duration,
            # max_duration), regardless of punctuation. Without this,
            # max_duration isn't actually a hard ceiling — a run with no
            # terminal punctuation just grows unboundedly (seen on I Soliti
            # Ignoti: 50-65s cards despite --max-duration 55).
            fallback_at = None
            running = []
            for idx, s in enumerate(group):
                running.append(s)
                rdur = running[-1]["end"] - running[0]["start"]
                # Both candidates must land BELOW max_duration — a split
                # point has to actually be short of the ceiling, not just
                # be the segment that happened to cross it (that segment
                # ending on a period doesn't make the whole overlong group
                # a valid "sentence break" cut).
                if min_duration <= rdur < max_duration:
                    if TERMINAL_PUNCT.search(s["text"].strip()):
                        split_at = idx
                    fallback_at = idx
            if split_at is None:
                split_at = fallback_at
            if split_at is not None:
                good_group = group[:split_at + 1]
                cards.append(finalize(good_group))
                group = group[split_at + 1:]
            else:
                # no point even clears min_duration — hard cut here
                cards.append(finalize(group))
                group = []
        elif ideal_min <= dur < ideal_max and ends_sentence:
            # In the ideal window and landed on a clean sentence break —
            # good cut point. Take it now rather than waiting, so cards
            # land close to the ideal range instead of drifting toward
            # max_duration by default.
            cards.append(finalize(group))
            group = []
        elif dur >= ideal_max and ends_sentence:
            cards.append(finalize(group))
            group = []
    if group:
        dur = group[-1]["end"] - group[0]["start"]
        if dur >= min_leftover_duration or not cards:
            cards.append(finalize(group))
        else:
            # merge tiny leftover into the previous card
            if cards:
                text = join_text(group)
                cards[-1]["italian"] = (cards[-1]["italian"] + " " + text).strip()
                cards[-1]["end"] = group[-1]["end"]
    return cards


def finalize(group):
    return {
        "italian": join_text(group),
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
    p.add_argument("--min-duration", type=float, default=20.0,
                    help="Hard floor (seconds) — don't force-cut below this")
    p.add_argument("--ideal-min", type=float, default=30.0,
                    help="Start accepting a sentence-break cut once a card reaches this length (seconds)")
    p.add_argument("--ideal-max", type=float, default=40.0,
                    help="Cut at the next sentence break once a card reaches this length (seconds)")
    p.add_argument("--max-duration", type=float, default=55.0,
                    help="Hard ceiling (seconds) — force a cut even without a clean sentence break")
    p.add_argument("--block-seconds", type=int, default=300)
    args = p.parse_args()

    with open(args.transcript_path, encoding="utf-8") as f:
        transcript = json.load(f)

    segments = transcript.get("segments")
    if not segments:
        raise SystemExit("transcript.json has no segments — re-run process_episode.py.")

    cards = make_cards(segments, args.min_duration, args.ideal_min, args.ideal_max, args.max_duration)
    blocks = bucket_into_blocks(cards, args.block_seconds)

    for block in blocks:
        for i, c in enumerate(block["cards"]):
            c["id"] = f"card-{i+1}"
            c["english"] = ""

    with open(args.draft_path, "w", encoding="utf-8") as f:
        json.dump({"blocks": blocks}, f, ensure_ascii=False, indent=2)

    total_cards = sum(len(b["cards"]) for b in blocks)
    print(f"✓ {len(blocks)} blocks, {total_cards} cards → {args.draft_path}")
    print("  Duration distribution (seconds):")
    durs = [c["end"] - c["start"] for b in blocks for c in b["cards"]]
    if durs:
        print(f"  min={min(durs):.1f} max={max(durs):.1f} avg={sum(durs)/len(durs):.1f}")


if __name__ == "__main__":
    main()
