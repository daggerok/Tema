# Offline fixtures

`tema-holdings-2026-09-29.csv` is a three-row excerpt from Tema's public VOLT daily holdings CSV, resolved from the official page at `https://temaetfs.com/volt` on 2026-10-01. The source CSV was dated 2026-09-29 and served from `https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv` (the live page adds changing cache-buster parameters). The excerpt is committed only for deterministic offline parser tests; tests do not make network requests.

`tema-volt-page-2026-09-29.html` preserves a small, relevant HTML excerpt from the same official VOLT fund page snapshot. It covers public fund-detail and price labels used by `parseTemaFundPage`; it is a parser fixture, not a complete page or an independent source. The snapshot's `As of September 29, 2026` values were manually checked against the live page on 2026-10-01.
