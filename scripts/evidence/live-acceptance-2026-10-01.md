# Tema live acceptance — 2026-10-01

## Scope and isolation

- Repository/branch: `daggerok/Tema`, `feat/tema-etfs`.
- Updater revision: `ebb79cf1763e62e93bd701af7367d252728b2a12` (`feat(cli): implement Tema data updater`).
- Both real network runs completed during the 2026-10-01 session; the output/log/hash manifest was re-read by `2026-10-01T05:48:47Z`. The first updater command took 8.248 seconds and the second took 7.198 seconds.
- The isolated copy was `/tmp/tema-live-acceptance-20261001`; `scripts/update-data.ts`, `package.json`, and `bun.lock` were copied from the revision above. The output directory began empty.
- **Seed deviation:** `main` at `01b4559177ceaf4095961726f603aada00362e19` contains no `api/tema` seed, so there was no published Tema API to copy. The run therefore began with an empty isolated API directory. The index retained all 14 currently listed catalog rows; only the requested tickers received per-fund files. The baseline did not provide existing unrequested index rows/files against which to test preservation.
- No PAT, authorization header, cookie, or secret was used in the updater command or saved in this evidence.

## Exact command, used twice

```sh
TICKERS='VOLT WELD PRVT' VERBOSE=1 MAX_FETCHES=0 REQUEST_SLEEP=1 CONCURRENCY=2 MAX_RETRIES=2 HISTORY_RANGE=max EDGAR_FALLBACK=true SKIP_YAHOO=false OUTPUT_DIR="/tmp/tema-live-acceptance-20261001/api/tema" SEC_UA='Tema ETF updater research@example.com' PATH="/tmp/tema-bun/bin:$PATH" bun scripts/update-data.ts
```

The command ran from the isolated copy. It used normal one-second request pacing, two provider lanes, two retries, Yahoo enabled, and SEC fallback enabled. Effective config printed by the updater is preserved in both logs below.

## Results

| Ticker | Holdings | Holdings source/as-of | Yahoo history | Dividend events observed | Notes |
|---|---:|---|---:|---:|---|
| VOLT | 27 | Tema daily CSV, 2026-09-29 | 455 rows, latest 2026-09-30 | 2 | Official page and CSV succeeded. |
| WELD | 23 | Tema daily CSV, 2026-09-29 | 850 rows, latest 2026-09-30 | 3 | Official WELD page and CSV succeeded. |
| PRVT | 30 | SEC N-PORT-P report, 2026-05-31 | 9 rows, latest 2026-09-02 | 0 | `/prvt` returned a page without ticker metadata or CSV; SEC fallback matched series `S000078303`, accession `0001193125-26-323013`. Yahoo's latest observed PRVT history point was September 2, not a current quote. The zero observed Yahoo dividend events are not evidence that the fund never distributes. |

- Run 1: exit 0; 3 selected, 3 updated, 0 skipped, 0 failures; index counts were 14 funds, 80 holdings rows and 1,314 history rows.
- Run 2: same command and settings; exit 0; 3 selected, 3 processed, 0 skipped, 0 failures. All three per-fund output lines said `unchanged`.
- The index kept all 14 current catalog tickers. In the empty initial output there were only requested per-fund directories for `PRVT`, `VOLT`, and `WELD`; no unrequested holdings/history/meta files were created.
- `MAX_FETCHES=0` completed a full selected-ticker pass and left no `update-state.json` cursor.
- Hash comparison: all 10 static API files from run 1 and run 2 had identical SHA-256 values; no timestamp-only churn occurred.

## Run 1 stdout

```text
[ config   ] Tema ETFs updater:
              MAX_FETCHES=0
              REQUEST_SLEEP=1
              CONCURRENCY=2
              AUM=:
              CATEGORY=all
              DIVIDEND_YIELD=:
              EDGAR_FALLBACK=true
              HISTORY_PAGE_SIZE=1000
              HISTORY_RANGE=max
              HOLDINGS_PAGE_SIZE=250
              MAX_RETRIES=2
              OUTPUT_DIR=/tmp/tema-live-acceptance-20261001/api/tema
              PERFORMANCE_10Y=:
              PERFORMANCE_1Y=:
              PERFORMANCE_3Y=:
              PERFORMANCE_5Y=:
              PERFORMANCE_YTD=:
              SEC_UA=Tema ETF updater research@example.com
              SEC_YIELD=:
              SKIP_YAHOO=false
              TER=:
              TICKERS=VOLT,WELD,PRVT
              TOTAL_RETURN_10Y=:
              TOTAL_RETURN_1Y=:
              TOTAL_RETURN_3Y=:
              TOTAL_RETURN_5Y=:
              TOTAL_RETURN_YTD=:
              VERBOSE=true

[ catalog  ] 14 Tema ETFs (temaetfs.com/funds)
[ filter   ] 3 of 14 funds pass filters
[  1/3   ] VOLT  updated   history=455 holdings=27 divs=2 netAssets=$734.1M div=0.37
[ product  ] PRVT: PRVT: fund page has no Ticker field
[ holdings ] PRVT: official CSV unavailable: PRVT: no official daily holdings CSV link found on https://temaetfs.com/prvt
[  2/3   ] WELD  updated   history=850 holdings=23 divs=3 netAssets=$271.8M div=0.25
[ edgar    ] PRVT: SEC EDGAR N-PORT-P fallback (0001193125-26-323013; report 2026-05-31)
[  3/3   ] PRVT  updated   history=9 holdings=30 divs=0 netAssets=$2.3M

[ done     ] 3 funds updated, 0 skipped, 0 failures
[ done     ] counts: 14 funds / 80 holdings rows / 1,314 history rows
[ cursor   ] full pass complete (cursor reset)
```

## Run 2 stdout

```text
[ config   ] Tema ETFs updater:
              MAX_FETCHES=0
              REQUEST_SLEEP=1
              CONCURRENCY=2
              AUM=:
              CATEGORY=all
              DIVIDEND_YIELD=:
              EDGAR_FALLBACK=true
              HISTORY_PAGE_SIZE=1000
              HISTORY_RANGE=max
              HOLDINGS_PAGE_SIZE=250
              MAX_RETRIES=2
              OUTPUT_DIR=/tmp/tema-live-acceptance-20261001/api/tema
              PERFORMANCE_10Y=:
              PERFORMANCE_1Y=:
              PERFORMANCE_3Y=:
              PERFORMANCE_5Y=:
              PERFORMANCE_YTD=:
              SEC_UA=Tema ETF updater research@example.com
              SEC_YIELD=:
              SKIP_YAHOO=false
              TER=:
              TICKERS=VOLT,WELD,PRVT
              TOTAL_RETURN_10Y=:
              TOTAL_RETURN_1Y=:
              TOTAL_RETURN_3Y=:
              TOTAL_RETURN_5Y=:
              TOTAL_RETURN_YTD=:
              VERBOSE=true

[ catalog  ] 14 Tema ETFs (temaetfs.com/funds)
[ filter   ] 3 of 14 funds pass filters
[ product  ] PRVT: PRVT: fund page has no Ticker field
[ holdings ] PRVT: official CSV unavailable: PRVT: no official daily holdings CSV link found on https://temaetfs.com/prvt
[  1/3   ] VOLT  unchanged history=455 holdings=27 divs=2 netAssets=$734.1M div=0.37
[  2/3   ] WELD  unchanged history=850 holdings=23 divs=3 netAssets=$271.8M div=0.25
[ edgar    ] PRVT: SEC EDGAR N-PORT-P fallback (0001193125-26-323013; report 2026-05-31)
[  3/3   ] PRVT  unchanged history=9 holdings=30 divs=0 netAssets=$2.3M

[ done     ] 3 funds updated, 0 skipped, 0 failures
[ done     ] counts: 14 funds / 80 holdings rows / 1,314 history rows
[ cursor   ] full pass complete (cursor reset)
```

## Run 1 SHA-256 manifest (matched by run 2)

```text
b394fb0b48127ac9b354731bb6c2b2c9e732e8bc0d557eddd76a62d091da8df4  api/tema/funds/PRVT/history/001.json
8dc7fbddf2810b7d01aa17958e486dea5516ca522a38f72ee41245fe8650e8ac  api/tema/funds/PRVT/holdings/001.json
d3c6a5d9efab8b453c0dae5992116735cc4d44582ca0bfe383dbd37b27c1e11c  api/tema/funds/PRVT/meta.json
a666c488968df8af94fd37fd465d6c9f564bb1f593af1aa07b349ef631e2c027  api/tema/funds/VOLT/history/001.json
7be66dfcd314c62bc1d81c06ba9f85e039a709966d94b9608ddb8a1775cd0225  api/tema/funds/VOLT/holdings/001.json
9eb1646667ac247cfa60826d3581225a59d57b77d4a66d985b6cc86b303d32ac  api/tema/funds/VOLT/meta.json
0ed958ca29d7af243638e72b7b96602aee9a464e685abde02c395fcc52355135  api/tema/funds/WELD/history/001.json
e7be81687af530f7f478d700f61a99f5eb8e0db419126889626e2bcd496fe97e  api/tema/funds/WELD/holdings/001.json
251186badc1f26d7b977037354c81be8a7c4bdfe56e0c143926929ff95abae0b  api/tema/funds/WELD/meta.json
5b0ca2c52200d9e2c20a43cff3b9954c701c015c4b0792eae8e2cfe8788398a5  api/tema/index.json
```
