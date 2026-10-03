# Tema ETFs

One of the app's features lets you select Tema ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics. A single-file client-side tool that reads the generated `./api/tema` static feed (official Tema fund pages and daily holdings CSVs for current holdings; Yahoo Finance adjusted-close history for dated price and total-return estimates; SEC EDGAR N-PORT-P for holdings fallback only) into a searchable ETF/asset-class catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export - the same look, feel, columns and business logic as the sibling applications.

## Using Bun

```bash
bunx degit daggerok/Tema#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at <https://daggerok.github.io/Tema/>.

## Updating the static Tema ETFs data

Run the updater with Bun:

```bash
bun test
bun scripts/update-data.ts
```

Run `bun scripts/update-data.ts -h` (or `--help`) to print every control with its default and usage examples.

Every supported control and its default lives in [`scripts/update-data.config.json`](./scripts/update-data.config.json); the updater, the `--help` text, the table below and the workflow all use the same `resolveControls` function, so they cannot drift apart. Precedence, lowest to highest: file defaults < `advanced` JSON < nonblank workflow inputs < protected Actions variable or environment variable. A blank workflow input inherits the file value, and `advanced` can deliberately set a key to an empty string. Unknown keys, non-scalar values and values with line breaks are rejected before any request is made.

The scheduled/manual **Update Tema ETFs data** GitHub Actions workflow exposes 24 common controls as individual manual inputs plus one `advanced` input (25 in total, the GitHub limit). `advanced` takes a JSON object such as `{"SEC_YIELD": "2:", "VERBOSE": "true"}` and reaches every control that has no input of its own. Scheduled runs have no inputs, so they use the file defaults. All supplied filters use **AND** logic. The workflow takes the SEC User-Agent from the protected repository Actions variable `SEC_UA` when it is set (nonblank values win over every other layer) and otherwise uses the config default; the output directory is `api/tema` from the config file and the workflow only stages `api/tema`. Add `{"VERBOSE": "true"}` to `advanced` for per-request notices in the run log.

### Data sources

| Block | Source |
| --- | --- |
| Catalog (all 14 current Tema ETFs) | [`https://temaetfs.com/funds`](https://temaetfs.com/funds) (the official fund list) |
| Fund-page metadata | Official fund pages at `https://temaetfs.com/{ticker}`; the updater reads their published fund details and dated `Download Holdings (CSV)` links. |
| Daily holdings | The date-stamped CSV linked from each official fund page and hosted on Tema's HubSpot site; the updater discovers the current link from the page rather than hardcoding its changing date/cache-buster. |
| Holdings fallback | SEC EDGAR Form N-PORT-P for Tema ETF Trust (CIK `0001944285`), used only when official holdings are unavailable AND the filing is strictly newer than the published holdings/NAV date and belongs to the trust; an older quarterly snapshot never replaces fresher data. |
| Price history and distributions | Yahoo Finance chart API (`https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}`); adjusted close is used for date-labelled price history and total-return estimates. |

### Metrics and caveats

Return and CAGR values are Yahoo adjusted-close total-return proxies, **not official NAV total returns**. Dividend yield is derived from available Yahoo distribution history; unavailable or insufficient observations remain unknown rather than being asserted as zero. SEC-yield values are currently unavailable in the generated feed, so an active `SEC_YIELD` bound will not match funds without a value.

The published PRVT snapshot has no usable Tema ticker/details/CSV route: its holdings use SEC filing `0001193125-26-323013` (report date 2026-05-31), and its available Yahoo history ends 2026-09-02. Check each row's `asOfDate` and source fields in `api/tema/funds/<TICKER>/meta.json`; do not treat an older observation as a current quote.

Each fund carries a `metrics` object that powers the catalog columns shared with the sibling sites:

- `ytd` / `tr1y` - Yahoo adjusted-close YTD and 1-year return estimates -> *YTD Return*, *TR 1Y*
- `cagr3y` / `cagr5y` / `cagr10y` - annualized estimates when enough dated history is available -> *CAGR 3Y/5Y/10Y*
- `tr3y` / `tr5y` / `tr10y` - cumulative estimates `(1 + CAGR)^n - 1` -> *TR 3Y/5Y/10Y*
- `siAnn` - annualized estimate since the first available history row, when sufficient history is available -> *SI Ann.*
- `dividendYield` - 12-month trailing yield from observed Yahoo distributions when available
- `secYield` - reserved for a published SEC-yield value; currently unavailable in the generated feed
- `returnsBasis` - mandatory non-empty text saying how the returns are computed: here always Yahoo Finance adjusted close at the last completed month-end (an estimate, not official Tema NAV total returns)
- `performanceAsOf` - mandatory ISO `YYYY-MM-DD` date the returns are as of: the Yahoo close date of that month-end anchor (not the NAV date), `null` only when no price history exists

Unavailable return values stay `null`, never `0` (young funds have no 1-year or longer figures). `siAnn` needs at least one year of history. `dividendYieldText` and `secYieldText` carry the display text (`—` when unavailable).

Expense ratio mapping: Tema publishes one `Total Expense Ratio` and no waiver split, so `terValue` (and `expenseRatio.net`) is that number and `terGrossValue` / `expenseRatio.gross` stay `null` rather than a copy. ARMY, CANC and HRTS pages do not publish the field at all, so their TER is `null`.

Consistency and retention: a fund is either fully updated or fully kept. When the fund page, the holdings (official CSV or a newer N-PORT) or, unless `SKIP_YAHOO=true`, the Yahoo history fails and the fund already has published data, the run logs it as `skipped` and keeps the previous files untouched; no new NAV is ever published next to stale returns. A source that answers with an honest empty value (for example a page that stopped listing the TER, or a shorter `HISTORY_RANGE` with no 3-year return) produces `null`, never the old value. `SKIP_YAHOO=true` keeps returns, yields, distributions and history together with their `performanceAsOf`. A fund with no published data yet is written with whatever sources answered. Writes are atomic (temp file + rename): pages first, then `meta.json`, then stale pages are removed, and `index.json` last. The run stops taking new funds after 25 minutes and still writes the index. New catalog funds are printed as `NEW FUNDS: A, B` and appended to `$GITHUB_STEP_SUMMARY`. Every request has a 45-second timeout (headers and body) and is retried per `MAX_RETRIES`.

`index.json` rows of funds without `funds/<TICKER>/meta.json` carry `dataFile: null` and a full `metrics` object with `null` values.

### Update controls

| Control | Default | Meaning |
| --- | ---: | --- |
| `MAX_FETCHES` | `0` | Full catalog pass (the older `TEMA_LIMIT` environment name remains an alias); a positive value selects a resumable batch after the cursor in `api/tema/update-state.json`. A full pass clears the cursor. |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between outgoing request starts per provider lane, including retries. |
| `CONCURRENCY` | `2` | Independently paced provider worker lanes. |
| `MAX_RETRIES` | `2` | Retries after the initial request for network errors and HTTP 408/425/429/5xx responses; an integer of at least 1. |
| `TICKERS` | all | Space-, comma- or semicolon-separated ticker allowlist, e.g. `VOLT WELD PRVT`. |
| `CATEGORY` | all | Comma- or semicolon-separated category allowlist; the current catalog is Equity. The older `ASSET_CLASS` environment name remains an accepted alias. |
| `AUM` | `:` | USD range; bounds accept bare dollars or `K`/`M`/`B`/`T` suffixes, or presets `nano` (<$10M), `micro` ($10M-$300M), `small` ($300M-$2B), `mid` ($2B-$10B), `large` (≥$10B). |
| `TER` | `:` | Total expense ratio range in percent. |
| `DIVIDEND_YIELD` | `:` | Trailing-12-month distribution-yield range in percent. |
| `SEC_YIELD` | `:` | SEC-yield range in percent; unavailable values do not match an active bound. |
| `PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}` | `:` | Independent `MIN:MAX` ranges for the named performance periods; returns depend on available history and are Yahoo-derived estimates. |
| `TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}` | `:` | Independent `MIN:MAX` ranges for cumulative total-return estimates. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated history JSON page. |
| `HISTORY_RANGE` | `max` | Maximum history or a bounded window such as `10y`. |
| `EDGAR_FALLBACK` | `true` | Use SEC N-PORT-P holdings when Tema CSV/page holdings are unavailable. |
| `SKIP_YAHOO` | `false` | When true, skip Yahoo history updates and retain previously published history. |
| `SEC_UA` | `daggerok ETF feed daggerok@gmail.com` | SEC User-Agent with a contact address; redacted in config logs. The protected repository Actions variable `SEC_UA` overrides it in the workflow. |
| `VERBOSE` | `false` | Show per-request/per-fund retry and fallback notices. |
| `USE_SYSTEM_CA` | `auto` | TLS trust store: `auto` restarts the updater once with Bun's `--use-system-ca` when a request fails with an untrusted-certificate error; `true` always uses the system CA store; `false` never restarts. Not an individual workflow input: use `advanced`, the config file or the CLI environment. |

Range syntax is inclusive `MIN:MAX`; either side may be empty, and `:` disables that filter. `TICKERS`, `CATEGORY`, AUM, TER, yield and return filters combine with **AND** logic. Funds not selected for a successful update retain their prior published metadata and data files, and `index.json` always lists every fund that has a `meta.json`. A `TICKERS` entry that is not in the catalog is an error, and a `TICKERS` run never touches the `MAX_FETCHES` cursor state. The CLI exits non-zero when every selected fund failed.

The output directory is fixed at `api/tema` (not a control, never an input). The workflow inputs are the lowercase names of the controls above (for example `max_fetches`, `performance_1y`); only `SEC_YIELD`, `SEC_UA`, `VERBOSE` and `USE_SYSTEM_CA` have no individual input. The `SEC_YIELD` bound can be set through `advanced`.

### Examples

```bash
MAX_FETCHES=5 bun scripts/update-data.ts
TICKERS="VOLT WELD PRVT" bun scripts/update-data.ts
AUM="1B:" TER=":0.5" bun scripts/update-data.ts
PERFORMANCE_1Y="15:" HISTORY_RANGE=10y bun scripts/update-data.ts
```

## TypeScript and verification

The browser app is intentionally build-free: `index.html` carries the markup, styles and bootstrap, and `app.tsx` is TypeScript compiled in the browser with Babel standalone - no build step, no bundler, no `tsconfig.json` needed. Bun runs TypeScript out of the box.

Verification before every publish: `bun install --frozen-lockfile`, `bun test`, `bun build --target=bun scripts/update-data.ts --outfile=/dev/null`, and `git diff --check`. The README, config file, `--help` text and workflow are kept in sync by `bun test`.

## Brands table

| Brand | Where to get the data |
| --- | --- |
| **AAM** | [aamlive.com](https://www.aamlive.com/ETF) \| [AAM](https://daggerok.github.io/AAM/) |
| **abrdn (Aberdeen)** | [aberdeeninvestments.com](https://www.aberdeeninvestments.com/en-us/investor/funds/etfs) \| [aberdeen](https://daggerok.github.io/aberdeen/) |
| **Amplify** | [amplifyetfs.com](https://amplifyetfs.com/) \| [Amplify](https://daggerok.github.io/Amplify/) |
| **ARK Invest** | [ark-funds.com](https://www.ark-funds.com/our-etfs/) \| [ARK](https://daggerok.github.io/ARK/) |
| **Capital Group** | [capitalgroup.com](https://www.capitalgroup.com/advisor/investments/exchange-traded-funds.html) \| [Capital-Group](https://daggerok.github.io/Capital-Group/) |
| **Fidelity** | [fidelity.com](https://www.fidelity.com/etfs) \| [Fidelity](https://daggerok.github.io/Fidelity/) |
| **First Trust** | [ftportfolios.com](https://www.ftportfolios.com/Retail/etf/etflist.aspx) \| [First-Trust](https://daggerok.github.io/First-Trust/) |
| **Franklin Templeton** | [franklintempleton.com](https://www.franklintempleton.com/investments/options/exchange-traded-funds) \| [Franklin](https://daggerok.github.io/Franklin/) |
| **Global X** | [globalxetfs.com/explore](https://www.globalxetfs.com/explore) \| [Global-X](https://daggerok.github.io/Global-X/) |
| **Goldman Sachs** | [am.gs.com](https://am.gs.com/en-us/individual/funds?locale=en-us&audience=individual&sf=funds&filters=funds%7CETF&limit=100) \| [Goldman-Sachs](https://daggerok.github.io/Goldman-Sachs/) |
| **Invesco** | [invesco.com](https://www.invesco.com/us/en/financial-products/etfs.html) \| [Invesco](https://daggerok.github.io/Invesco/) |
| **iShares** | [ishares.com](https://www.ishares.com/) \| [iShares](https://daggerok.github.io/iShares/) |
| **JPMorgan** | [am.jpmorgan.com](https://am.jpmorgan.com/us/en/asset-management/adv/products/fund-explorer/etf) \| [JPMorgan](https://daggerok.github.io/JPMorgan/) |
| **NEOS** | [neosfunds.com](https://neosfunds.com/#explore-etfs) \| [Neos](https://daggerok.github.io/Neos/) |
| **Northern Trust** | [etfs.ntam.northerntrust.com](https://etfs.ntam.northerntrust.com/us/en/individual/funds) \| [Northern-Trust](https://daggerok.github.io/Northern-Trust/) |
| **Pacer ETFs** | [paceretfs.com](https://www.paceretfs.com/products/) \| [Pacer](https://daggerok.github.io/Pacer/) |
| **Parametric** | [eatonvance.com](https://www.eatonvance.com/products/etfs.html) \| [Parametric](https://daggerok.github.io/Parametric/) |
| **ProShares** | [proshares.com](https://www.proshares.com/our-etfs/find-proshares-etfs) \| [ProShares](https://daggerok.github.io/ProShares/) |
| **Schwab** | [schwabassetmanagement.com](https://www.schwabassetmanagement.com/products) \| [Schwab](https://daggerok.github.io/Schwab/) |
| **SP Funds** | [sp-funds.com](https://www.sp-funds.com/) \| [SP-Funds](https://daggerok.github.io/SP-Funds/) |
| **SPDR** | [ssga.com](https://www.ssga.com/us/en/intermediary/etfs/fund-finder) \| [SPDR](https://daggerok.github.io/SPDR/) |
| **Sprott ETFs** | [sprottetfs.com](https://sprottetfs.com/) \| [Sprott](https://daggerok.github.io/Sprott/) |
| **Tema ETFs** | [temaetfs.com](https://temaetfs.com/funds) \| [Tema](https://daggerok.github.io/Tema/) |
| **Themes ETFs** | [themesetfs.com/etfs](https://themesetfs.com/etfs) \| [Themes](https://daggerok.github.io/Themes/) |
| **VanEck** | [vaneck.com](https://www.vaneck.com/us/en/etf-mutual-fund-finder/) \| [VanEck](https://daggerok.github.io/VanEck/) |
| **Vanguard** | [investor.vanguard.com](https://investor.vanguard.com/etf/list) \| [Vanguard](https://daggerok.github.io/Vanguard/) |
| **VictoryShares** | [vcm.com VictoryShares ETFs](https://www.vcm.com/products/victoryshares-etfs/victoryshares-etfs-list) \| [VictoryShares](https://daggerok.github.io/VictoryShares/) |
| **WisdomTree** | [wisdomtree.com](https://www.wisdomtree.com/investments) \| [WisdomTree](https://daggerok.github.io/WisdomTree/) |
| **Xtrackers** | [etf.dws.com](https://etf.dws.com/en-us/etf-products/) \| [Xtrackers](https://daggerok.github.io/Xtrackers/) |

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| AAM | Official AAM catalog/detail HTML + full holdings XLS + SEC N-PORT holdings fallback + Yahoo market history/dividends | [AAM](https://github.com/daggerok/AAM) |
| abrdn (Aberdeen) | Official Aberdeen gateway + SEC N-PORT holdings fallback + Yahoo history/dividends | [aberdeen](https://github.com/daggerok/aberdeen) |
| Amplify | Amplify ETFs Firestore data feed + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Amplify](https://github.com/daggerok/Amplify) |
| ARK Invest | ark-funds.com fund pages + overview/NAV-history/performance JSON + official daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance distributions/history fallback | [ARK](https://github.com/daggerok/ARK) |
| Capital Group | Official Capital Group fund data + SEC N-PORT holdings fallback + Yahoo history fallback | [Capital-Group](https://github.com/daggerok/Capital-Group) |
| Fidelity | SEC EDGAR N-PORT-P + Yahoo Finance | [Fidelity](https://github.com/daggerok/Fidelity) |
| First Trust | ftportfolios.com official ETF list + fund summary, holdings, distribution and price-history export pages + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history fallback | [First-Trust](https://github.com/daggerok/First-Trust) |
| Franklin Templeton | franklintempleton.com ETF listings + product pages + SEC EDGAR N-PORT-P | [Franklin](https://github.com/daggerok/Franklin) |
| Global X | globalxetfs.com Next.js catalog and fund pages + dated full-holdings CSV | [Global-X](https://github.com/daggerok/Global-X) |
| Goldman Sachs | am.gs.com fund finder + detail pages + SEC EDGAR N-PORT-P | [Goldman-Sachs](https://github.com/daggerok/Goldman-Sachs) |
| Invesco | invesco.com fund pages and sitemap + official Invesco fund API (monthly returns, NAV, AUM, yields, daily holdings, expense ratio) + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [Invesco](https://github.com/daggerok/Invesco) |
| iShares | iShares (BlackRock) product workbooks | [iShares](https://github.com/daggerok/iShares) |
| JPMorgan | am.jpmorgan.com fund explorer + product-data JSON | [JPMorgan](https://github.com/daggerok/JPMorgan) |
| NEOS | neosfunds.com lineup table + official fund pages + daily holdings CSV | [Neos](https://github.com/daggerok/Neos) |
| Northern Trust | etfs.ntam.northerntrust.com funds list + per-fund CSV/JSON downloads | [Northern-Trust](https://github.com/daggerok/Northern-Trust) |
| Pacer ETFs | paceretfs.com product catalog and fund pages (Cloudflare WAF; r.jina.ai proxy fallback) + SEC EDGAR N-PORT-P (Pacer Funds Trust) + Yahoo Finance history/dividends | [Pacer](https://github.com/daggerok/Pacer) |
| Parametric | eatonvance.com ETF catalog and Parametric product pages + SEC EDGAR N-PORT-P holdings + Yahoo Finance history/dividends | [Parametric](https://github.com/daggerok/Parametric) |
| ProShares | proshares.com ETF finder + fund pages + official data host | [ProShares](https://github.com/daggerok/ProShares) |
| Schwab | schwabassetmanagement.com product pages + CSV exports | [Schwab](https://github.com/daggerok/Schwab) |
| SP Funds | sp-funds.com homepage catalog, fund pages and daily holdings CSV + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance history/dividends | [SP-Funds](https://github.com/daggerok/SP-Funds) |
| SPDR | SSGA / State Street public feeds | [SPDR](https://github.com/daggerok/SPDR) |
| Sprott ETFs | sprottetfs.com fund pages + SEC EDGAR N-PORT-P (Sprott Funds Trust) + Yahoo Finance history/dividends | [Sprott](https://github.com/daggerok/Sprott) |
| Tema ETFs | Tema official fund pages + dated daily holdings CSV; SEC EDGAR N-PORT-P holdings fallback only + Yahoo Finance price/history/dividend fallback | [Tema](https://github.com/daggerok/Tema) |
| Themes ETFs | themesetfs.com catalog + daily holdings CSV + Yahoo Finance history/dividends + SEC N-PORT-P holdings fallback | [Themes](https://github.com/daggerok/Themes) |
| VanEck | vaneck.com ETF finder + product pages | [VanEck](https://github.com/daggerok/VanEck) |
| Vanguard | Vanguard product pages + SEC EDGAR N-PORT-P | [Vanguard](https://github.com/daggerok/Vanguard) |
| VictoryShares | VCM VictoryShares catalog and product JSON + SEC EDGAR N-PORT-P holdings fallback + Yahoo Finance adjusted-market-price history | [VictoryShares](https://github.com/daggerok/VictoryShares) |
| WisdomTree | WisdomTree product table + SEC EDGAR N-PORT-P + Yahoo Finance | [WisdomTree](https://github.com/daggerok/WisdomTree) |
| Xtrackers | Official DWS catalog/US sitemap + PDP/XLSX + SEC N-PORT-P holdings fallback + Yahoo Finance daily prices/history/dividends | [Xtrackers](https://github.com/daggerok/Xtrackers) |

## License

[MIT - same as all sibling ETF repositories.](./LICENSE)

Tema, Tema ETF Trust, and the fund names/tickers referenced here are names or marks of their respective owners. This is an independent, unofficial tool; it is not affiliated with, endorsed by, or sponsored by Tema Global Limited, Tema ETF Trust, or their affiliates. Public data is reproduced from Tema fund pages and downloads, SEC EDGAR filings, and Yahoo Finance for research purposes. All other trademarks, including index names, are the property of their respective owners.
