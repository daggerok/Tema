/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type FetchFunction, CONTROL_NAMES, RETURNS_BASIS, SEC_COMPANY_TICKERS_MF_URL, SEC_SUBMISSIONS_URL, SOFT_DEADLINE_MS,
  createNportResolver, createPacedHttpClient, createProviderHttpClients, createRequestGate, decodeTemaCsv, deriveTemaMetrics,
  edgarSeriesFilingsUrl, fillNportTickers, filterFundFromIndex, findTemaHoldingsCsvUrl, indexFundFromMeta, installSystemCa,
  isCertError, isRetryableHttpStatus, isoFromDateLabel, minimalIndexFund, normalizeTemaDate, nportBelongsToTema,
  nportIsNewerThanPublished, nportSeriesMatchesFund, nportUrlFor, outputPrintConfig, parseCompanyTickerMap, parseCsv,
  parseEdgarAtomFilings, parseNport, parseNportAccessions, parseTemaCatalog, parseTemaFundPage, parseTemaFundTickerTable,
  parseTemaHoldingsCsv, parseYahooChart, passesFundFilters, passesRange, passesStaticFundFilters, readUpdaterConfig,
  resolveControls, resolveTemaNportSeriesRef, responseText, retryDelayMilliseconds, runUpdater, runtimeControls,
  dividendYieldBasisFor, samePublishedContent, selectUpdateBatch, updaterHelpText, withReturnsContract, writeJsonIfChanged, yahooChartUrl,
  yahooDistributionRows, yahooHistoryRows, buildTemaFundMeta, shiftIsoDate, allFundsFailed, retainCatalogEntries,
} from './update-data.ts';

// ---------------------------------------------------------------------------
// Shared setup: clean environment, pinned TZ, restored fetch / exit code / console
// ---------------------------------------------------------------------------
const configFile = JSON.parse(readFileSync(new URL('./update-data.config.json', import.meta.url), 'utf8')) as Record<string, string>;
const realFetch = globalThis.fetch;
const realExitCode = process.exitCode;
const realLog = console.log;
const realError = console.error;
const savedEnv = { ...process.env };
const isControlVar = (key: string): boolean =>
  (CONTROL_NAMES as readonly string[]).includes(key) || key.startsWith('TEMA_') || ['ASSET_CLASS', 'HISTORICAL_PAGE_SIZE', 'NODE_USE_SYSTEM_CA', 'ETF_UPDATER_SYSTEM_CA', 'GITHUB_STEP_SUMMARY'].includes(key);

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (isControlVar(key)) delete process.env[key];
  process.env.TZ = 'UTC';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exitCode = realExitCode ?? 0;
  console.log = realLog;
  console.error = realError;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

// Small inline samples of the official Tema VOLT holdings CSV and fund page (no network, no fixture files)
const holdingsFixture = `holdings_date,ticker,cusip,proper_name,shares,market_value,percent_of_nav,is_cash,country,sector
2026-09-29,BELFB,077347300,BEL FUSE INC,199922,48804958.64,0.0671,0,United States,Information Technology
2026-09-29,APH,032095101,AMPHENOL CORP,575893,48547779.9,0.0668,0,United States,Information Technology
2026-09-29,ETN,G29183103,EATON CORP PLC,107327,46119485.17,0.0634,0,Ireland,Industrials
`;
const fundPageFixture = `<h1>VOLT Tema Electrification ETF</h1>
<div class="box"><div class="col-specification"><span>Ticker</span></div><div class="col-details">VOLT</div></div>
<div class="box"><div class="col-specification"><span>CUSIP</span></div><div class="col-details">87975E834</div></div>
<div class="box"><div class="col-specification"><span>Inception Date</span></div><div class="col-details">12/03/24</div></div>
<div class="box"><div class="col-specification"><span>Total Expense Ratio</span></div><div class="col-details">0.75%</div></div>
<div class="box"><div class="col-specification"><span>AUM</span></div><div class="col-details">$734,149,760</div></div>
<div class="box"><div class="col-specification"><span>Primary Exchange</span></div><div class="col-details">Nasdaq</div></div>
<div class="box"><div class="col-specification"><span>Shares Outstanding</span></div><div class="col-details">20,500,000</div></div>
<div class="box"><div class="col-specification"><span># of Holdings</span></div><div class="col-details">27</div></div>
<div class="price-table__row"><span>NAV</span><span>$35.81</span></div>
<div class="price-table__row"><span>Market Price</span><span>$35.85</span></div>
<div class="price-table__row"><span>Premium/Discount</span><span>0.11%</span></div>
<div class="as-of-date-container"> As of September 29, 2026 </div>
`;
const epoch = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 1000;

// ---------------------------------------------------------------------------
// Offline multi-fund harness: injected provider clients, per-test temp feed directory
// ---------------------------------------------------------------------------
const okResponse = (body: string, contentType = 'text/html') => new Response(body, { status: 200, headers: { 'content-type': contentType } });
const csvUrlFor = (ticker: string) => `https://temaetfs.com/hubfs/Website/Holdings/${ticker}-holdings-09292026.csv`;

function dailyChart(startIso: string, days: number, dividends: Record<string, { date: number; amount: number }> = {}) {
  const timestamp = Array.from({ length: days }, (_unused, index) => epoch(startIso) + index * 86_400);
  const close = timestamp.map((_value, index) => 20 + index * 0.01);
  return { chart: { result: [{
    meta: { longName: 'Test ETF', exchangeName: 'Nasdaq', currency: 'USD', regularMarketPrice: close.at(-1) },
    timestamp,
    indicators: { quote: [{ close }], adjclose: [{ adjclose: close }] },
    events: { dividends },
  }] } };
}

function temaPage(ticker: string, ter: string | null = '0.75%'): string {
  let html = fundPageFixture.replace(/VOLT/g, ticker);
  if (ter === null) html = html.replace(/<div class="box"><div class="col-specification"><span>Total Expense Ratio<\/span><\/div><div class="col-details">0\.75%<\/div><\/div>\n/, '');
  return `${html}<a href="${csvUrlFor(ticker)}">Download Holdings (CSV)</a>`;
}

function issuerFor(tickers: string[], options: { ter?: string | null; down?: boolean; csvGone?: boolean } = {}) {
  const catalog = tickers.map((ticker) => `<a href="https://temaetfs.com/${ticker.toLowerCase()}">${ticker} Tema ETF</a>`).join('');
  return { fetch: async (input: string | URL) => {
    const url = String(input);
    if (url === 'https://temaetfs.com/funds') return okResponse(catalog);
    if (options.down) return new Response('unavailable', { status: 503 });
    const ticker = tickers.find((item) => url === `https://temaetfs.com/${item.toLowerCase()}`);
    if (ticker) return okResponse(temaPage(ticker, options.ter));
    if (url.startsWith('https://temaetfs.com/hubfs/')) return options.csvGone ? new Response('gone', { status: 404 }) : okResponse(holdingsFixture, 'text/csv');
    return new Response('not found', { status: 404 });
  } };
}

function nportClient(reportDate: string) {
  const xml = `<edgarSubmission><genInfo><regName>Tema ETF Trust</regName><regCik>0001944285</regCik><seriesName>Tema Electrification ETF</seriesName><seriesId>S000001</seriesId><repPdDate>${reportDate}</repPdDate></genInfo><formData><fundInfo><netAssets>1000.5</netAssets></fundInfo><invstOrSec><name>OLD CO</name><cusip>111111111</cusip><valUSD>10</valUSD><pctVal>5</pctVal><balance>3</balance><assetCat>EC</assetCat></invstOrSec></formData></edgarSubmission>`;
  return { fetch: async (input: string | URL) => {
    const url = String(input);
    if (url.includes('company_tickers_mf')) return okResponse(JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[1944285, 'S000001', 'C000001', 'VOLT']] }), 'application/json');
    if (url.includes('submissions')) return okResponse(JSON.stringify({ cik: '1944285', filings: { recent: { form: ['NPORT-P'], accessionNumber: ['0001-26-000001'], filingDate: ['2026-07-30'], reportDate: [reportDate] } } }), 'application/json');
    if (url.includes('primary_doc')) return okResponse(xml, 'text/xml');
    if (url.includes('company_tickers')) return okResponse('{}', 'application/json');
    return new Response('not found', { status: 404 });
  } };
}

const yahooFor = (payload: unknown, urls: string[] = []) => ({ fetch: async (input: string | URL) => { urls.push(String(input)); return okResponse(JSON.stringify(payload), 'application/json'); } });
const downClient = { fetch: async () => new Response('unavailable', { status: 503 }) };
const healthy = (tickers: string[], chart: unknown = dailyChart('2026-09-01', 29)) => ({ issuer: issuerFor(tickers), yahoo: yahooFor(chart), sec: downClient });

async function treeSnapshot(directory: string): Promise<string> {
  const files: Array<[string, string]> = [];
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else files.push([child.slice(directory.length + 1), await readFile(child, 'utf8')]);
    }
  }
  await visit(directory);
  return JSON.stringify(files);
}

// Back-dating every file lets a test prove that a rerun does not touch a single one of them.
const OLD_MTIME = new Date('2001-09-09T01:46:40Z');
async function eachFile(directory: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) await eachFile(child, visit); else await visit(child);
  }
}
const backdate = (directory: string) => eachFile(directory, (path) => utimes(path, OLD_MTIME, OLD_MTIME));
async function touchedFiles(directory: string): Promise<string[]> {
  const touched: string[] = [];
  await eachFile(directory, async (path) => { if ((await stat(path)).mtimeMs !== OLD_MTIME.getTime()) touched.push(path.slice(directory.length + 1)); });
  return touched.sort();
}

async function withFeed<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'tema-test-'));
  console.log = () => undefined;
  try {
    return await run(directory);
  } finally {
    console.log = realLog;
    await rm(directory, { recursive: true, force: true });
  }
}

const feedConfig = (directory: string, extra: Record<string, string> = {}) =>
  readUpdaterConfig({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', CONCURRENCY: '2', EDGAR_FALLBACK: 'false', ...extra }, directory);
const readIndex = async (directory: string) => JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
const readMeta = async (directory: string, ticker: string) => JSON.parse(await readFile(join(directory, 'funds', ticker, 'meta.json'), 'utf8'));

// ===========================================================================
describe('controls', () => {
  test('precedence: file < advanced < nonblank input < env, brand and legacy aliases', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'VOLT' }, { CONCURRENCY: 3, TICKERS: 'WELD' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
    expect([c.CONCURRENCY, c.TICKERS]).toEqual(['5', 'WELD']);
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ TICKERS: 'VOLT' }, {}, { TICKERS: '' }).TICKERS).toBe('VOLT');
    expect(resolveControls({ TICKERS: 'VOLT' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'VOLT' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { TEMA_LIMIT: '7' }).MAX_FETCHES).toBe('7');
    expect(resolveControls({ CATEGORY: '' }, {}, {}, { ASSET_CLASS: 'Equity' }).CATEGORY).toBe('Equity');
  });

  test('strict validation: bad range, HISTORY_RANGE, MAX_RETRIES < 1, unknown keys, non-scalars, CR/LF/NUL', () => {
    for (const value of [
      { UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { SEC_UA: 'x\rfoo' }, { SEC_UA: 'x\0bad' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 },
      { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' },
      { SKIP_YAHOO: 'maybe' }, { AUM: '1:2:3' }, { TER: '2:1' }, { TER: '0.2' }, { HISTORY_RANGE: '10d' }, { TICKERS: ['VOLT'] }, null, [],
    ]) {
      expect(() => resolveControls(value)).toThrow();
      if (value && !Array.isArray(value)) expect(() => resolveControls({}, value)).toThrow();
    }
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow();
    expect(() => readUpdaterConfig({ TER: '1:0.1' })).toThrow('minimum exceeds maximum');
    expect(() => readUpdaterConfig({ AUM: 'many' })).toThrow();
  });

  test('config file: keys equal CONTROL_NAMES and --help, values are strings, the scheduled path equals the defaults', async () => {
    expect(Object.keys(configFile).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(configFile)) expect(typeof value).toBe('string');
    expect(resolveControls(configFile, {}, {})).toEqual(configFile);
    const help = updaterHelpText();
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
      expect(help).toContain(tenor ? `${tenor[1]}_{YTD,1Y,3Y,5Y,10Y}` : name);
    }
    const config = readUpdaterConfig(resolveControls(configFile));
    expect(config).toMatchObject({
      maxFetches: 0, requestSleepSeconds: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250,
      historyPageSize: 1000, historyRange: 'max', edgarFallback: true, skipYahoo: false, tickers: [],
    });
    expect(config.outputDir.endsWith('api/tema')).toBe(true);
    expect((await runtimeControls({ TICKERS: 'VOLT', REQUEST_SLEEP: '0' })).TICKERS).toBe('VOLT');
    expect((await runtimeControls({})).HISTORY_PAGE_SIZE).toBe('1000');
  });

  test('SEC_UA defaults to the daggerok contact, a protected value wins and the console line is redacted', () => {
    expect(configFile.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(readUpdaterConfig({}).secUserAgent).toBe(configFile.SEC_UA);
    expect(resolveControls(configFile, { SEC_UA: 'adv' }, { SEC_UA: 'in' }, { SEC_UA: 'protected' }).SEC_UA).toBe('protected');
    const lines: string[] = [];
    console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
    outputPrintConfig('Tema ETFs', readUpdaterConfig({}));
    expect(lines.join('\n')).toContain('[ config   ] Tema ETFs updater:');
    expect(lines.join('\n')).not.toContain('gmail.com');
  });

  test('env aliases, ticker/category lists, AUM presets, return ranges and the output directory', () => {
    const config = readUpdaterConfig({
      TEMA_LIMIT: '5', REQUEST_SLEEP: '0.25', CONCURRENCY: '3', MAX_RETRIES: '1', TICKERS: 'volt, army;DSPY', CATEGORY: 'equity, fixed income',
      AUM: 'micro', TER: ':0.75', DIVIDEND_YIELD: '1.5:', SEC_YIELD: ':5', PERFORMANCE_YTD: '-2:25', TOTAL_RETURN_3Y: '10:',
      EDGAR_FALLBACK: 'off', SKIP_YAHOO: 'true', HOLDINGS_PAGE_SIZE: '100', HISTORY_PAGE_SIZE: '365', HISTORY_RANGE: '5y',
    }, 'isolated/api/tema');
    expect(config).toMatchObject({
      maxFetches: 5, requestSleepSeconds: 0.25, concurrency: 3, maxRetries: 1, tickers: ['VOLT', 'ARMY', 'DSPY'],
      categories: ['equity', 'fixed income'], aumRange: { min: 10_000_000, max: 300_000_000 }, terRange: { min: null, max: 0.75 },
      dividendYieldRange: { min: 1.5, max: null }, secYieldRange: { min: null, max: 5 }, performanceRanges: { YTD: { min: -2, max: 25 } },
      totalReturnRanges: { '3Y': { min: 10, max: null } }, edgarFallback: false, skipYahoo: true, holdingsPageSize: 100,
      historyPageSize: 365, historyRange: '5y',
    });
    expect(config.outputDir.endsWith('/isolated/api/tema')).toBe(true);
    const preset = (aum: string) => readUpdaterConfig({ AUM: aum }).aumRange;
    expect(preset('nano')).toMatchObject({ min: null, max: 10_000_000 });
    expect(preset('large')).toMatchObject({ min: 10_000_000_000, max: null });
  });

  test('range filters are inclusive, accept zero and negatives, and exclude unknown values', () => {
    const config = readUpdaterConfig({ TICKERS: 'VOLT DSPY', CATEGORY: 'equity', AUM: '10M:1B', TER: '0:0.75' });
    expect(passesRange(0, { min: 0, max: null, source: '0:' })).toBe(true);
    expect(passesRange(-1, { min: -1, max: 0, source: '-1:0' })).toBe(true);
    expect(passesRange(null, { min: 0, max: 1, source: '0:1' })).toBe(false);
    expect(passesFundFilters({ ticker: 'VOLT', category: 'Equity', aumValue: 100_000_000, terValue: 0.75 }, config)).toBe(true);
    expect(passesFundFilters({ ticker: 'ARMY', category: 'Equity', aumValue: 100_000_000, terValue: 0.5 }, config)).toBe(false);
    expect(passesFundFilters({ ticker: 'VOLT', category: 'Equity', aumValue: null, terValue: 0.5 }, config)).toBe(false);
    const metricConfig = readUpdaterConfig({ TICKERS: 'VOLT', CATEGORY: 'equity', AUM: '500M:1B', TOTAL_RETURN_1Y: '10:' });
    expect(passesStaticFundFilters({ ticker: 'DSPY' }, 'Equity', metricConfig)).toBe(false);
    const filter = filterFundFromIndex({
      ticker: 'VOLT', category: 'Equity', aumValue: 734149760, terValue: 0.75,
      metrics: { ytd: 4, tr1y: 18, tr3y: 42, tr5y: null, tr10y: null, dividendYield: 1.2, secYield: null },
      returns: { monthEnd: { asOfDate: 'Sep 29 2026', ytd: 4, yr1: 18, yr3: 12, yr5: null, yr10: null } },
    });
    expect(passesFundFilters(filter, metricConfig)).toBe(true);
    expect(passesFundFilters({ ...filter, aumValue: 200_000_000 }, metricConfig)).toBe(false);
  });

  test('MAX_FETCHES rotates after the saved cursor, explicit tickers ignore it, 0 means a full run', () => {
    const funds = ['ARMY', 'CANC', 'DICE', 'DSPY'].map((ticker) => ({ ticker }));
    const tickers = (...args: Parameters<typeof selectUpdateBatch>) => selectUpdateBatch(...args).map((fund) => fund.ticker);
    expect(tickers(funds, 'CANC', 2)).toEqual(['DICE', 'DSPY']);
    expect(tickers(funds, 'DSPY', 2)).toEqual(['ARMY', 'CANC']);
    expect(tickers(funds, 'CANC', 1, ['DSPY', 'ARMY'])).toEqual(['ARMY']);
    expect(tickers(funds, 'DSPY', 0)).toEqual(['ARMY', 'CANC', 'DICE', 'DSPY']);
  });

  test('USE_SYSTEM_CA: auto by default, restart only on certificate errors, never for false or an active store', async () => {
    expect(resolveControls(configFile).USE_SYSTEM_CA).toBe('auto');
    for (const mode of ['auto', 'true', 'false', 'TRUE', 'Auto']) expect(resolveControls({}, { USE_SYSTEM_CA: mode }).USE_SYSTEM_CA).toBe(mode.toLowerCase());
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(new Error('fetch failed', { cause: new Error('self-signed certificate in certificate chain') }))).toBe(true);
    expect(isCertError({ code: 'ECONNRESET' })).toBe(false);

    console.error = () => undefined;
    let calls = 0;
    const reexec = (() => { calls += 1; return undefined as never; });
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    installSystemCa('true', reexec, true);
    expect(globalThis.fetch).toBe(realFetch);
    expect(calls).toBe(0);
    installSystemCa('true', reexec, false);
    expect(calls).toBe(1);
    globalThis.fetch = (async () => { throw new Error('unable to get local issuer certificate'); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await globalThis.fetch('https://example.invalid');
    expect(calls).toBe(2);
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(globalThis.fetch('https://example.invalid')).rejects.toThrow('ECONNRESET');
    expect(calls).toBe(2);
  });
});

// ===========================================================================
describe('parsing', () => {
  test('CSV reader supports CRLF, quoted commas, doubled quotes, embedded newlines and a BOM, and rejects an open quote', () => {
    expect(parseCsv('﻿name,value\r\n"ACME, Inc.","said ""hello"""\r\n"line one\nline two",0\r\n')).toEqual([
      ['name', 'value'], ['ACME, Inc.', 'said "hello"'], ['line one\nline two', '0'],
    ]);
    expect(() => parseCsv('name,value\n"unfinished,1')).toThrow('unterminated');
    expect(decodeTemaCsv(new Uint8Array([0x8e]), 'text/csv; charset=x-macroman')).toBe('é');
  });

  test('catalog keeps unique ticker routes with descriptive names, the CSV link keeps its query and rejects foreign links', () => {
    const html = `<a href="/about-us">About Us</a><a href="https://temaetfs.com/volt">VOLT</a><a href="https://temaetfs.com/volt">VOLT Electrification ETF</a>
      <a href="/dice">DICE</a><a href="/dice">DICE (NEW) Trading &amp; Prediction Markets ETF</a><a href="/prvt">PRVT</a><a href="/funds">ETF list</a><a href="/education">ETF Education</a>`;
    expect(parseTemaCatalog(html)).toEqual([
      { ticker: 'DICE', name: 'DICE Trading & Prediction Markets ETF', fundPage: 'https://temaetfs.com/dice' },
      { ticker: 'PRVT', name: 'PRVT', fundPage: 'https://temaetfs.com/prvt' },
      { ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' },
    ]);
    expect(findTemaHoldingsCsvUrl('<a href="https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv?v=68473&amp;temaHoldingsCacheBuster=1">Download Holdings (CSV)</a>', 'VOLT', 'https://temaetfs.com/volt'))
      .toBe('https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv?v=68473&temaHoldingsCacheBuster=1');
    expect(() => findTemaHoldingsCsvUrl('<a href="https://example.com/VOLT.csv">CSV</a>', 'VOLT', 'https://temaetfs.com/volt')).toThrow('no official daily holdings CSV');
    expect(() => findTemaHoldingsCsvUrl('<a href="/hubfs/Website/Holdings/ARMY-holdings-01012026.csv">CSV</a>', 'VOLT', 'https://temaetfs.com/volt')).toThrow('no official daily holdings CSV');
  });

  test('holdings CSV maps into the shared contract, keeps real zero and negative numbers, ignores unknown columns', () => {
    const parsed = parseTemaHoldingsCsv(holdingsFixture);
    expect([parsed.asOfDate, parsed.totalRows]).toEqual(['2026-09-29', 3]);
    expect(parsed.rows[0]).toEqual({
      Name: 'BEL FUSE INC', Ticker: 'BELFB', Identifier: '077347300', Weight: '6.71', 'Market Value': '48804958.64', 'Shares Held': '199922',
      'Asset Category': 'Information Technology', Country: 'United States', Sector: 'Information Technology', Cash: 'No',
    });
    const reordered = parseTemaHoldingsCsv([
      'sector,percent_of_nav,custom,proper_name,is_cash,market_value,holdings_date,ticker,cusip,country,shares',
      'Cash,-0.0005,ignored,CASH COLLATERAL,1,0,2026-09-29,,CASH,United States,-2',
      ',,,,,,,,,,',
    ].join('\n'));
    expect(reordered.totalRows).toBe(1);
    expect(reordered.rows[0]).toMatchObject({ Name: 'CASH COLLATERAL', Ticker: '', Identifier: 'CASH', Weight: '-0.05', 'Market Value': '0', 'Shares Held': '-2', Cash: 'Yes' });
    expect(() => parseTemaHoldingsCsv('ticker,proper_name\nVOLT,Tema')).toThrow('missing required columns');
    expect(() => parseTemaHoldingsCsv(holdingsFixture.replaceAll('2026-09-29', 'not-a-date'))).toThrow('no valid holdings_date');
  });

  test('fund page: official details and price blocks, heading fallback, ticker mismatch is rejected', () => {
    expect(parseTemaFundPage(fundPageFixture, 'VOLT', 'VOLT Electrification ETF')).toEqual({
      ticker: 'VOLT', name: 'VOLT Electrification ETF', cusip: '87975E834', inceptionDate: 'Dec 03 2024', ter: '0.75%', terValue: 0.75,
      aum: '$734,149,760', aumValue: 734149760, exchange: 'Nasdaq', sharesOutstanding: 20500000, holdingsCount: 27, nav: '$35.81', navValue: 35.81,
      closePrice: '$35.85', closePriceValue: 35.85, premiumDiscount: '0.11%', premiumDiscountValue: 0.11, asOfDate: 'Sep 29 2026',
    });
    expect(parseTemaFundPage(fundPageFixture, 'VOLT', 'VOLT').name).toBe('Tema Electrification ETF');
    expect(() => parseTemaFundPage(fundPageFixture, 'ARMY')).toThrow('fund page identifies itself as VOLT');
  });

  test.each([
    ['2026-09-29', '2026-09-29'], ['09/29/2026', '2026-09-29'], ['12/03/24', '2024-12-03'], ['09292026', '2026-09-29'],
    ['Sep 30 2026', '2026-09-30'], ['September 29, 2026', '2026-09-29'], ['2026-02-30', ''], ['', ''],
  ])('date %s -> %s', (input, expected) => {
    expect(normalizeTemaDate(input)).toBe(expected);
  });

  test('Yahoo chart: close, adjusted close, metadata and dividends; rows without a close are skipped', () => {
    const chart = parseYahooChart({ chart: { result: [{
      meta: { longName: 'VOLT ETF', exchangeName: 'Nasdaq', currency: 'USD', regularMarketPrice: 12.345, regularMarketTime: epoch('2026-09-29'), firstTradeDate: epoch('2024-12-03') },
      timestamp: [epoch('2026-09-26'), epoch('2026-09-28'), epoch('2026-09-29')],
      indicators: { quote: [{ close: [10.12345678, null, 12.345678], volume: [100, 200, 300] }], adjclose: [{ adjclose: [10.124, 50, 12.349] }] },
      events: { dividends: { '1788220800': { date: epoch('2026-09-01'), amount: 0.125 } } },
    }] } });
    expect([chart.longName, chart.exchangeName, chart.currency]).toEqual(['VOLT ETF', 'Nasdaq', 'USD']);
    expect(chart.days).toEqual([
      { date: '2026-09-26', close: 10.123457, adjClose: 10.124, volume: 100 },
      { date: '2026-09-29', close: 12.345678, adjClose: 12.349, volume: 300 },
    ]);
    expect(chart.dividends).toEqual([{ date: '2026-09-01', amount: 0.125 }]);
    expect(() => parseYahooChart({ chart: { result: [] } })).toThrow('empty result');
    expect(yahooHistoryRows(chart).map((row) => row.Date)).toEqual(['Sep 26 2026', 'Sep 29 2026']);
    expect(yahooDistributionRows(chart)).toEqual([['09/01/2026', '0.125']]);
  });

  test('N-PORT: Tema-only ticker table, recent accessions and Atom feed, XML positions with issuer tickers', () => {
    const payload = { fields: ['symbol', 'classId', 'seriesId', 'cik'], data: [['VOLT', 'C000239058', 'S000088946', 1944285], ['OTHER', 'C000000001', 'S000000001', 1234567]] };
    expect(parseTemaFundTickerTable(payload).get('VOLT')).toEqual({ cik: '0001944285', seriesId: 'S000088946', classId: 'C000239058' });
    expect(parseTemaFundTickerTable(payload).has('OTHER')).toBe(false);
    const filings = parseNportAccessions({ cik: '0001944285', filings: { recent: {
      form: ['NPORT-P', 'N-1A'], accessionNumber: ['0001944285-26-000123', '0001944285-26-000124'], filingDate: ['2026-09-29', '2026-09-30'], reportDate: ['2026-08-31', ''],
    } } });
    expect(filings).toEqual([{ accession: '0001944285-26-000123', filed: '2026-09-29', reportDate: '2026-08-31', url: 'https://www.sec.gov/Archives/edgar/data/1944285/000194428526000123/primary_doc.xml' }]);
    expect(nportUrlFor('0001944285', '0001944285-26-000123')).toBe(filings[0].url);
    const atom = '<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001944285-26-000123</accession-number><filing-date>2026-09-29</filing-date><period>2026-08-31</period><filing-href>https://www.sec.gov/Archives/edgar/data/1944285/000194428526000123/index.htm</filing-href></entry></feed>';
    expect(parseEdgarAtomFilings(atom)[0].url).toBe(filings[0].url);
    expect(new URL(edgarSeriesFilingsUrl('S000088946')).searchParams.get('type')).toBe('NPORT-P');
    const xml = '<edgarSubmission><genInfo><regName>Tema ETF Trust</regName><regCik>0001944285</regCik><seriesName>VOLT ETF</seriesName><seriesId>S000088946</seriesId><repPdDate>2026-08-31</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo><invstOrSec><name>Example Public Company Inc</name><cusip>123456789</cusip><pctVal>12.5</pctVal><valUSD>125000</valUSD><balance>1000</balance><assetCat>EC</assetCat></invstOrSec><invstOrSec><name>Cash Collateral</name><pctVal>1.5</pctVal><valUSD>15000</valUSD><balance>15000</balance><assetCat>STIV</assetCat></invstOrSec></edgarSubmission>';
    const parsed = parseNport(xml);
    expect(parsed).toMatchObject({ regName: 'Tema ETF Trust', regCik: '0001944285', seriesId: 'S000088946', reportDate: '2026-08-31', netAssets: 1_000_000 });
    expect(parsed.holdings).toHaveLength(2);
    expect(parsed.holdings[0]).toMatchObject({ Name: 'Example Public Company Inc', Identifier: '123456789', Weight: '12.5', 'Market Value': '125000', 'Shares Held': '1000' });
    expect(fillNportTickers(parsed.holdings, parseCompanyTickerMap({ '0': { ticker: 'EXM', title: 'Example Public Company Inc' } }))[0].Ticker).toBe('EXM');
  });

  test('N-PORT series resolver: WELD aliases the legacy RSHO series, the scan is recent-first and cached', async () => {
    const mapping = new Map([
      ['RSHO', { cik: '0001944285', seriesId: 'S000WELD', classId: 'C0001' }],
      ['PRVT', { cik: '0001944285', seriesId: 'S000PRVT', classId: 'C0002' }],
    ]);
    expect(resolveTemaNportSeriesRef('WELD', mapping)?.seriesId).toBe('S000WELD');
    expect(resolveTemaNportSeriesRef('DICE', mapping)).toBeNull();
    const series = (seriesName: string) => ({ regName: '', regCik: '', seriesName, seriesId: '', reportDate: '', holdings: [], netAssets: null });
    expect(nportSeriesMatchesFund(series('DICE Trading & Prediction Markets ETF'), 'DICE', 'Tema DICE Trading and Prediction Markets ETF')).toBe(true);
    expect(nportSeriesMatchesFund(series('CANC Cancer Immunotherapy ETF'), 'DICE', 'Tema DICE Trading and Prediction Markets ETF')).toBe(false);

    const filings = [
      { accession: '0001944285-26-000003', filingDate: '2026-07-29', seriesId: 'S000OTHER', seriesName: 'Tema Legacy ETF' },
      { accession: '0001944285-26-000002', filingDate: '2026-07-28', seriesId: 'S000WELD', seriesName: 'Tema Weld Industries ETF' },
      { accession: '0001944285-26-000001', filingDate: '2026-07-27', seriesId: 'S000PRVT', seriesName: 'Tema Private Markets ETF' },
    ];
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    const archiveCalls: string[] = [];
    const fetchImpl: FetchFunction = async (input) => {
      const url = String(input);
      if (url === SEC_COMPANY_TICKERS_MF_URL) return json({ fields: ['symbol', 'cik', 'seriesId', 'classId'], data: [['RSHO', '1944285', 'S000WELD', 'C0001'], ['PRVT', '1944285', 'S000PRVT', 'C0002']] });
      if (url === SEC_SUBMISSIONS_URL) return json({ cik: 1944285, filings: { recent: {
        form: filings.map(() => 'NPORT-P'), accessionNumber: filings.map((f) => f.accession), filingDate: filings.map((f) => f.filingDate), reportDate: filings.map(() => '2026-05-31'),
      } } });
      const filing = filings.find((value) => url.includes(value.accession.replace(/-/g, '')));
      if (!filing) return new Response('missing fixture', { status: 404 });
      archiveCalls.push(filing.accession);
      return new Response(`<edgarSubmission><genInfo><regName>Tema ETF Trust</regName><regCik>0001944285</regCik><seriesName>${filing.seriesName}</seriesName><seriesId>${filing.seriesId}</seriesId><repPdDate>2026-05-31</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo></edgarSubmission>`, { status: 200, headers: { 'content-type': 'text/xml' } });
    };
    const resolve = createNportResolver(createPacedHttpClient({ gate: { pace: async () => undefined }, retries: 0, userAgent: 'test', fetchImpl }), { concurrency: 2, maxDocuments: 10 });
    expect((await resolve({ ticker: 'WELD', name: 'Tema Weld Industries ETF' }))?.report.seriesId).toBe('S000WELD');
    expect(archiveCalls).toEqual([filings[0].accession, filings[1].accession]);
    expect((await resolve({ ticker: 'WELD', name: 'Tema Weld Industries ETF' }))?.accession.accession).toBe(filings[1].accession);
    expect((await resolve({ ticker: 'PRVT', name: 'Tema Private Markets ETF' }))?.report.seriesId).toBe('S000PRVT');
  });
});

// ===========================================================================
describe('metrics', () => {
  test('total returns and indicated yield derive from dated adjusted closes; unreachable horizons stay null', () => {
    const day = (date: string, close: number) => ({ date, close, adjClose: close, volume: 1 });
    const days = [day('2024-12-31', 80), day('2025-01-02', 81), day('2025-06-30', 90), day('2025-09-29', 95), day('2025-12-31', 100), day('2026-01-02', 101), day('2026-06-30', 110), day('2026-09-29', 120)];
    const dividends = [{ date: '2025-10-01', amount: 1 }, { date: '2026-04-01', amount: 1 }, { date: '2026-09-01', amount: 1 }];
    const result = deriveTemaMetrics({ days, dividends, currency: 'USD', exchangeName: 'Nasdaq', longName: 'VOLT', regularMarketPrice: 120, regularMarketTime: null, firstTradeDate: null });
    expect([result.metrics.ytd, result.metrics.tr1y, result.metrics.cagr3y, result.dividendYield]).toEqual([20, 26.32, null, 2.5]);
    expect(result.latestDividend).toEqual({ date: '2026-09-01', amount: 1 });
    expect(result.frequency).toEqual({ frequency: 'Semi-annually', paymentsPerYear: 2 });
    expect([result.monthEnd.asOfDate, result.quarterEnd.asOfDate]).toEqual(['Jun 30 2026', 'Jun 30 2026']);
  });

  test('a young fund and absent dividends give null, never 0; since-inception needs a year of history', () => {
    const young = deriveTemaMetrics(parseYahooChart(dailyChart('2026-09-01', 29)));
    expect([young.metrics.tr1y, young.metrics.tr3y, young.metrics.tr5y, young.metrics.tr10y, young.metrics.cagr3y, young.dividendYield]).toEqual([null, null, null, null, null, null]);
    expect(young.frequency.frequency).toBe('Unknown');
    const sinceInception = (days: number) => deriveTemaMetrics(parseYahooChart(dailyChart('2025-10-01', days))).monthEnd.sinceInception;
    expect(sinceInception(300)).toBeNull();
    expect(sinceInception(420)).not.toBeNull();
    const tiny = parseYahooChart({ chart: { result: [{ meta: {}, timestamp: [epoch('2025-12-31'), epoch('2026-09-30')], indicators: { quote: [{ close: [0.0041, 0.0049] }], adjclose: [{ adjclose: [0.0041, 0.0049] }] } }] } });
    expect(deriveTemaMetrics(tiny).monthEnd.ytd).toBe(19.51);
  });

  test('returnsBasis is never empty and travels with an ISO performanceAsOf (or null), same keys on every row', () => {
    expect(RETURNS_BASIS).toMatch(/Yahoo/);
    expect([isoFromDateLabel('Sep 30 2026'), isoFromDateLabel('Feb 31 2026'), isoFromDateLabel(''), isoFromDateLabel(undefined)]).toEqual(['2026-09-30', null, null, null]);
    expect(withReturnsContract({ ytd: null, returnsBasis: '-', performanceAsOf: 'Sep 30 2026' })).toEqual({ ytd: null, dividendYieldBasis: null, returnsBasis: RETURNS_BASIS, performanceAsOf: null });
    expect(Object.keys(withReturnsContract({ performanceAsOf: '2026-09-30', returnsBasis: 'x', ytd: 1 }))).toEqual(['ytd', 'dividendYieldBasis', 'returnsBasis', 'performanceAsOf']);
    const fund = { ticker: 'NEW', name: 'New ETF', fundPage: 'https://temaetfs.com/new' };
    const young = indexFundFromMeta(fund, { returns: { monthEnd: { asOfDate: 'Sep 30 2026', yr1: null, ytd: 1.5 } } });
    expect(young.metrics).toMatchObject({ ytd: 1.5, tr1y: null, tr3y: null, performanceAsOf: '2026-09-30', returnsBasis: RETURNS_BASIS });
    expect(indexFundFromMeta(fund, {}).metrics).toMatchObject({ performanceAsOf: null, returnsBasis: RETURNS_BASIS });
    const blank = minimalIndexFund(fund, { metrics: { ytd: 3 } });
    expect(blank.metrics).toMatchObject({ ytd: 3, tr1y: null, returnsBasis: RETURNS_BASIS, performanceAsOf: null });
    expect(Object.keys(blank.metrics as object)).toEqual(Object.keys(minimalIndexFund(fund).metrics as object));
    expect(Object.keys(blank.metrics as object)).toEqual(['ytd', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn', 'dividendYield', 'dividendYieldText', 'secYield', 'secYieldText', 'dividendYieldBasis', 'returnsBasis', 'performanceAsOf']);
  });

  test('dividendYieldBasis: computed-trailing-12m exactly when the yield exists, null otherwise, kept with the yield on every row kind', () => {
    const fund = { ticker: 'NEW', name: 'New ETF', fundPage: 'https://temaetfs.com/new' };
    const day = (date: string, close: number) => ({ date, close, adjClose: close, volume: 1 });
    const chart = (dividends: { date: string; amount: number }[]) => ({ days: [day('2026-01-02', 100), day('2026-09-29', 120)], dividends, currency: 'USD', exchangeName: 'Nasdaq', longName: 'X', regularMarketPrice: 120, regularMarketTime: null, firstTradeDate: null });
    expect(deriveTemaMetrics(chart([{ date: '2026-09-01', amount: 1.2 }])).metrics).toMatchObject({ dividendYield: 1, dividendYieldBasis: 'computed-trailing-12m' });
    expect(deriveTemaMetrics(chart([])).metrics).toMatchObject({ dividendYield: null, dividendYieldBasis: null });
    expect(deriveTemaMetrics(parseYahooChart(dailyChart('2026-09-01', 29))).metrics).toMatchObject({ dividendYield: null, dividendYieldBasis: null });
    expect(dividendYieldBasisFor(null, 'indicated')).toBeNull();
    expect(dividendYieldBasisFor(1.5)).toBe('computed-trailing-12m');
    expect(dividendYieldBasisFor(1.5, 'bogus')).toBe('computed-trailing-12m');
    const rebuilt = indexFundFromMeta(fund, { yields: { dividendYield: 2.1, dividendYieldBasis: 'computed-trailing-12m' } });
    const legacy = indexFundFromMeta(fund, { yields: { dividendYield: 2.1 } });
    const empty = indexFundFromMeta(fund, {});
    expect([rebuilt.metrics, legacy.metrics, empty.metrics].map((m) => (m as Record<string, unknown>).dividendYieldBasis)).toEqual(['computed-trailing-12m', 'computed-trailing-12m', null]);
    const retained = minimalIndexFund(fund, { metrics: { dividendYield: 3, dividendYieldBasis: 'computed-trailing-12m' } });
    const placeholder = minimalIndexFund(fund);
    expect([(retained.metrics as Record<string, unknown>).dividendYieldBasis, (placeholder.metrics as Record<string, unknown>).dividendYieldBasis]).toEqual(['computed-trailing-12m', null]);
    expect(Object.keys(rebuilt.metrics as object)).toEqual(Object.keys(placeholder.metrics as object));
    expect(Object.keys(retained.metrics as object)).toEqual(Object.keys(empty.metrics as object));
  });

  test('meta and index rows carry the official page fields with honest Yahoo/SEC provenance and net TER mapping', () => {
    const fund = { ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' };
    const chart = {
      exchangeName: 'Nasdaq', longName: 'VOLT ETF', currency: 'USD', regularMarketPrice: 35.85, regularMarketTime: null, firstTradeDate: null,
      days: [{ date: '2026-09-29', close: 35.85, adjClose: 35.84, volume: 1 }], dividends: [{ date: '2026-07-01', amount: 0.2 }, { date: '2026-09-01', amount: 0.25 }],
    };
    const meta = buildTemaFundMeta({
      fund, page: parseTemaFundPage(fundPageFixture, 'VOLT', fund.name),
      holdings: { pages: ['holdings/001.json'], pageSize: 250, totalRows: 27, asOfDate: '2026-09-29', source: 'Tema official daily CSV' },
      history: { pages: ['history/001.json'], pageSize: 1000, totalRows: 1, asOfDate: '2026-09-29', source: 'Yahoo Finance chart API' },
      chart, derived: deriveTemaMetrics(chart), holdingsDownloadUrl: 'https://temaetfs.com/hubfs/holdings.csv?cache=changing', nport: null, generatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(meta.source).toMatchObject({ yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart/VOLT', holdingsDownload: 'https://temaetfs.com/hubfs/holdings.csv' });
    expect(meta.expenseRatio).toMatchObject({ display: '0.75%', value: 0.75, gross: null, net: 0.75 });
    expect(meta.yields).toMatchObject({ secYield: null, dividendYield: 1.26 });
    const row = indexFundFromMeta(fund, meta);
    expect(row).toMatchObject({ ticker: 'VOLT', aumValue: 734149760, navValue: 35.81, closePriceValue: 35.85, holdings: 27, history: 1 });
    expect(Object.keys(row.metrics as object).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect(row.metrics).toMatchObject({ returnsBasis: RETURNS_BASIS, performanceAsOf: '2026-09-29' });
  });

  test('month-name dates parse as UTC and date offsets clamp, in any machine time zone', () => {
    expect(shiftIsoDate('2024-02-29', -1, 0)).toBe('2023-02-28');
    expect(shiftIsoDate('2026-03-31', 0, -1)).toBe('2026-02-28');
    const script = `import { normalizeTemaDate, isoFromDateLabel } from ${JSON.stringify(new URL('./update-data.ts', import.meta.url).href)};
      console.log(JSON.stringify([normalizeTemaDate('Sep 30 2026'), normalizeTemaDate('September 29, 2026'), isoFromDateLabel('Jun 04 2026'), new Date().getTimezoneOffset()]));`;
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const result = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, TZ: zone }, stdout: 'pipe', stderr: 'pipe' });
      const [first, second, third, offset] = JSON.parse(result.stdout.toString());
      expect([first, second, third]).toEqual(['2026-09-30', '2026-09-29', '2026-06-04']);
      expect(offset).not.toBe(0);
    }
  });
});

// ===========================================================================
describe('pipeline', () => {
  test('a run writes the static feed, a second identical run changes no byte, a failing provider keeps the fund', async () => {
    await withFeed(async (directory) => {
      const config = feedConfig(directory, { TICKERS: 'VOLT', EDGAR_FALLBACK: 'true' });
      let secRequests = 0;
      const sec = { fetch: async () => { secRequests += 1; return new Response('unexpected SEC request', { status: 403 }); } };
      const clients = { ...healthy(['VOLT']), sec };
      const first = await runUpdater(config, clients);
      expect(first).toMatchObject({ catalogCount: 1, selectedCount: 1, updatedCount: 1, failures: 0, holdings: 3, history: 29 });
      expect(secRequests).toBe(0);
      expect((await readIndex(directory)).funds[0]).toMatchObject({ ticker: 'VOLT', holdings: 3, history: 29, dataFile: './funds/VOLT/meta.json' });
      const meta = await readMeta(directory, 'VOLT');
      expect(meta.holdings.pages).toEqual(['holdings/001.json']);
      expect(meta.source.holdingsDownload).toBe(csvUrlFor('VOLT'));
      const published = await treeSnapshot(directory);

      await backdate(directory);
      expect((await runUpdater(config, clients)).updatedCount).toBe(1);
      expect(await treeSnapshot(directory)).toBe(published);
      expect(await touchedFiles(directory)).toEqual([]);

      const outage = { issuer: issuerFor(['VOLT'], { down: true }), yahoo: downClient, sec: downClient };
      expect(await runUpdater(feedConfig(directory, { TICKERS: 'VOLT' }), outage)).toMatchObject({ selectedCount: 1, updatedCount: 0, skippedCount: 1, failures: 0, holdings: 3, history: 29 });
      expect(await treeSnapshot(directory)).toBe(published);
    });
  });

  test('Yahoo down while the page is up keeps the whole fund (no new NAV next to stale returns)', async () => {
    await withFeed(async (directory) => {
      await runUpdater(feedConfig(directory, { TICKERS: 'VOLT' }), healthy(['VOLT']));
      const published = await treeSnapshot(directory);
      const moved = { fetch: async (input: string | URL) => okResponse((await (await issuerFor(['VOLT']).fetch(input)).text()).replace('$35.81', '$99.99')) };
      const summary = await runUpdater(feedConfig(directory, { TICKERS: 'VOLT' }), { issuer: moved, yahoo: downClient, sec: downClient });
      expect(summary).toMatchObject({ updatedCount: 0, skippedCount: 1, failures: 0 });
      expect(await treeSnapshot(directory)).toBe(published);
    });
  });

  test('a one-ticker run keeps every other row and file, even when the provider is down', async () => {
    await withFeed(async (directory) => {
      const tickers = ['AAA', 'BBB', 'CCC'];
      await runUpdater(feedConfig(directory), healthy(tickers));
      expect((await readIndex(directory)).funds.map((row: { ticker: string }) => row.ticker)).toEqual(tickers);
      const others = async () => JSON.stringify([await readMeta(directory, 'BBB'), await readMeta(directory, 'CCC')]);
      const before = await others();
      await runUpdater(feedConfig(directory, { TICKERS: 'AAA' }), healthy(tickers));
      expect((await readIndex(directory)).funds).toHaveLength(3);
      await runUpdater(feedConfig(directory, { TICKERS: 'AAA' }), { issuer: issuerFor(tickers, { down: true }), yahoo: downClient, sec: downClient });
      expect((await readIndex(directory)).funds).toHaveLength(3);
      expect(await others()).toBe(before);
    });
  });

  test('a fund without funds/<T>/meta.json gets dataFile null and the full metrics keys; funds with meta stay listed', async () => {
    await withFeed(async (directory) => {
      await runUpdater(feedConfig(directory, { TICKERS: 'AAA' }), healthy(['AAA', 'BBB']));
      const funds = (await readIndex(directory)).funds;
      expect(funds.find((row: { ticker: string }) => row.ticker === 'AAA').dataFile).toBe('./funds/AAA/meta.json');
      const blank = funds.find((row: { ticker: string }) => row.ticker === 'BBB');
      expect(blank.dataFile).toBeNull();
      expect(Object.keys(blank.metrics)).toEqual(Object.keys(funds.find((row: { ticker: string }) => row.ticker === 'AAA').metrics));
      expect(Object.values(blank.metrics).filter((value) => value === null)).toHaveLength(13);
      expect(blank.metrics.returnsBasis).toBe(RETURNS_BASIS);
      const index = await readIndex(directory);
      index.funds = index.funds.filter((row: { ticker: string }) => row.ticker !== 'AAA');
      await writeJsonIfChanged(join(directory, 'index.json'), index);
      await runUpdater(feedConfig(directory, { TICKERS: 'BBB' }), healthy(['BBB']));
      expect((await readIndex(directory)).funds.map((row: { ticker: string }) => row.ticker)).toEqual(['AAA', 'BBB']);
    });
  });

  test('an unknown TICKERS entry is an error before any write', async () => {
    await withFeed(async (directory) => {
      await runUpdater(feedConfig(directory), healthy(['AAA']));
      const before = await treeSnapshot(directory);
      await expect(runUpdater(feedConfig(directory, { TICKERS: 'AAA NOPE' }), healthy(['AAA']))).rejects.toThrow('Unknown TICKERS (not in the Tema catalog): NOPE');
      expect(await treeSnapshot(directory)).toBe(before);
    });
  });

  test('a TICKERS run neither deletes nor moves the MAX_FETCHES cursor, only a full run clears it', async () => {
    await withFeed(async (directory) => {
      await runUpdater(feedConfig(directory, { MAX_FETCHES: '1', CONCURRENCY: '1' }), healthy(['AAA', 'BBB']));
      const statePath = join(directory, 'update-state.json');
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ cursor: 'AAA' });
      await runUpdater(feedConfig(directory, { TICKERS: 'BBB' }), healthy(['AAA', 'BBB']));
      expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ cursor: 'AAA' });
      await runUpdater(feedConfig(directory), healthy(['AAA', 'BBB']));
      expect(await readFile(statePath, 'utf8').catch(() => 'gone')).toBe('gone');
    });
  });

  test('the soft deadline stops taking funds but still writes the index with every row', async () => {
    expect(SOFT_DEADLINE_MS).toBe(25 * 60_000);
    await withFeed(async (directory) => {
      await runUpdater(feedConfig(directory), healthy(['AAA', 'BBB']));
      const published = await treeSnapshot(directory);
      const summary = await runUpdater(feedConfig(directory), healthy(['AAA', 'BBB']), { deadlineMs: 0 });
      expect(summary).toMatchObject({ selectedCount: 2, updatedCount: 0, skippedCount: 2 });
      expect(await treeSnapshot(directory)).toBe(published);
    });
  });

  test('allFundsFailed is true only when something was selected and every fund failed; catalog entries are retained', () => {
    const summary = { catalogCount: 3, selectedCount: 2, updatedCount: 0, skippedCount: 0, failures: 2, holdings: 0, history: 0 };
    expect([allFundsFailed(summary), allFundsFailed({ ...summary, updatedCount: 1, failures: 1 }), allFundsFailed({ ...summary, selectedCount: 0, failures: 0 })]).toEqual([true, false, false]);
    expect(retainCatalogEntries(
      [{ ticker: 'VOLT', name: 'VOLT', fundPage: 'https://temaetfs.com/volt' }],
      [{ ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' }, { ticker: 'OLDX', name: 'Former Tema ETF', fundPage: 'https://temaetfs.com/oldx' }],
    ).map((fund) => [fund.ticker, fund.name])).toEqual([['OLDX', 'Former Tema ETF'], ['VOLT', 'VOLT Electrification ETF']]);
  });

  test('N-PORT freshness: an older filing never replaces published holdings, a newer one fills a fund without data', async () => {
    expect(nportIsNewerThanPublished('2026-05-31', '2026-09-30')).toBe(false);
    expect(nportIsNewerThanPublished('2026-09-30', 'Sep 30 2026')).toBe(false);
    expect(nportIsNewerThanPublished('2026-12-31', 'Sep 30 2026', '', undefined)).toBe(true);
    expect(nportIsNewerThanPublished('2026-05-31')).toBe(true);
    expect(nportIsNewerThanPublished('not a date', '2020-01-01')).toBe(false);
    expect([nportBelongsToTema({ regCik: '0001944285' }), nportBelongsToTema({ regCik: '0000000123' })]).toEqual([true, false]);
    await withFeed(async (directory) => {
      await runUpdater(feedConfig(directory, { TICKERS: 'VOLT', EDGAR_FALLBACK: 'true' }), healthy(['VOLT']));
      const published = await treeSnapshot(directory);
      const outage = { issuer: issuerFor(['VOLT'], { down: true }), yahoo: downClient, sec: nportClient('2026-05-31') };
      expect(await runUpdater(feedConfig(directory, { TICKERS: 'VOLT', EDGAR_FALLBACK: 'true' }), outage)).toMatchObject({ updatedCount: 0, skippedCount: 1, failures: 0 });
      expect(await treeSnapshot(directory)).toBe(published);
      const meta = await readMeta(directory, 'VOLT');
      expect([meta.holdings.asOfDate, meta.aum.value]).toEqual(['2026-09-29', 734149760]);
      // the official page is up but its CSV is gone: an older N-PORT still must not replace the published holdings
      const csvGone = { issuer: issuerFor(['VOLT'], { csvGone: true }), yahoo: yahooFor(dailyChart('2026-09-01', 29)), sec: nportClient('2026-05-31') };
      expect(await runUpdater(feedConfig(directory, { TICKERS: 'VOLT', EDGAR_FALLBACK: 'true' }), csvGone)).toMatchObject({ updatedCount: 0, skippedCount: 1 });
      expect(await treeSnapshot(directory)).toBe(published);
    });
    await withFeed(async (directory) => {
      const outage = { issuer: issuerFor(['VOLT'], { down: true }), yahoo: downClient, sec: nportClient('2026-05-31') };
      expect(await runUpdater(feedConfig(directory, { TICKERS: 'VOLT', EDGAR_FALLBACK: 'true' }), outage)).toMatchObject({ updatedCount: 1, failures: 0 });
      const meta = await readMeta(directory, 'VOLT');
      expect(meta.holdings.source).toContain('N-PORT');
      expect(meta.holdings.totalRows).toBe(1);
    });
  });

  test('a shorter HISTORY_RANGE drops long-horizon returns instead of keeping old values under the new date', async () => {
    await withFeed(async (directory) => {
      const run = (chart: unknown, env: Record<string, string>) => runUpdater(feedConfig(directory, { TICKERS: 'VOLT', ...env }), { issuer: issuerFor(['VOLT']), yahoo: yahooFor(chart), sec: downClient });
      await run(dailyChart('2023-01-01', 1370), {});
      const longRow = (await readIndex(directory)).funds[0];
      expect(longRow.metrics.tr3y).not.toBeNull();
      await run(dailyChart('2025-10-01', 365), { HISTORY_RANGE: '1y' });
      const row = (await readIndex(directory)).funds[0];
      expect([row.metrics.tr3y, row.metrics.cagr3y, row.returns.monthEnd.yr3, row.metrics.tr1y]).toEqual([null, null, null, null]);
      expect(row.metrics.performanceAsOf).toBe(longRow.metrics.performanceAsOf);
    });
  });

  test('a TER the source stops publishing becomes null, SKIP_YAHOO carries returns and history untouched', async () => {
    await withFeed(async (directory) => {
      const chart = dailyChart('2023-01-01', 1370);
      await runUpdater(feedConfig(directory, { TICKERS: 'VOLT' }), healthy(['VOLT'], chart));
      expect((await readIndex(directory)).funds[0].terValue).toBe(0.75);
      const before = await readMeta(directory, 'VOLT');
      await runUpdater(feedConfig(directory, { TICKERS: 'VOLT', SKIP_YAHOO: 'true' }), { issuer: issuerFor(['VOLT']), yahoo: downClient, sec: downClient });
      const after = await readMeta(directory, 'VOLT');
      expect([after.returns, after.history]).toEqual([before.returns, before.history]);
      await runUpdater(feedConfig(directory, { TICKERS: 'VOLT' }), { issuer: issuerFor(['VOLT'], { ter: null }), yahoo: yahooFor(chart), sec: downClient });
      const row = (await readIndex(directory)).funds[0];
      expect([row.terValue, row.ter]).toEqual([null, '—']);
    });
  });

  test('stale history pages are removed after the new meta.json lists the new ones', async () => {
    await withFeed(async (directory) => {
      const run = (chart: unknown) => runUpdater(feedConfig(directory, { TICKERS: 'AAA', HISTORY_PAGE_SIZE: '10' }), { issuer: issuerFor(['AAA']), yahoo: yahooFor(chart), sec: downClient });
      await run(dailyChart('2026-08-01', 29));
      expect((await readdir(join(directory, 'funds', 'AAA', 'history'))).sort()).toEqual(['001.json', '002.json', '003.json']);
      await run(dailyChart('2026-09-10', 20));
      expect((await readdir(join(directory, 'funds', 'AAA', 'history'))).sort()).toEqual(['001.json', '002.json']);
      expect((await readMeta(directory, 'AAA')).history.pages).toEqual(['history/001.json', 'history/002.json']);
    });
  });

  test('JSON writes ignore run timestamps, keep the previous stamp on stable reruns and leave no temp files', async () => {
    expect(samePublishedContent({ generatedAt: 'one', source: { url: '/funds', catalogReadAt: 'old' }, items: [{ z: 1, generatedAt: 'nested' }] },
      { items: [{ generatedAt: 'new', z: 1 }], source: { catalogReadAt: 'fresh', url: '/funds' }, generatedAt: 'two' })).toBe(true);
    const directory = await mkdtemp(join(tmpdir(), 'tema-write-'));
    try {
      const path = join(directory, 'index.json');
      expect(await writeJsonIfChanged(path, { generatedAt: 'first', source: { url: '/funds' } })).toBe(true);
      const original = await readFile(path, 'utf8');
      expect(await writeJsonIfChanged(path, { generatedAt: 'second', source: { url: '/funds' } })).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(original);
      expect(await writeJsonIfChanged(path, { generatedAt: 'third', source: { url: '/changed' } })).toBe(true);
      expect((await readdir(directory)).sort()).toEqual(['index.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
describe('network', () => {
  const client = (fetchImpl: FetchFunction, extra: Record<string, unknown> = {}) =>
    createPacedHttpClient({ gate: { pace: async () => undefined }, retries: 1, userAgent: 'test', sleep: async () => undefined, fetchImpl, ...extra });

  test('429 is retried honouring Retry-After, the user agent is kept, each attempt is paced, bounded backoff for network errors', async () => {
    const responses = [new Response('busy', { status: 429, headers: { 'retry-after': '2' } }), new Response('ready', { status: 200 })];
    const waits: number[] = [];
    const userAgents: Array<string | null> = [];
    let paced = 0;
    const retrying = createPacedHttpClient({
      gate: { pace: async () => { paced += 1; } }, retries: 1, userAgent: 'Tema test runner example@example.com',
      fetchImpl: async (_input, init) => { userAgents.push(new Headers(init?.headers).get('user-agent')); return responses.shift()!; },
      sleep: async (milliseconds) => { waits.push(milliseconds); }, now: () => 0,
    });
    expect((await retrying.fetch('https://example.test/data')).status).toBe(200);
    expect([paced, waits, userAgents]).toEqual([2, [2000], ['Tema test runner example@example.com', 'Tema test runner example@example.com']]);

    let requests = 0;
    const flaky = createPacedHttpClient({
      gate: { pace: async () => undefined }, retries: 1, userAgent: 'test',
      fetchImpl: async () => { requests += 1; if (requests === 1) throw new Error('temporary network failure'); return new Response('ok', { status: 200 }); },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    });
    expect((await flaky.fetch('https://example.test/data')).status).toBe(200);
    expect([requests, waits.at(-1)]).toEqual([2, 500]);
    expect([isRetryableHttpStatus(429), isRetryableHttpStatus(503), isRetryableHttpStatus(403)]).toEqual([true, true, false]);
    expect(retryDelayMilliseconds('Wed, 21 Oct 2015 07:28:02 GMT', 0, Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(2000);
  });

  test('retries are bounded and a failure never echoes the query string', async () => {
    let attempts = 0;
    const denied = client((async () => { attempts += 1; return new Response('denied', { status: 403 }); }) as unknown as typeof fetch, { retries: 0 });
    await expect(responseText(denied, 'https://example.test/private?token=must-not-leak')).rejects.toThrow('HTTP 403 for example.test/private');
    expect(attempts).toBe(1);
    attempts = 0;
    const busy = client((async () => { attempts += 1; return new Response('busy', { status: 503 }); }) as unknown as typeof fetch, { retries: 2 });
    await expect(responseText(busy, 'https://example.test/x')).rejects.toThrow();
    expect(attempts).toBe(3);
  });

  test('the timeout covers the headers and the body: a stalled request or body is retried, then fails', async () => {
    let attempts = 0;
    const silent = client((() => { attempts += 1; return new Promise<Response>(() => undefined); }) as unknown as typeof fetch, { timeoutMs: 20 });
    await expect(responseText(silent, 'https://example.test/slow?token=secret')).rejects.toThrow(/timed out after 0s for example\.test\/slow$/);
    expect(attempts).toBe(2);
    attempts = 0;
    const stalled = client((async () => {
      attempts += 1;
      if (attempts === 1) return new Response(new ReadableStream({ start() { /* never enqueues, never closes */ } }), { status: 200 });
      return new Response('complete body', { status: 200 });
    }) as unknown as typeof fetch, { timeoutMs: 30 });
    expect(await responseText(stalled, 'https://example.test/stall')).toBe('complete body');
    expect(attempts).toBe(2);
  });

  test('in-flight peak is 1 at CONCURRENCY=1 and N at CONCURRENCY=N (offline counter)', async () => {
    const tickers = ['AAA', 'BBB', 'CCC'];
    const run = async (concurrency: number): Promise<number> => {
      let inFlight = 0, peak = 0;
      const base = issuerFor(tickers);
      const chart = JSON.stringify(dailyChart('2026-09-01', 29));
      const counting = (async (input: string | URL) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        try {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          return String(input).includes('finance/chart') ? okResponse(chart, 'application/json') : await base.fetch(input);
        } finally { inFlight -= 1; }
      }) as unknown as typeof fetch;
      await withFeed(async (directory) => {
        const config = feedConfig(directory, { CONCURRENCY: String(concurrency) });
        expect(await runUpdater(config, createProviderHttpClients(config, counting))).toMatchObject({ updatedCount: 3, failures: 0 });
      });
      return peak;
    };
    expect(await run(1)).toBe(1);
    expect(await run(3)).toBe(3);
  });

  test('request lanes pace independently: callers of different lanes start together, a lane waits one sleep', async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = createRequestGate(2, 10, () => clock, async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; });
    await Promise.all([gate.pace(), gate.pace(), gate.pace(), gate.pace()]);
    expect(waits).toEqual([10]);
    let rejectSleep = true;
    const recovery = createRequestGate(1, 5, () => 0, async () => { if (rejectSleep) { rejectSleep = false; throw new Error('simulated lane delay failure'); } });
    await recovery.pace();
    await expect(recovery.pace()).rejects.toThrow('simulated lane delay failure');
    await recovery.pace();
  });

  test('HISTORY_RANGE reaches the Yahoo request as explicit period1/period2', async () => {
    const max = new URL(yahooChartUrl('VOLT', 'max', 20_000));
    expect([max.pathname, max.searchParams.get('period1'), max.searchParams.get('period2'), max.searchParams.get('interval'), max.searchParams.has('range')]).toEqual(['/v8/finance/chart/VOLT', '0', '20000', '1d', false]);
    expect(new URL(yahooChartUrl('VOLT', '10y', 20_000)).searchParams.get('period1')).toBe(String(Math.floor(20_000 - 10 * 365.25 * 86_400)));
    await withFeed(async (directory) => {
      const urls: string[] = [];
      await runUpdater(feedConfig(directory, { TICKERS: 'VOLT', HISTORY_RANGE: '5y' }), { issuer: issuerFor(['VOLT']), yahoo: yahooFor(dailyChart('2026-09-01', 29), urls), sec: downClient });
      const [period1, period2] = ['period1', 'period2'].map((name) => Number(new URL(urls[0]).searchParams.get(name)));
      expect(period1).toBeGreaterThan(0);
      expect(Math.round((period2 - period1) / 86_400 / 365.25)).toBe(5);
    });
  });
});
