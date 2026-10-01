/// <reference types="bun" />

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  buildPages,
  buildIndexDocument,
  createRequestGate,
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
  parseEdgarAtomFilings,
  parseYahooChart,
  yahooChartUrl,
  retainCatalogEntries,
  selectUpdateBatch,
  writeFundPages,
  passesFundFilters,
  passesRange,
  readUpdaterConfig,
  samePublishedContent,
  shiftIsoDate,
  writeJsonIfChanged,
} from './update-data.ts';

const holdingsFixture = readFileSync(new URL('./fixtures/tema-holdings-2026-09-29.csv', import.meta.url), 'utf8');
const fundPageFixture = readFileSync(new URL('./fixtures/tema-volt-page-2026-09-29.html', import.meta.url), 'utf8');

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
      MAX_RETRIES: '0',
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
      maxRetries: 0,
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
    const line = outputFundLine(1, 14, 'VOLT', 'updated', { history: 0, holdings: null, aumValue: null, metrics: { dividendYield: 0, secYield: null } });
    expect(line).toContain('history=0');
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

  test('keeps absent dividend history unknown instead of asserting a zero yield', () => {
    const chart = { days: [{ date: '2026-09-29', close: 10, adjClose: 10, volume: 0 }], dividends: [], exchangeName: '', longName: '', currency: '', regularMarketPrice: 10, regularMarketTime: null, firstTradeDate: null };
    const result = deriveTemaMetrics(chart);
    expect(result.dividendYield).toBe(null);
    expect(result.frequency.frequency).toBe('Unknown');
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'Unknown', paymentsPerYear: null });
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
