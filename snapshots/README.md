# Lawro weekly snapshots

Tamper-evident weekly records of the Prediction League ("Lawro"): every player's
predictions, the actual results, points earned, and the season leaderboard as of
that gameweek.

## Why

So it's provable the season was played straight and the scores weren't changed
after the fact. The credibility comes from three independent things:

1. **Results come from football-data.org** — real PL scores, not editable here.
2. **The committed JSON** is content-addressed by git history (timestamped,
   hash-chained, mirrored on GitHub) — a silent edit to an old file is detectable.
3. **The SHA-256 posted in the group chat at the time** is an independent,
   time-stamped witness. Anyone can re-hash the committed file later and check it
   still matches.

## Capturing a week

After a gameweek's results are in:

```bash
npx tsx scripts/snapshotLawro.ts --gameweek 2
```

This writes, under `snapshots/<season>/`:

- `gw-N.json` — the canonical record (this is what the hash is of),
- `gw-N.json.sha256` — its SHA-256,
- `gw-N.html` — a human-readable page of results + predictions + leaderboard.

Then:

1. **Commit** the new files.
2. **Post the SHA-256 in the group chat** the same day (the script prints it).

## Verifying later

```bash
sha256sum snapshots/<season>/gw-N.json
```

If that hash equals the one posted in the chat back then, the file is byte-for-byte
what it was — the predictions, results and leaderboard for that week are unchanged.
