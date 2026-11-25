# drop-feed

Drip-feeds local video directories or Invidious playlists into RSS feeds on a
weekly schedule, anchored on **Monday 06:00 (America/Chicago)**.

A feed = one directory under `FEEDS_DIR` with a `config.yml`. Videos are served
as RSS `<enclosure>` items, playlist videos as links to Invidious embeds
(`tube.halfab.net/embed/<id>`). Consume via FreshRSS at
`https://rss.halfab.net/api/dropfeed/f/<slug>.xml`.

## config.yml

```yaml
title: My Course         # default: dir name                  (live)
per_week: 7              # required, integer >= 1              (re-anchor)
start: 2026-12-01        # default: when first seen            (re-anchor; past date backfills)
first: next              # next | immediate                    (re-anchor)
paused: false            #                                     (live)
shuffle: false           # false = natural order, true = random deck  (live — re-deals pending)
repeat: false            # true = new cycle when deck empties         (live)
type: dir                # dir | playlist                      (re-anchor)
playlist: <URL or ID>    # playlist feeds only                 (re-anchor)
```

- **live** — applies immediately. **re-anchor** — remaining items re-slotted
  from now (`first` applies again); released history and GUIDs untouched.
- `start` is read when the feed is first created (a past date backfills).
- Videos: subdirs OK, dotfiles skipped, natural sort (`2-` before `10-`).
  Whatever is dropped in is served as-is — no transcoding. MP4 (H.264/AAC) is
  the safe format for every player.
- Repeating feeds accumulate history; the XML serves the newest 500 items.

## Schedule

Week = Mon–Sun, slots at 06:00 unless `per_week > 7` splits days evenly from
06:00. N ≤ 7 → N days spread cyclically even (2 → Mon/Fri, 3 → Mon/Wed/Sat,
4 → Mon/Wed/Fri/Sat). N > 7 → every day gets ⌊N/7⌋ slots evenly spaced from
06:00, remainder days get one extra (10 → daily 06:00 + Mon/Wed/Sat 18:00,
14 → daily 06:00/18:00, 21 → daily 06:00/14:00/22:00).

Missed slots (app down / paused) release late with their original slot dates.
Playlist videos that are unavailable at a slot are skipped (next-available);
10+ consecutive skips fail the slot (see status page).

## State

`DATA_DIR/<slug>.json` — config snapshot, cycle, pending deck, released list,
cursor. Released items are frozen (GUID `dropfeed:<slug>:<cycle>:<id>`).
Removing a feed dir stops serving it (XML → 404); the state file is kept so a
re-created dir resumes its history. Delete the state file to start over.

## Run

    cp .env.example .env   # set RSS_DIR
    docker compose up -d --build

Tests: `npm test` (schedule table + release-loop behaviors with a fake clock).
