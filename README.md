[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/qsc985/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/qsc985/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze-01

Squeeze 1280×720 RGBA screenshots into the smallest lossless PNG.

## How it works

1. **Decode** the stored RGBA PNG (own decoder, all five filters).
2. **Reduce the colour type** per instance: palette (type 3) when the image has
   at most 256 colours, grey (type 0) for grey images, RGB (type 2) otherwise,
   RGBA (type 6) when the alpha channel is needed; a `tRNS` key replaces the
   alpha channel when every non-opaque pixel is fully transparent and shares
   one colour value.
3. **Choose filters per row** from a small set of strategies — fixed filter
   types 0, 1, 2, 4, per-row minimum-sum-of-absolute-signed-bytes, and
   per-row fewest-distinct-byte-pairs — screened by zlib level 6, picking the
   smallest total (zlib bytes plus PLTE/tRNS chunk overhead).
4. **Compress** the filtered data with an own optimal-parsing DEFLATE
   (hash-chain LZ77, shortest-path parse, dynamic Huffman, in the manner of
   zopfli): 200 KB blocks, chain cap 32, early exit at match length 128, one
   refinement pass that tries every match length so a match can end exactly
   where the next good match starts. Block type (dynamic vs fixed) is chosen
   by estimated cost. Deterministic: every choice is a function of the input
   bytes only, budgeted by fixed work counts, never by the wall clock.

## Run

Node 22, built-ins only, no install, no network:

```
node main.ts
```

Reads `/input/<id>/image.png` for `i001`..`i008`, writes
`/output/<id>/image.png`. `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
override the directories for local runs.

## Practice-set result

Score **700,426** on the practice set (mean 700.4 per instance), all 8
outputs pixel-exact, deterministic (two runs byte-identical), ~30 s for the
whole set. House baseline (fixed-Paeth) scores 420,399 on the same set.

| instance | bytes | points |
|----------|------:|-------:|
| i001 | 12,653 | 710.6 |
| i002 | 51,967 | 704.1 |
| i003 | 102,229 | 701.7 |
| i004 | 107,559 | 684.5 |
| i005 | 17,676 | 702.1 |
| i006 | 175,243 | 702.8 |
| i007 | 61,700 | 693.5 |
| i008 | 25,305 | 704.0 |
