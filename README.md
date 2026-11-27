[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/qsc985/png-squeeze-01-run-20261127-entry/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/qsc985/png-squeeze-01-run-20261127-entry/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze-01

Squeeze 1280×720 RGBA screenshots into the smallest lossless PNG.

## How it works

1. **Decode** the stored RGBA PNG (own decoder, all five filters, colour
   types 0/2/3/4/6 at bit depth 8).
2. **Reduce the colour type** per instance: grey (type 0) for opaque grey
   images, grey+alpha (type 4) for grey images with alpha, palette (type 3,
   most frequent colours first, with `tRNS` where any entry is transparent)
   when the image holds at most 256 colours, RGB (type 2) when opaque, RGB
   plus a `tRNS` key when every non-opaque pixel is fully transparent and
   shares one colour, and RGBA (type 6) otherwise.
3. **Choose filters** from seven strategies — fixed filter types 0, 1, 2, 3,
   4, per-row minimum-sum-of-absolute-signed-bytes, and per-row
   fewest-non-zero-bytes — screened by zlib level 6, picking the smallest.
4. **Compress** the filtered data twice and keep the smaller raw DEFLATE
   stream: once with an own optimal-parsing encoder (hash-chain LZ77 with a
   64-entry chain cap and early exit at match length 128, a three-pass
   shortest-path parse — fixed costs, then two refinement passes that rebuild
   the Huffman lengths from the parse — length-limited dynamic Huffman with
   the standard overflow fix, 1 MiB blocks, dynamic-vs-fixed per block, and
   a stored fallback), and once with the platform zlib at level 9. Both are
   Node built-ins; nothing is installed and nothing is read from the network.
   Deterministic: every choice is a function of the input bytes only,
   budgeted by fixed work counts, never by the wall clock.

## Run

Node 22, built-ins only, no install, no network:

```
node main.ts
```

Reads `/input/<id>/image.png` for `i001`..`i008`, writes
`/output/<id>/image.png`. `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`
override the directories for local runs.

## Practice-set result

Score **708,809** on the practice set (mean 708.8 per instance), all 8
outputs pixel-exact, deterministic (two runs byte-identical), ~31 s for the
whole set. House baseline (fixed-Paeth) scores 420,399 on the same set.

| instance | bytes | points | encoder |
|----------|------:|-------:|---------|
| i001 | 12,496 | 718.4 | zlib-9 |
| i002 | 51,852 | 705.5 | zlib-9 |
| i003 | 102,801 | 698.1 | own |
| i004 | 107,794 | 683.1 | own |
| i005 | 16,552 | 742.3 | zlib-9 |
| i006 | 173,942 | 707.5 | own |
| i007 | 60,935 | 701.4 | zlib-9 |
| i008 | 24,897 | 714.2 | zlib-9 |
