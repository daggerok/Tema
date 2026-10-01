/// <reference types="bun" />

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  buildPages,
  createRequestGate,
  envValue,
  findTemaHoldingsCsvUrl,
  normalizeTemaDate,
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
  passesFundFilters,
  passesRange,
  readUpdaterConfig,
  samePublishedContent,
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

  test('rejects a fund-page ticker that does not match the requested catalog ticker', () => {
    expect(() => parseTemaFundPage(fundPageFixture, 'ARMY')).toThrow('fund page identifies itself as VOLT');
  });
});

describe('Tema holdings date normalization', () => {
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
