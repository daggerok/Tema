/// <reference types="bun" />

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  CONTROL_NAMES,
  resolveControls,
  runtimeControls,
  buildPages,
  buildIndexDocument,
  buildPageManifest,
  buildTemaFundMeta,
  formatTemaMoney,
  formatTemaPercent,
  indexFundFromMeta,
  mergePublishedFallback,
  yahooDistributionRows,
  yahooHistoryRows,
  createNportResolver,
  createPacedHttpClient,
  filterFundFromIndex,
  hasDataDependentFilters,
  main,
  outputHasOutputFilters,
  outputPrintConfig,
  outputPrintFilter,
  printHelp,
  updaterHelpText,
  createRequestGate,
  isRetryableHttpStatus,
  decodeTemaCsv,
  deriveTemaMetrics,
  edgarSeriesFilingsUrl,
  fillNportTickers,
  inferDistributionFrequency,
  envValue,
  findTemaHoldingsCsvUrl,
  minimalIndexFund,
  normalizeTemaDate,
  nportUrlFor,
  nportSeriesMatchesFund,
  resolveTemaNportSeriesRef,
  outputContentKey,
  outputCount,
  outputFundLine,
  outputMoney,
  outputStable,
  pageFileNames,
  parseAumBound,
  parseCsv,
  parseDecimal,
  parsePositiveInt,
  parseRanges,
  parseTemaFundPage,
  parseTemaCatalog,
  parseTemaHoldingsCsv,
  parseCompanyTickerMap,
  parseTemaFundTickerTable,
  parseNport,
  parseNportAccessions,
  passesStaticFundFilters,
  parseEdgarAtomFilings,
  SEC_COMPANY_TICKERS_MF_URL,
  SEC_SUBMISSIONS_URL,
  parseYahooChart,
  yahooChartUrl,
  retainCatalogEntries,
  selectUpdateBatch,
  writeFundPages,
  passesFundFilters,
  passesRange,
  readUpdaterConfig,
  responseText,
  retryDelayMilliseconds,
  runUpdater,
  samePublishedContent,
  shiftIsoDate,
  writeJsonIfChanged,
} from './update-data.ts';

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

describe('parseCsv', () => {
  test('supports CRLF, quoted commas, doubled quotes, embedded newlines and a UTF-8 BOM', () => {
    const csv = '\uFEFFname,value\r\n"ACME, Inc.","said ""hello"""\r\n"line one\nline two",0\r\n';
    expect(parseCsv(csv)).toEqual([
      ['name', 'value'],
      ['ACME, Inc.', 'said "hello"'],
      ['line one\nline two', '0'],
    ]);
  });

  test('rejects an unterminated quoted cell', () => {
    expect(() => parseCsv('name,value\n"unfinished,1')).toThrow('unterminated');
  });
});

describe('Tema fund catalog parsing', () => {
  test('keeps unique ticker routes, chooses the descriptive ETF label, and drops NEW badges', () => {
    const html = `
      <a href="/about-us">About Us</a>
      <a href="https://temaetfs.com/volt">VOLT</a>
      <a href="https://temaetfs.com/volt">VOLT Electrification ETF</a>
      <a href="/dice">DICE</a>
      <a href="/dice">DICE (NEW) Trading &amp; Prediction Markets ETF</a>
      <a href="/prvt">PRVT</a>
      <a href="/funds">ETF list</a>
      <a href="/education">ETF Education</a>
    `;
    expect(parseTemaCatalog(html)).toEqual([
      { ticker: 'DICE', name: 'DICE Trading & Prediction Markets ETF', fundPage: 'https://temaetfs.com/dice' },
      { ticker: 'PRVT', name: 'PRVT', fundPage: 'https://temaetfs.com/prvt' },
      { ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' },
    ]);
  });

  test('resolves the dated CSV link and decodes HTML ampersands without dropping query parameters', () => {
    const html = '<a href="https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv?v=68473&amp;temaHoldingsCacheBuster=1">Download Holdings (CSV)</a>';
    expect(findTemaHoldingsCsvUrl(html, 'VOLT', 'https://temaetfs.com/volt')).toBe(
      'https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv?v=68473&temaHoldingsCacheBuster=1',
    );
  });

  test('rejects non-Tema or non-CSV download links', () => {
    expect(() => findTemaHoldingsCsvUrl('<a href="https://example.com/VOLT.csv">CSV</a>', 'VOLT', 'https://temaetfs.com/volt')).toThrow('no official daily holdings CSV');
    expect(() => findTemaHoldingsCsvUrl('<a href="/hubfs/Website/Holdings/ARMY-holdings-01012026.csv">CSV</a>', 'VOLT', 'https://temaetfs.com/volt')).toThrow('no official daily holdings CSV');
  });
});

describe('Tema holdings CSV mapping', () => {
  test('maps the dated official VOLT fixture into the shared holdings contract', () => {
    const parsed = parseTemaHoldingsCsv(holdingsFixture);
    expect(parsed.asOfDate).toBe('2026-09-29');
    expect(parsed.totalRows).toBe(3);
    expect(parsed.sourceHeaders).toEqual([
      'holdings_date', 'ticker', 'cusip', 'proper_name', 'shares', 'market_value',
      'percent_of_nav', 'is_cash', 'country', 'sector',
    ]);
    expect(parsed.headers).toContain('Weight');
    expect(parsed.rows[0]).toEqual({
      Name: 'BEL FUSE INC',
      Ticker: 'BELFB',
      Identifier: '077347300',
      Weight: '6.71',
      'Market Value': '48804958.64',
      'Shares Held': '199922',
      'Asset Category': 'Information Technology',
      Country: 'United States',
      Sector: 'Information Technology',
      Cash: 'No',
    });
    expect(parsed.rows[1].Weight).toBe('6.68');
  });

  test('maps reordered headers and ignores unknown columns while preserving zero and negative numbers', () => {
    const csv = [
      'sector,percent_of_nav,custom,proper_name,is_cash,market_value,holdings_date,ticker,cusip,country,shares',
      'Cash,-0.0005,ignored,CASH COLLATERAL,1,0,2026-09-29,,CASH,United States,-2',
    ].join('\n');
    const parsed = parseTemaHoldingsCsv(csv);
    expect(parsed.totalRows).toBe(1);
    expect(parsed.rows[0]).toEqual({
      Name: 'CASH COLLATERAL',
      Ticker: '',
      Identifier: 'CASH',
      Weight: '-0.05',
      'Market Value': '0',
      'Shares Held': '-2',
      'Asset Category': 'Cash',
      Country: 'United States',
      Sector: 'Cash',
      Cash: 'Yes',
    });
  });

  test('ignores empty trailing lines but retains a named holding without an exchange ticker', () => {
    const csv = `${[
      'holdings_date,ticker,cusip,proper_name,shares,market_value,percent_of_nav,is_cash,country,sector',
      '2026-09-29,,CASH,Cash and Other,1,1234,0.001,1,United States,Cash',
      ',,,,,,,,',
    ].join('\n')}\n`;
    const parsed = parseTemaHoldingsCsv(csv);
    expect(parsed.totalRows).toBe(1);
    expect(parsed.rows[0].Ticker).toBe('');
    expect(parsed.rows[0].Identifier).toBe('CASH');
  });

  test('rejects missing required columns and a missing/invalid holdings date', () => {
    expect(() => parseTemaHoldingsCsv('ticker,proper_name\nVOLT,Tema')).toThrow('missing required columns');
    const noDate = holdingsFixture.replaceAll('2026-09-29', 'not-a-date');
    expect(() => parseTemaHoldingsCsv(noDate)).toThrow('no valid holdings_date');
  });
});

describe('Tema fund-page metadata parsing', () => {
  test('reads the official details/price blocks and maps source values without extra rows', () => {
    expect(parseTemaFundPage(fundPageFixture, 'VOLT', 'VOLT Electrification ETF')).toEqual({
      ticker: 'VOLT',
      name: 'VOLT Electrification ETF',
      cusip: '87975E834',
      inceptionDate: 'Dec 03 2024',
      ter: '0.75%',
      terValue: 0.75,
      aum: '$734,149,760',
      aumValue: 734149760,
      exchange: 'Nasdaq',
      sharesOutstanding: 20500000,
      holdingsCount: 27,
      nav: '$35.81',
      navValue: 35.81,
      closePrice: '$35.85',
      closePriceValue: 35.85,
      premiumDiscount: '0.11%',
      premiumDiscountValue: 0.11,
      asOfDate: 'Sep 29 2026',
    });
  });

  test('uses the page heading when the catalog exposes only a bare ticker label', () => {
    expect(parseTemaFundPage(fundPageFixture, 'VOLT', 'VOLT').name).toBe('Tema Electrification ETF');
  });

  test('rejects a fund-page ticker that does not match the requested catalog ticker', () => {
    expect(() => parseTemaFundPage(fundPageFixture, 'ARMY')).toThrow('fund page identifies itself as VOLT');
  });
});

describe('Tema holdings date normalization', () => {
  test('date offsets clamp leap-day/month-end dates instead of rolling into the next month', () => {
    expect(shiftIsoDate('2024-02-29', -1, 0)).toBe('2023-02-28');
    expect(shiftIsoDate('2026-03-31', 0, -1)).toBe('2026-02-28');
  });

  test.each([
    ['2026-09-29', '2026-09-29'],
    ['09/29/2026', '2026-09-29'],
    ['12/03/24', '2024-12-03'],
    ['09292026', '2026-09-29'],
    ['2026-02-30', ''],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTemaDate(input)).toBe(expected);
  });
});

describe('Tema updater configuration and filters', () => {
  test('uses conservative defaults and empty filters', () => {
    const config = readUpdaterConfig({});
    expect(config).toMatchObject({
      maxFetches: 0,
      requestSleepSeconds: 1,
      concurrency: 2,
      maxRetries: 2,
      holdingsPageSize: 250,
      historyPageSize: 1000,
      historyRange: 'max',
      tickers: [],
      categories: [],
      edgarFallback: true,
      skipYahoo: false,
    });
    expect(config.outputDir.endsWith('/api/tema')).toBe(true);
    expect(config.aumRange).toEqual({ min: null, max: null, source: ':' });
    expect(config.performanceRanges['10Y']).toEqual({ min: null, max: null, source: ':' });
  });

  test('reads environment aliases, ticker/category lists and output directory', () => {
    const config = readUpdaterConfig({
      TEMA_LIMIT: '5',
      REQUEST_SLEEP: '0.25',
      CONCURRENCY: '3',
      MAX_RETRIES: '1',
      TICKERS: 'volt, army;DSPY',
      CATEGORY: 'equity, fixed income',
      AUM: 'micro',
      TER: ':0.75',
      DIVIDEND_YIELD: '1.5:',
      SEC_YIELD: ':5',
      PERFORMANCE_YTD: '-2:25',
      TOTAL_RETURN_3Y: '10:',
      EDGAR_FALLBACK: 'off',
      SKIP_YAHOO: 'true',
      HOLDINGS_PAGE_SIZE: '100',
      HISTORY_PAGE_SIZE: '365',
      HISTORY_RANGE: '5y',
      SEC_UA: 'Tema test contact@example.com',
      OUTPUT_DIR: 'isolated/api/tema',
    });
    expect(config).toMatchObject({
      maxFetches: 5,
      requestSleepSeconds: 0.25,
      concurrency: 3,
      maxRetries: 1,
      tickers: ['VOLT', 'ARMY', 'DSPY'],
      categories: ['equity', 'fixed income'],
      aumRange: { min: 10_000_000, max: 300_000_000 },
      terRange: { min: null, max: 0.75 },
      dividendYieldRange: { min: 1.5, max: null },
      secYieldRange: { min: null, max: 5 },
      performanceRanges: { YTD: { min: -2, max: 25 } },
      totalReturnRanges: { '3Y': { min: 10, max: null } },
      edgarFallback: false,
      skipYahoo: true,
      holdingsPageSize: 100,
      historyPageSize: 365,
      historyRange: '5y',
      secUserAgent: 'Tema test contact@example.com',
    });
    expect(config.outputDir.endsWith('/isolated/api/tema')).toBe(true);
  });

  test('validates integer, decimal, range and AUM-bound syntax', () => {
    expect(parsePositiveInt(undefined, 7)).toBe(7);
    expect(parsePositiveInt('0', 7, true)).toBe(0);
    expect(parsePositiveInt('4', 7)).toBe(4);
    expect(() => parsePositiveInt('1.5', 7)).toThrow('integer');
    expect(() => parsePositiveInt('0', 7)).toThrow('positive integer');
    expect(parseDecimal('0.5', 1)).toBe(0.5);
    expect(() => parseDecimal('-1', 1)).toThrow('non-negative decimal');
    expect(parseAumBound('$1.25B')).toBe(1_250_000_000);
    expect(parseAumBound('300M')).toBe(300_000_000);
    expect(() => parseAumBound('many')).toThrow('invalid AUM bound');
    expect(() => readUpdaterConfig({ TER: '0.2' })).toThrow('MIN:MAX');
    expect(() => readUpdaterConfig({ TER: '1:0.1' })).toThrow('minimum exceeds maximum');
    expect(() => readUpdaterConfig({ HISTORY_RANGE: '10d' })).toThrow('HISTORY_RANGE must be max or a number of years');
  });

  test('expands all AUM presets and maps every return tenor to a numeric range', () => {
    const preset = (aum: string) => readUpdaterConfig({ AUM: aum }).aumRange;
    expect(preset('nano')).toEqual({ min: null, max: 10_000_000, source: 'nano' });
    expect(preset('micro')).toMatchObject({ min: 10_000_000, max: 300_000_000 });
    expect(preset('small')).toMatchObject({ min: 300_000_000, max: 2_000_000_000 });
    expect(preset('mid')).toMatchObject({ min: 2_000_000_000, max: 10_000_000_000 });
    expect(preset('large')).toMatchObject({ min: 10_000_000_000, max: null });
    const ranges = parseRanges({
      PERFORMANCE_YTD: '0:1', PERFORMANCE_1Y: '1:2', PERFORMANCE_3Y: '3:4',
      PERFORMANCE_5Y: '5:6', PERFORMANCE_10Y: '10:11',
    }, 'PERFORMANCE');
    expect(ranges).toEqual({
      YTD: { min: 0, max: 1, source: '0:1' },
      '1Y': { min: 1, max: 2, source: '1:2' },
      '3Y': { min: 3, max: 4, source: '3:4' },
      '5Y': { min: 5, max: 6, source: '5:6' },
      '10Y': { min: 10, max: 11, source: '10:11' },
    });
  });

  test('handles open-ended, inclusive, zero, negative, and missing range values', () => {
    const config = readUpdaterConfig({ TICKERS: 'VOLT DSPY', CATEGORY: 'equity', AUM: '10M:1B', TER: '0:0.75' });
    expect(passesRange(0, { min: 0, max: null, source: '0:' })).toBe(true);
    expect(passesRange(-1, { min: -1, max: 0, source: '-1:0' })).toBe(true);
    expect(passesRange(null, { min: 0, max: 1, source: '0:1' })).toBe(false);
    expect(passesFundFilters({ ticker: 'VOLT', category: 'Equity', aumValue: 100_000_000, terValue: 0.75 }, config)).toBe(true);
    expect(passesFundFilters({ ticker: 'ARMY', category: 'Equity', aumValue: 100_000_000, terValue: 0.5 }, config)).toBe(false);
    expect(passesFundFilters({ ticker: 'DSPY', category: 'Fixed Income', aumValue: 100_000_000, terValue: 0.5 }, config)).toBe(false);
    expect(passesFundFilters({ ticker: 'VOLT', category: 'Equity', aumValue: null, terValue: 0.5 }, config)).toBe(false);
  });

  test('canonical environment variable takes precedence over aliases', () => {
    expect(envValue({ MAX_FETCHES: '2', TEMA_LIMIT: '9' }, 'MAX_FETCHES', ['TEMA_LIMIT'])).toBe('2');
    expect(envValue({ MAX_FETCHES: '  ', TEMA_LIMIT: '9' }, 'MAX_FETCHES', ['TEMA_LIMIT'])).toBe('9');
  });
});

describe('Tema output, paging, and stable writes', () => {
  test('builds deterministic JSON pages and one-based three-digit page file names', () => {
    const pages = buildPages('VOLT', ['Ticker'], ['A', 'B', 'C', 'D', 'E'], 2);
    expect(pages.map(page => [page.page, page.pageSize, page.totalRows, page.rows])).toEqual([
      [1, 2, 5, ['A', 'B']],
      [2, 2, 5, ['C', 'D']],
      [3, 2, 5, ['E']],
    ]);
    expect(pageFileNames('holdings', pages.length)).toEqual(['holdings/001.json', 'holdings/002.json', 'holdings/003.json']);
    expect(buildPages('VOLT', [], [], 2)).toEqual([]);
    expect(() => buildPages('VOLT', [], [], 0)).toThrow('positive integer');
  });

  test('recursively sorts objects and ignores only embedded run timestamps for comparisons', () => {
    const left = { generatedAt: 'one', source: { url: '/funds', catalogReadAt: 'old', name: 'Tema' }, items: [{ z: 1, generatedAt: 'nested' }] };
    const right = { items: [{ generatedAt: 'new', z: 1 }], source: { name: 'Tema', catalogReadAt: 'fresh', url: '/funds' }, generatedAt: 'two' };
    expect(samePublishedContent(left, right)).toBe(true);
    expect(outputStable(left)).toEqual({ items: [{ z: 1 }], source: { name: 'Tema', url: '/funds' } });
    expect(samePublishedContent(left, { ...right, source: { ...right.source, url: '/other' } })).toBe(false);
    expect(outputContentKey({ b: 1, a: 2 })).toBe(outputContentKey({ a: 2, b: 1 }));
  });

  test('writes only meaningful JSON changes and keeps the previous timestamp on stable reruns', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tema-write-test-'));
    const path = join(directory, 'index.json');
    try {
      expect(await writeJsonIfChanged(path, { generatedAt: 'first', source: { url: '/funds', catalogReadAt: 'first' } })).toBe(true);
      const original = await readFile(path, 'utf8');
      expect(await writeJsonIfChanged(path, { generatedAt: 'second', source: { catalogReadAt: 'second', url: '/funds' } })).toBe(false);
      expect(await readFile(path, 'utf8')).toBe(original);
      expect(await writeJsonIfChanged(path, { generatedAt: 'third', source: { url: '/changed' } })).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('omits unavailable fields but prints real zero values in the shared updater line', () => {
    const line = outputFundLine(1, 14, 'VOLT', 'updated', { history: 0, holdings: null, distributions: { rows: [['09/01/2026', '0.2'], ['09/15/2026', '0.1']] }, aumValue: null, metrics: { dividendYield: 0, secYield: null } });
    expect(line).toContain('history=0');
    expect(line).toContain('divs=2');
    expect(line).toContain('div=0');
    expect(line).not.toContain('holdings=null');
    expect(line).not.toContain('netAssets=null');
    expect(line).not.toContain('sec=null');
    expect(outputMoney(null)).toBe('null');
    expect(outputMoney(0)).toBe('$0.00');
    expect(outputMoney(1_200_000)).toBe('$1.2M');
    expect(outputCount({ totalRows: 3 })).toBe(3);
    expect(outputCount({ nope: true })).toBe(null);
  });
});

describe('independent request pacing lanes', () => {
  test('uses separate lanes for concurrency and normalizes a rejected lane queue for recovery', async () => {
    let clock = 0;
    const waits: number[] = [];
    const gate = createRequestGate(2, 10, () => clock, async milliseconds => {
      waits.push(milliseconds);
      clock += milliseconds;
    });
    await Promise.all([gate.pace(), gate.pace(), gate.pace(), gate.pace()]);
    expect(waits).toEqual([10]);

    let rejectSleep = true;
    const retryClock = 0;
    const recoveryWaits: number[] = [];
    const recovery = createRequestGate(1, 5, () => retryClock, async milliseconds => {
      recoveryWaits.push(milliseconds);
      if (rejectSleep) {
        rejectSleep = false;
        throw new Error('simulated lane delay failure');
      }
    });
    await recovery.pace();
    await expect(recovery.pace()).rejects.toThrow('simulated lane delay failure');
    await recovery.pace();
    expect(recoveryWaits).toEqual([5, 5]);
  });
});

describe('Tema source encodings and Yahoo chart normalization', () => {
  test('decodes the issuer-advertised x-macroman charset', () => {
    expect(decodeTemaCsv(new Uint8Array([0x8e]), 'text/csv; charset=x-macroman')).toBe('é');
  });

  test('parses Yahoo daily close, adjusted close, metadata, dividends and missing close rows', () => {
    const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
    const parsed = parseYahooChart({ chart: { result: [{
      meta: { longName: 'VOLT ETF', exchangeName: 'Nasdaq', currency: 'USD', regularMarketPrice: 12.345, regularMarketTime: epoch('2026-09-29'), firstTradeDate: epoch('2024-12-03') },
      timestamp: [epoch('2026-09-26'), epoch('2026-09-28'), epoch('2026-09-29')],
      indicators: {
        quote: [{ close: [10.12345678, null, 12.345678], volume: [100, 200, 300] }],
        adjclose: [{ adjclose: [10.124, 50, 12.349] }],
      },
      events: { dividends: { '1788220800': { date: epoch('2026-09-01'), amount: 0.125 } } },
    }] } });
    expect(parsed.longName).toBe('VOLT ETF');
    expect(parsed.exchangeName).toBe('Nasdaq');
    expect(parsed.currency).toBe('USD');
    expect(parsed.days).toEqual([
      { date: '2026-09-26', close: 10.123457, adjClose: 10.12, volume: 100 },
      { date: '2026-09-29', close: 12.345678, adjClose: 12.35, volume: 300 },
    ]);
    expect(parsed.dividends).toEqual([{ date: '2026-09-01', amount: 0.125 }]);
    expect(() => parseYahooChart({ chart: { result: [] } })).toThrow('empty result');
  });

  test('builds time-bounded Yahoo URLs but does not include live URLs in any persisted source helper', () => {
    const max = new URL(yahooChartUrl('VOLT', 'max', 20_000));
    expect(max.pathname).toBe('/v8/finance/chart/VOLT');
    expect(max.searchParams.get('period1')).toBe('0');
    expect(max.searchParams.get('period2')).toBe('20000');
    expect(max.searchParams.get('interval')).toBe('1d');
    expect(max.searchParams.get('events')).toBe('div,splits');
    const tenYears = new URL(yahooChartUrl('VOLT', '10y', 20_000));
    expect(tenYears.searchParams.get('period1')).toBe(String(Math.floor(20_000 - 10 * 365.25 * 86_400)));
  });

  test('derives total-return metrics and dividend yield from dated adjusted-close fixtures', () => {
    const days = [
      { date: '2024-12-31', close: 80, adjClose: 80, volume: 1 },
      { date: '2025-01-02', close: 81, adjClose: 81, volume: 1 },
      { date: '2025-06-30', close: 90, adjClose: 90, volume: 1 },
      { date: '2025-09-29', close: 95, adjClose: 95, volume: 1 },
      { date: '2025-12-31', close: 100, adjClose: 100, volume: 1 },
      { date: '2026-01-02', close: 101, adjClose: 101, volume: 1 },
      { date: '2026-06-30', close: 110, adjClose: 110, volume: 1 },
      { date: '2026-09-29', close: 120, adjClose: 120, volume: 1 },
    ];
    const dividends = [
      { date: '2025-10-01', amount: 1 },
      { date: '2026-04-01', amount: 1 },
      { date: '2026-09-01', amount: 1 },
    ];
    const result = deriveTemaMetrics({ days, dividends, currency: 'USD', exchangeName: 'Nasdaq', longName: 'VOLT', regularMarketPrice: 120, regularMarketTime: null, firstTradeDate: null });
    expect(result.metrics.ytd).toBe(20);
    expect(result.metrics.tr1y).toBe(26.32);
    expect(result.metrics.cagr3y).toBe(null);
    expect(result.dividendYield).toBe(2.5);
    expect(result.latestDividend).toEqual({ date: '2026-09-01', amount: 1 });
    expect(result.frequency).toEqual({ frequency: 'Semi-annually', paymentsPerYear: 2 });
    expect(result.monthEnd.asOfDate).toBe('Jun 30 2026');
    expect(result.quarterEnd.asOfDate).toBe('Jun 30 2026');
  });

  test('keeps absent or insufficient dividend history unknown instead of asserting a zero yield', () => {
    const chart = { days: [{ date: '2026-09-29', close: 10, adjClose: 10, volume: 0 }], dividends: [], exchangeName: '', longName: '', currency: '', regularMarketPrice: 10, regularMarketTime: null, firstTradeDate: null };
    const result = deriveTemaMetrics(chart);
    expect(result.dividendYield).toBe(null);
    expect(result.frequency.frequency).toBe('Unknown');
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'Unknown', paymentsPerYear: null });
    expect(inferDistributionFrequency([{ date: '2026-07-01', amount: 0.2 }, { date: '2026-09-01', amount: 0.25 }])).toEqual({ frequency: 'Unknown', paymentsPerYear: null });
  });
});

describe('Tema SEC N-PORT fallback parsing', () => {
  test('maps only Tema ETF Trust symbols from reordered fund-ticker table fields', () => {
    const payload = {
      fields: ['symbol', 'classId', 'seriesId', 'cik'],
      data: [
        ['VOLT', 'C000239058', 'S000088946', 1944285],
        ['OTHER', 'C000000001', 'S000000001', 1234567],
      ],
    };
    expect(parseTemaFundTickerTable(payload).get('VOLT')).toEqual({ cik: '0001944285', seriesId: 'S000088946', classId: 'C000239058' });
    expect(parseTemaFundTickerTable(payload).has('OTHER')).toBe(false);
  });

  test('parses recent N-PORT accessions and series Atom feed with stable archive URLs', () => {
    const filings = parseNportAccessions({
      cik: '0001944285',
      filings: { recent: {
        form: ['NPORT-P', 'N-1A'],
        accessionNumber: ['0001944285-26-000123', '0001944285-26-000124'],
        filingDate: ['2026-09-29', '2026-09-30'],
        reportDate: ['2026-08-31', ''],
      } },
    });
    expect(filings).toHaveLength(1);
    expect(filings[0]).toEqual({
      accession: '0001944285-26-000123',
      filed: '2026-09-29',
      reportDate: '2026-08-31',
      url: 'https://www.sec.gov/Archives/edgar/data/1944285/000194428526000123/primary_doc.xml',
    });
    expect(nportUrlFor('0001944285', '0001944285-26-000123')).toBe(filings[0].url);
    const atom = `<feed><entry><filing-type>NPORT-P</filing-type><accession-number>0001944285-26-000123</accession-number><filing-date>2026-09-29</filing-date><period>2026-08-31</period><filing-href>https://www.sec.gov/Archives/edgar/data/1944285/000194428526000123/index.htm</filing-href></entry></feed>`;
    expect(parseEdgarAtomFilings(atom)[0].url).toBe(filings[0].url);
    const url = new URL(edgarSeriesFilingsUrl('S000088946'));
    expect(url.searchParams.get('CIK')).toBe('S000088946');
    expect(url.searchParams.get('type')).toBe('NPORT-P');
  });

  test('maps N-PORT XML positions, CUSIP, weights, net assets and issuer tickers', () => {
    const xml = `<edgarSubmission><genInfo><regName>Tema ETF Trust</regName><regCik>0001944285</regCik><seriesName>VOLT ETF</seriesName><seriesId>S000088946</seriesId><repPdDate>2026-08-31</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo><invstOrSec><name>Example Public Company Inc</name><cusip>123456789</cusip><pctVal>12.5</pctVal><valUSD>125000</valUSD><balance>1000</balance><assetCat>EC</assetCat></invstOrSec><invstOrSec><name>Cash Collateral</name><pctVal>1.5</pctVal><valUSD>15000</valUSD><balance>15000</balance><assetCat>STIV</assetCat></invstOrSec></edgarSubmission>`;
    const parsed = parseNport(xml);
    expect(parsed).toMatchObject({ regName: 'Tema ETF Trust', regCik: '0001944285', seriesName: 'VOLT ETF', seriesId: 'S000088946', reportDate: '2026-08-31', netAssets: 1_000_000 });
    expect(parsed.holdings).toHaveLength(2);
    expect(parsed.holdings[0]).toMatchObject({ Name: 'Example Public Company Inc', Identifier: '123456789', Weight: '12.5', 'Market Value': '125000', 'Shares Held': '1000' });
    expect(parsed.holdings[1].Cash).toBe('');
    const issuers = parseCompanyTickerMap({ '0': { ticker: 'EXM', title: 'Example Public Company Inc' } });
    expect(fillNportTickers(parsed.holdings, issuers)[0].Ticker).toBe('EXM');
  });
});

describe('Tema catalog cursor and index builders', () => {
  test('retains old catalog funds and names when the live route label is only a bare ticker', () => {
    const current = [
      { ticker: 'VOLT', name: 'VOLT', fundPage: 'https://temaetfs.com/volt' },
      { ticker: 'DICE', name: 'DICE Trading & Prediction Markets ETF', fundPage: 'https://temaetfs.com/dice' },
    ];
    const previous = [
      { ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt', holdings: 27 },
      { ticker: 'OLDX', name: 'Former Tema ETF', fundPage: 'https://temaetfs.com/oldx', holdings: 8 },
    ];
    expect(retainCatalogEntries(current, previous)).toEqual([
      { ticker: 'DICE', name: 'DICE Trading & Prediction Markets ETF', fundPage: 'https://temaetfs.com/dice' },
      { ticker: 'OLDX', name: 'Former Tema ETF', fundPage: 'https://temaetfs.com/oldx' },
      { ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' },
    ]);
  });

  test('rotates bounded batches after the saved cursor, ignores the cursor for explicit tickers, and returns full runs', () => {
    const funds = ['ARMY', 'CANC', 'DICE', 'DSPY'].map(ticker => ({ ticker }));
    expect(selectUpdateBatch(funds, 'CANC', 2).map(fund => fund.ticker)).toEqual(['DICE', 'DSPY']);
    expect(selectUpdateBatch(funds, 'DSPY', 2).map(fund => fund.ticker)).toEqual(['ARMY', 'CANC']);
    expect(selectUpdateBatch(funds, 'CANC', 1, ['DSPY', 'ARMY']).map(fund => fund.ticker)).toEqual(['ARMY']);
    expect(selectUpdateBatch(funds, 'DSPY', 0).map(fund => fund.ticker)).toEqual(['ARMY', 'CANC', 'DICE', 'DSPY']);
  });

  test('builds a usable blank catalog row and preserves previous published metrics', () => {
    const blank = minimalIndexFund({ ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' });
    expect(blank).toMatchObject({ ticker: 'VOLT', category: 'Equity', dataFile: './funds/VOLT/meta.json', terValue: null, navValue: null, holdings: 0, history: 0 });
    const previous = minimalIndexFund({ ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' }, { metrics: { ytd: 12 }, holdings: 27, category: 'U.S. Equity' });
    expect(previous).toMatchObject({ category: 'U.S. Equity', metrics: { ytd: 12 }, holdings: 27, history: 0 });
  });

  test('counts every retained fund and aggregates its existing data in index.json', () => {
    const index = buildIndexDocument([
      { ticker: 'VOLT', holdings: 27, history: 10 },
      { ticker: 'DSPY', holdings: 506, history: 150 },
    ], '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(index.counts).toEqual({ funds: 2, holdings: 533, history: 160 });
    expect(index.source).toMatchObject({ catalog: 'https://temaetfs.com/funds' });
  });
});

describe('Tema static page writes', () => {
  test('writes paginated sheets and removes only stale numbered JSON pages after a successful refresh', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tema-pages-test-'));
    try {
      const first = await writeFundPages(directory, 'VOLT', 'holdings', ['Ticker'], ['A', 'B', 'C', 'D', 'E'].map(Ticker => ({ Ticker })), 2, '2026-09-29', 'fixture');
      expect(first).toEqual({ pages: ['holdings/001.json', 'holdings/002.json', 'holdings/003.json'], pageSize: 2, totalRows: 5, asOfDate: '2026-09-29', source: 'fixture' });
      const last = JSON.parse(await readFile(join(directory, 'funds', 'VOLT', 'holdings', '003.json'), 'utf8'));
      expect(last.rows).toEqual([{ Ticker: 'E' }]);
      await writeFundPages(directory, 'VOLT', 'holdings', ['Ticker'], [{ Ticker: 'A' }], 2, '2026-09-30', 'fixture');
      const remaining = await readdir(join(directory, 'funds', 'VOLT', 'holdings'));
      expect(remaining.sort()).toEqual(['001.json']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('paced HTTP client', () => {
  test('retries 429 responses with Retry-After, preserves the user agent, and paces each attempt', async () => {
    const responses = [
      new Response('busy', { status: 429, headers: { 'retry-after': '2' } }),
      new Response('ready', { status: 200 }),
    ];
    const waits: number[] = [];
    const userAgents: Array<string | null> = [];
    let paced = 0;
    const client = createPacedHttpClient({
      gate: { pace: async () => { paced += 1; } },
      retries: 1,
      userAgent: 'Tema test runner example@example.com',
      fetchImpl: async (_input, init) => {
        userAgents.push(new Headers(init?.headers).get('user-agent'));
        return responses.shift()!;
      },
      sleep: async milliseconds => { waits.push(milliseconds); },
      now: () => 0,
    });
    const response = await client.fetch('https://example.test/data');
    expect(response.status).toBe(200);
    expect(paced).toBe(2);
    expect(waits).toEqual([2000]);
    expect(userAgents).toEqual(['Tema test runner example@example.com', 'Tema test runner example@example.com']);
  });

  test('retries transient network failures with bounded backoff and identifies non-retryable statuses', async () => {
    const waits: number[] = [];
    let requests = 0;
    const client = createPacedHttpClient({
      gate: { pace: async () => undefined },
      retries: 1,
      userAgent: 'test',
      fetchImpl: async () => {
        requests += 1;
        if (requests === 1) throw new Error('temporary network failure');
        return new Response('ok', { status: 200 });
      },
      sleep: async milliseconds => { waits.push(milliseconds); },
    });
    expect((await client.fetch('https://example.test/data')).status).toBe(200);
    expect(requests).toBe(2);
    expect(waits).toEqual([500]);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(retryDelayMilliseconds('Wed, 21 Oct 2015 07:28:02 GMT', 0, Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(2000);
  });

  test('does not echo query values when reporting an unsuccessful response', async () => {
    const client = createPacedHttpClient({ gate: { pace: async () => undefined }, retries: 0, userAgent: 'test', fetchImpl: async () => new Response('denied', { status: 403 }) });
    await expect(responseText(client, 'https://example.test/private?token=must-not-leak')).rejects.toThrow('HTTP 403 for example.test/private');
  });
});

describe('SEC N-PORT series resolver', () => {
  test('aliases WELD to the legacy RSHO series and matches a series name when the symbol table is stale', () => {
    const mapping = new Map([
      ['RSHO', { cik: '0001944285', seriesId: 'S000WELD', classId: 'C0001' }],
      ['PRVT', { cik: '0001944285', seriesId: 'S000PRVT', classId: 'C0002' }],
    ]);
    expect(resolveTemaNportSeriesRef('WELD', mapping)?.seriesId).toBe('S000WELD');
    expect(resolveTemaNportSeriesRef('DICE', mapping)).toBeNull();
    expect(nportSeriesMatchesFund({ regName: '', regCik: '', seriesName: 'DICE Trading & Prediction Markets ETF', seriesId: '', reportDate: '', holdings: [], netAssets: null }, 'DICE', 'Tema DICE Trading and Prediction Markets ETF')).toBe(true);
    expect(nportSeriesMatchesFund({ regName: '', regCik: '', seriesName: 'CANC Cancer Immunotherapy ETF', seriesId: '', reportDate: '', holdings: [], netAssets: null }, 'DICE', 'Tema DICE Trading and Prediction Markets ETF')).toBe(false);
  });

  test('scans the trust submissions in recent-first paced batches, caches symbols and matches exact series ids', async () => {
    const filings = [
      { accession: '0001944285-26-000003', filingDate: '2026-07-29', reportDate: '2026-05-31', seriesId: 'S000OTHER', seriesName: 'Tema Legacy ETF' },
      { accession: '0001944285-26-000002', filingDate: '2026-07-28', reportDate: '2026-05-31', seriesId: 'S000WELD', seriesName: 'Tema Weld Industries ETF' },
      { accession: '0001944285-26-000001', filingDate: '2026-07-27', reportDate: '2026-05-31', seriesId: 'S000PRVT', seriesName: 'Tema Private Markets ETF' },
    ];
    const tickerTable = {
      fields: ['symbol', 'cik', 'seriesId', 'classId'],
      data: [
        ['RSHO', '1944285', 'S000WELD', 'C0001'],
        ['PRVT', '1944285', 'S000PRVT', 'C0002'],
      ],
    };
    const submissions = {
      cik: 1944285,
      filings: { recent: {
        form: filings.map(() => 'NPORT-P'),
        accessionNumber: filings.map(filing => filing.accession),
        filingDate: filings.map(filing => filing.filingDate),
        reportDate: filings.map(filing => filing.reportDate),
      } },
    };
    const archiveCalls: string[] = [];
    const responseFor = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url === SEC_COMPANY_TICKERS_MF_URL) return responseFor(tickerTable);
      if (url === SEC_SUBMISSIONS_URL) return responseFor(submissions);
      const filing = filings.find(value => url.includes(value.accession.replace(/-/g, '')));
      if (!filing) return new Response('missing fixture', { status: 404 });
      archiveCalls.push(filing.accession);
      const xml = `<edgarSubmission><genInfo><regName>Tema ETF Trust</regName><regCik>0001944285</regCik><seriesName>${filing.seriesName}</seriesName><seriesId>${filing.seriesId}</seriesId><repPdDate>2026-05-31</repPdDate></genInfo><fundInfo><netAssets>1000000</netAssets></fundInfo></edgarSubmission>`;
      return new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } });
    };
    const client = createPacedHttpClient({ gate: { pace: async () => undefined }, retries: 0, userAgent: 'test', fetchImpl });
    const resolve = createNportResolver(client, { concurrency: 2, maxDocuments: 10 });
    const weld = await resolve({ ticker: 'WELD', name: 'Tema Weld Industries ETF' });
    expect(weld?.report.seriesId).toBe('S000WELD');
    expect(archiveCalls).toEqual([filings[0].accession, filings[1].accession]);
    expect((await resolve({ ticker: 'WELD', name: 'Tema Weld Industries ETF' }))?.accession.accession).toBe(filings[1].accession);
    const privateFund = await resolve({ ticker: 'PRVT', name: 'Tema Private Markets ETF' });
    expect(privateFund?.report.seriesId).toBe('S000PRVT');
    expect(archiveCalls).toEqual([filings[0].accession, filings[1].accession, filings[2].accession]);
  });
});

describe('Tema metadata and index projection', () => {
  test('converts chart prices and distributions into the sibling static-sheet contract', () => {
    const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
    const chart = parseYahooChart({ chart: { result: [{
      meta: { longName: 'VOLT ETF', regularMarketPrice: 12.35 },
      timestamp: [epoch('2026-09-28'), epoch('2026-09-29')],
      indicators: { quote: [{ close: [12.1, 12.35] }], adjclose: [{ adjclose: [12.11, 12.34] }] },
      events: { dividends: {
        '1788220800': { date: epoch('2026-08-01'), amount: 0.125 },
        '1788220801': { date: epoch('2026-09-01'), amount: 0.13 },
      } },
    }] } });
    expect(yahooHistoryRows(chart)).toEqual([
      { Date: 'Sep 28 2026', NAV: '', 'Market Price': '12.1', 'Premium/Discount': '' },
      { Date: 'Sep 29 2026', NAV: '', 'Market Price': '12.35', 'Premium/Discount': '' },
    ]);
    expect(yahooDistributionRows(chart)).toEqual([['08/01/2026', '0.125'], ['09/01/2026', '0.13']]);
    expect(buildPageManifest('VOLT', 'history', ['Date'], yahooHistoryRows(chart), 1, '2026-09-29', 'Yahoo')).toEqual({ pages: ['history/001.json', 'history/002.json'], pageSize: 1, totalRows: 2, asOfDate: '2026-09-29', source: 'Yahoo' });
  });

  test('builds Tema meta/index schemas using official page fields and honest Yahoo/SEC provenance', () => {
    const fund = { ticker: 'VOLT', name: 'VOLT Electrification ETF', fundPage: 'https://temaetfs.com/volt' };
    const page = parseTemaFundPage(fundPageFixture, 'VOLT', fund.name);
    const chart = {
      exchangeName: 'Nasdaq', longName: 'VOLT ETF', currency: 'USD', regularMarketPrice: 35.85, regularMarketTime: null, firstTradeDate: null,
      days: [{ date: '2026-09-29', close: 35.85, adjClose: 35.84, volume: 1 }],
      dividends: [{ date: '2026-07-01', amount: 0.2 }, { date: '2026-09-01', amount: 0.25 }],
    };
    const derived = deriveTemaMetrics(chart);
    const meta = buildTemaFundMeta({
      fund,
      page,
      holdings: { pages: ['holdings/001.json'], pageSize: 250, totalRows: 27, asOfDate: '2026-09-29', source: 'Tema official daily CSV' },
      history: { pages: ['history/001.json'], pageSize: 1000, totalRows: 1, asOfDate: '2026-09-29', source: 'Yahoo Finance chart API' },
      chart,
      derived,
      holdingsDownloadUrl: 'https://temaetfs.com/hubfs/holdings.csv?cache=changing',
      nport: null,
      generatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(meta).toMatchObject({ ticker: 'VOLT', name: 'VOLT Electrification ETF', category: 'Equity' });
    expect(meta.source).toMatchObject({ yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart/VOLT', holdingsDownload: 'https://temaetfs.com/hubfs/holdings.csv' });
    expect(meta.expenseRatio).toMatchObject({ display: '0.75%', value: 0.75, gross: 0.75, net: null });
    expect(meta.holdings).toMatchObject({ totalRows: 27, pages: ['holdings/001.json'] });
    expect(meta.distributions).toMatchObject({ frequency: 'Unknown', paymentsPerYear: null, rows: [['07/01/2026', '0.2'], ['09/01/2026', '0.25']] });
    expect(meta.yields).toMatchObject({ secYield: null, dividendYield: 1.26 });
    const row = indexFundFromMeta(fund, meta);
    expect(row).toMatchObject({ ticker: 'VOLT', aumValue: 734149760, navValue: 35.81, closePriceValue: 35.85, holdings: 27, history: 1 });
    expect(row.distributions).toMatchObject({ frequency: 'Unknown', exDate: '09/01/2026', dividend: '0.25' });
    expect(formatTemaMoney(734149760)).toBe('$734.15 M');
    expect(formatTemaPercent(-1)).toBe('-1.00%');
  });

  test('fills unavailable refreshed fields from the published version without replacing real zero or explicit Unknown', () => {
    expect(mergePublishedFallback(
      { metric: null, zero: 0, frequency: 'Unknown', rows: [], child: { value: '—' } },
      { metric: 3.5, zero: 9, frequency: 'Quarterly', rows: [1], child: { value: 'kept', old: true } },
    )).toEqual({ metric: 3.5, zero: 0, frequency: 'Unknown', rows: [1], child: { value: 'kept', old: true } });
  });
});

describe('Tema CLI help and console contracts', () => {
  test('prints the shared padded config/filter lines and detects data-dependent filters', () => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
    try {
      const config = readUpdaterConfig({ TICKERS: 'VOLT DSPY', REQUEST_SLEEP: '0.5' });
      outputPrintConfig('Tema ETFs', config);
      outputPrintFilter(2, 14, true);
      expect(outputHasOutputFilters(config)).toBe(true);
      expect(hasDataDependentFilters(config)).toBe(false);
      expect(hasDataDependentFilters(readUpdaterConfig({ AUM: 'micro' }))).toBe(true);
      expect(lines[0]).toContain('[ config   ] Tema ETFs updater:');
      expect(lines[0]).toContain('MAX_FETCHES=0');
      expect(lines[1]).toBe('[ filter   ] 2 of 14 funds selected for evaluation (data-dependent filters applied per fund)');
    } finally {
      console.log = log;
    }
  });

  test('documents every supported environment control and performs no network work for help', () => {
    const help = updaterHelpText();
    for (const item of ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'PERFORMANCE_', 'TOTAL_RETURN_', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'OUTPUT_DIR', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SEC_UA', 'VERBOSE']) expect(help).toContain(item);
    const log = console.log;
    const lines: string[] = [];
    console.log = (...values: unknown[]) => { lines.push(values.map(String).join(' ')); };
    try {
      printHelp();
      expect(lines).toEqual([help]);
    } finally {
      console.log = log;
    }
  });
});

describe('Tema updater orchestration with offline provider fixtures', () => {
  test('writes sibling-compatible static files, stays byte-stable, and retains data after provider failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tema-runner-test-'));
    const csvUrl = 'https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv?cache=changing';
    const catalogHtml = '<a href="https://temaetfs.com/volt">VOLT Electrification ETF</a>';
    const pageHtml = `${fundPageFixture}<a href="${csvUrl}">Download Holdings (CSV)</a>`;
    const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
    const chartPayload = { chart: { result: [{
      meta: { longName: 'VOLT ETF', exchangeName: 'Nasdaq', currency: 'USD', regularMarketPrice: 35.85 },
      timestamp: [epoch('2026-09-28'), epoch('2026-09-29')],
      indicators: { quote: [{ close: [35.8, 35.85] }], adjclose: [{ adjclose: [35.8, 35.84] }] },
      events: { dividends: {
        first: { date: epoch('2026-03-01'), amount: 0.2 },
        second: { date: epoch('2026-06-01'), amount: 0.2 },
        third: { date: epoch('2026-09-01'), amount: 0.25 },
      } },
    }] } };
    const ok = (body: string, contentType = 'text/html') => new Response(body, { status: 200, headers: { 'content-type': contentType } });
    let secRequests = 0;
    const healthyClients = {
      issuer: { fetch: async (input: string | URL) => {
        const url = String(input);
        if (url === 'https://temaetfs.com/funds') return ok(catalogHtml);
        if (url === 'https://temaetfs.com/volt') return ok(pageHtml);
        if (url.startsWith('https://temaetfs.com/hubfs/')) return ok(holdingsFixture, 'text/csv; charset=x-macroman');
        return new Response('not found', { status: 404 });
      } },
      yahoo: { fetch: async () => ok(JSON.stringify(chartPayload), 'application/json') },
      sec: { fetch: async () => { secRequests += 1; return new Response('unexpected SEC request', { status: 403 }); } },
    };
    const config = readUpdaterConfig({ OUTPUT_DIR: directory, TICKERS: 'VOLT', REQUEST_SLEEP: '0', MAX_RETRIES: '1' });
    const log = console.log;
    console.log = () => undefined;
    const snapshot = async (): Promise<string> => {
      const files: Array<[string, string]> = [];
      async function visit(path: string): Promise<void> {
        const entries = await readdir(path, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          const child = join(path, entry.name);
          if (entry.isDirectory()) await visit(child);
          else files.push([child.slice(directory.length + 1), await readFile(child, 'utf8')]);
        }
      }
      await visit(directory);
      return JSON.stringify(files);
    };
    try {
      const first = await runUpdater(config, healthyClients);
      expect(first).toMatchObject({ catalogCount: 1, selectedCount: 1, updatedCount: 1, failures: 0, holdings: 3, history: 2 });
      expect(secRequests).toBe(0);
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
      expect(index.funds[0]).toMatchObject({ ticker: 'VOLT', holdings: 3, history: 2, dataFile: './funds/VOLT/meta.json' });
      const meta = JSON.parse(await readFile(join(directory, 'funds', 'VOLT', 'meta.json'), 'utf8'));
      expect(meta.holdings.pages).toEqual(['holdings/001.json']);
      expect(meta.history.pages).toEqual(['history/001.json']);
      expect(meta.source.holdingsDownload).toBe('https://temaetfs.com/hubfs/Website/Holdings/VOLT-holdings-09292026.csv');
      expect(meta.source.nportFiling).toBeNull();
      const firstSnapshot = await snapshot();

      const second = await runUpdater(config, healthyClients);
      expect(second.updatedCount).toBe(1);
      expect(await snapshot()).toBe(firstSnapshot);

      const failingClients = {
        issuer: { fetch: async (input: string | URL) => String(input) === 'https://temaetfs.com/funds' ? ok(catalogHtml) : new Response('unavailable', { status: 503 }) },
        yahoo: { fetch: async () => new Response('unavailable', { status: 503 }) },
        sec: { fetch: async () => new Response('disabled', { status: 403 }) },
      };
      const retentionConfig = readUpdaterConfig({ OUTPUT_DIR: directory, TICKERS: 'VOLT', REQUEST_SLEEP: '0', MAX_RETRIES: '1', EDGAR_FALLBACK: 'false' });
      const retained = await runUpdater(retentionConfig, failingClients);
      expect(retained).toMatchObject({ selectedCount: 1, updatedCount: 0, skippedCount: 1, failures: 0, holdings: 3, history: 2 });
      expect(await snapshot()).toBe(firstSnapshot);
    } finally {
      console.log = log;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('Tema catalog and data filter projections', () => {
  test('separates static ticker/category filters from updated metric filters', () => {
    const config = readUpdaterConfig({ TICKERS: 'VOLT', CATEGORY: 'equity', AUM: '500M:1B', TOTAL_RETURN_1Y: '10:' });
    expect(passesStaticFundFilters({ ticker: 'VOLT' }, 'Equity', config)).toBe(true);
    expect(passesStaticFundFilters({ ticker: 'DSPY' }, 'Equity', config)).toBe(false);
    expect(passesStaticFundFilters({ ticker: 'VOLT' }, 'Fixed Income', config)).toBe(false);
    const filter = filterFundFromIndex({
      ticker: 'VOLT', category: 'Equity', aumValue: 734149760, terValue: 0.75,
      metrics: { ytd: 4, tr1y: 18, tr3y: 42, tr5y: null, tr10y: null, dividendYield: 1.2, secYield: null },
      returns: { monthEnd: { asOfDate: 'Sep 29 2026', ytd: 4, yr1: 18, yr3: 12, yr5: null, yr10: null } },
    });
    expect(filter).toMatchObject({ ticker: 'VOLT', category: 'Equity', aumValue: 734149760, dividendYield: 1.2, totalReturn: { '1Y': 18, '3Y': 42 } });
    expect(passesFundFilters(filter, config)).toBe(true);
    expect(passesFundFilters({ ...filter, aumValue: 200_000_000 }, config)).toBe(false);
  });
});

describe('Tema bounded updater cursor', () => {
  test('writes the last processed ticker and resumes after it on the next capped run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tema-cursor-test-'));
    const catalogHtml = '<a href="https://temaetfs.com/volt">VOLT Electrification ETF</a><a href="https://temaetfs.com/army">ARMY International Defense ETF</a>';
    const requestedPages: string[] = [];
    const clients = {
      issuer: { fetch: async (input: string | URL) => {
        const url = String(input);
        if (url === 'https://temaetfs.com/funds') return new Response(catalogHtml, { status: 200 });
        requestedPages.push(url);
        return new Response('unavailable', { status: 503 });
      } },
      yahoo: { fetch: async () => new Response('disabled', { status: 403 }) },
      sec: { fetch: async () => new Response('disabled', { status: 403 }) },
    };
    const config = readUpdaterConfig({ OUTPUT_DIR: directory, MAX_FETCHES: '1', REQUEST_SLEEP: '0', CONCURRENCY: '1', MAX_RETRIES: '1', EDGAR_FALLBACK: 'false', SKIP_YAHOO: 'true' });
    const log = console.log;
    console.log = () => undefined;
    try {
      const first = await runUpdater(config, clients);
      expect(first).toMatchObject({ selectedCount: 1, updatedCount: 0, failures: 1 });
      expect(requestedPages).toEqual(['https://temaetfs.com/army']);
      expect(JSON.parse(await readFile(join(directory, 'update-state.json'), 'utf8'))).toEqual({ cursor: 'ARMY' });

      const second = await runUpdater(config, clients);
      expect(second).toMatchObject({ selectedCount: 1, updatedCount: 0, skippedCount: 1, failures: 0 });
      expect(requestedPages).toEqual(['https://temaetfs.com/army', 'https://temaetfs.com/volt']);
      expect(JSON.parse(await readFile(join(directory, 'update-state.json'), 'utf8'))).toEqual({ cursor: 'VOLT' });
      const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
      expect(index.funds.map((fund: { ticker: string }) => fund.ticker)).toEqual(['ARMY', 'VOLT']);
    } finally {
      console.log = log;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const readRepo = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const configFile = JSON.parse(readRepo('scripts/update-data.config.json')) as Record<string, string>;

describe('control resolver', () => {
  test('precedence: file < advanced < nonblank input < environment', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'VOLT' }, { CONCURRENCY: 3, TICKERS: 'WELD' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
    expect(c.CONCURRENCY).toBe('5');
    expect(c.TICKERS).toBe('WELD');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ TICKERS: 'VOLT' }, {}, { TICKERS: '' }).TICKERS).toBe('VOLT');
    expect(resolveControls({ TICKERS: 'VOLT' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ TICKERS: 'VOLT' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { TEMA_LIMIT: '7' }).MAX_FETCHES).toBe('7');
    expect(resolveControls({ CATEGORY: '' }, {}, {}, { ASSET_CLASS: 'Equity' }).CATEGORY).toBe('Equity');
  });

  test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
    expect(resolveControls(configFile, {}, {})).toEqual(configFile);
    const config = readUpdaterConfig(resolveControls(configFile));
    expect(config).toMatchObject({
      maxFetches: 0, requestSleepSeconds: 1, concurrency: 2, maxRetries: 2, holdingsPageSize: 250,
      historyPageSize: 1000, historyRange: 'max', edgarFallback: true, skipYahoo: false, tickers: [],
      secUserAgent: 'daggerok ETF feed daggerok@gmail.com',
    });
    expect(config.outputDir.endsWith('api/tema')).toBe(true);
    expect(readUpdaterConfig({}).secUserAgent).toBe(configFile.SEC_UA);
  });

  test('rejects unknown keys, non-scalars, newlines and invalid values', () => {
    for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { AUM: '1:2:3' }, { TER: '2:1' }, { HISTORY_RANGE: '10d' }, { TICKERS: ['VOLT'] }, null, []]) {
      expect(() => resolveControls(value)).toThrow();
    }
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, [] as unknown)).toThrow();
    expect(() => resolveControls({}, {}, {}, { MAX_RETRIES: '0' })).toThrow();
    expect(() => JSON.parse('{bad')).toThrow();
  });

  test('runtimeControls reads the tracked config file and env overrides win', async () => {
    const controls = await runtimeControls({ TICKERS: 'VOLT', REQUEST_SLEEP: '0' });
    expect(controls.TICKERS).toBe('VOLT');
    expect(controls.REQUEST_SLEEP).toBe('0');
    expect(controls.HISTORY_PAGE_SIZE).toBe('1000');
  });

  test('config keys == CONTROL_NAMES == --help == README rows, all values strings', () => {
    expect(Object.keys(configFile).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(configFile)) expect(typeof value).toBe('string');
    const doc = readRepo('README.md');
    const help = updaterHelpText();
    for (const name of CONTROL_NAMES) {
      const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(YTD|1Y|3Y|5Y|10Y)$/);
      if (tenor) {
        expect(doc).toContain(`\`${tenor[1]}_{YTD,1Y,3Y,5Y,10Y}\``);
        expect(help).toContain(`${tenor[1]}_{YTD,1Y,3Y,5Y,10Y}`);
      } else {
        expect(doc).toContain(`| \`${name}\` |`);
        expect(help).toContain(name);
      }
    }
    expect(doc).toContain('scripts/update-data.config.json');
  });
});

describe('README and workflow shape', () => {
  test('README keeps the standard section order and verification commands', () => {
    const doc = readRepo('README.md');
    const headings = doc.split(/\r?\n/).filter(line => /^#{1,3} /.test(line));
    expect(headings).toEqual([
      '# Tema ETFs',
      '## Using Bun',
      '## Updating the static Tema ETFs data',
      '### Data sources',
      '### Metrics and caveats',
      '### Update controls',
      '### Examples',
      '## TypeScript and verification',
      '## Brands table',
      '## Sibling applications',
      '## License',
    ]);
    for (const command of ['bun install --frozen-lockfile', 'bun test', 'bun build --target=bun scripts/update-data.ts --outfile=/dev/null', 'git diff --check']) expect(doc).toContain(command);
    expect(doc).toContain('file defaults < `advanced` JSON < nonblank workflow inputs < protected Actions variable or environment variable');
    for (const value of ['https://temaetfs.com/funds', 'Tema ETF Trust (CIK `0001944285`)', 'holdings fallback only', 'not official NAV total returns']) expect(doc).toContain(value);
  });

  test('workflow: at most 25 inputs mapped to controls, fixed output dir, hardened, no direct input interpolation', () => {
    const wf = readRepo('.github/workflows/update-data.yml');
    const block = wf.slice(wf.indexOf('    inputs:'), wf.indexOf('\npermissions:'));
    const names = [...block.matchAll(/^      (\w+):$/gm)].map(m => m[1]);
    expect(names.length).toBeLessThanOrEqual(25);
    expect(names).toContain('advanced');
    expect(block).toContain("default: '{}'");
    for (const name of names.filter(n => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
    expect(names).not.toContain('output_dir');
    expect(wf).toContain("cron: '0 0 * * 0'");
    expect(wf).toContain('toJSON(inputs)');
    expect(wf).not.toMatch(/\$\{\{\s*(inputs|github\.event\.inputs)\./);
    expect(configFile.OUTPUT_DIR).toBe('api/tema');
    expect(wf).toContain('git add api/tema\n');
    expect(wf).not.toMatch(/git add (?!api\/tema\b)/);
    expect(wf).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
    expect(wf).toContain('resolveControls(file, advanced, individual, protectedVars)');
    expect(wf).toContain('timeout-minutes: 30');
    expect(wf).toContain('persist-credentials: false');
    expect(wf).not.toMatch(/^\s{2}push:/m);
  });
});
