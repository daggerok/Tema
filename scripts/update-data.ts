#!/usr/bin/env bun
/// <reference types="bun" />

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tema ETFs updater. Pure parsing helpers are exported for offline fixture tests. */

export type TemaFund = {
  ticker: string;
  name: string;
  fundPage: string;
};

export type ParsedTemaHoldings = {
  headers: string[];
  rows: Array<Record<string, string>>;
  sourceHeaders: string[];
  asOfDate: string;
  totalRows: number;
};

const HOLDINGS_HEADERS = [
  'Name',
  'Ticker',
  'Identifier',
  'Weight',
  'Market Value',
  'Shares Held',
  'Asset Category',
  'Country',
  'Sector',
  'Cash',
];

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function htmlText(fragment: string): string {
  return decodeHtmlEntities(
    fragment
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function attribute(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

/** Find each fund once from the public `/funds` page's ticker-linked product cards. */
export function parseTemaCatalog(html: string, baseUrl = 'https://temaetfs.com/funds'): TemaFund[] {
  const found = new Map<string, TemaFund>();
  for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a\s*>/gi)) {
    const tag = match[0].slice(0, match[0].indexOf('>') + 1);
    const href = attribute(tag, 'href');
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeHtmlEntities(href), baseUrl);
    } catch {
      continue;
    }
    if (!['temaetfs.com', 'www.temaetfs.com'].includes(url.hostname.toLowerCase())) continue;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1 || !/^[a-z0-9]{2,5}$/i.test(parts[0])) continue;
    const ticker = parts[0].toUpperCase();
    let label = htmlText(match[0].slice(tag.length, match[0].lastIndexOf('<')));
    label = label.replace(/\s*\(NEW\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!new RegExp(`^${ticker}(?:\\b|\\s|$)`, 'i').test(label)) continue;
    const current = found.get(ticker);
    if (!current || label.length > current.name.length) {
      found.set(ticker, { ticker, name: label, fundPage: url.href.replace(/\/$/, '') });
    }
  }
  return [...found.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Resolve the current dated HubSpot CSV from a fund page, retaining its query string. */
export function findTemaHoldingsCsvUrl(pageHtml: string, ticker: string, baseUrl: string): string {
  const expected = `${ticker.trim().toUpperCase()}-HOLDINGS-`;
  for (const match of pageHtml.matchAll(/<a\b[^>]*>/gi)) {
    const href = attribute(match[0], 'href');
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeHtmlEntities(href), baseUrl);
    } catch {
      continue;
    }
    const path = decodeURIComponent(url.pathname).toUpperCase();
    if (
      ['temaetfs.com', 'www.temaetfs.com'].includes(url.hostname.toLowerCase()) &&
      path.includes('/HUBFS/WEBSITE/HOLDINGS/') &&
      path.includes(expected) &&
      path.endsWith('.CSV')
    ) return url.href;
  }
  throw new Error(`${ticker}: no official daily holdings CSV link found on ${baseUrl}`);
}

/** Parse CSV quoting, escaped quotes, commas and newlines without a runtime dependency. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (char === '\r' && source[i + 1] === '\n') i += 1;
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (row.length || cell.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Convert known issuer date spellings to an ISO calendar date without local-time shifts. */
export function normalizeTemaDate(value: string): string {
  const text = value.trim();
  if (!text) return '';
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    const parsedYear = Number(us[3]);
    year = us[3].length === 2 ? (parsedYear < 70 ? 2000 + parsedYear : 1900 + parsedYear) : parsedYear;
  } else if (compact) {
    month = Number(compact[1]);
    day = Number(compact[2]);
    year = Number(compact[3]);
  } else {
    const parsed = new Date(text);
    if (!Number.isFinite(parsed.getTime())) return '';
    year = parsed.getUTCFullYear();
    month = parsed.getUTCMonth() + 1;
    day = parsed.getUTCDate();
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export type ParsedTemaFundPage = {
  ticker: string;
  name: string;
  cusip: string;
  inceptionDate: string;
  ter: string;
  terValue: number | null;
  aum: string;
  aumValue: number | null;
  exchange: string;
  sharesOutstanding: number | null;
  holdingsCount: number | null;
  nav: string;
  navValue: number | null;
  closePrice: string;
  closePriceValue: number | null;
  premiumDiscount: string;
  premiumDiscountValue: number | null;
  asOfDate: string;
};

function formatDateLabel(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return '';
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${day} ${year}`;
}

/** Parse the public, server-rendered fund-detail boxes and daily price block. */
export function parseTemaFundPage(html: string, requestedTicker: string, catalogName = ''): ParsedTemaFundPage {
  const fields = new Map<string, string>();
  const pairPattern = /<div\b[^>]*class=["'][^"']*\bcol-specification\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class=["'][^"']*\bcol-details\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(pairPattern)) fields.set(htmlText(match[1]).toLowerCase(), htmlText(match[2]));

  const ticker = (fields.get('ticker') ?? '').toUpperCase();
  const expectedTicker = requestedTicker.trim().toUpperCase();
  if (!ticker) throw new Error(`${expectedTicker}: fund page has no Ticker field`);
  if (ticker !== expectedTicker) throw new Error(`${expectedTicker}: fund page identifies itself as ${ticker}`);

  const priceFields = new Map<string, string>();
  const pricePattern = /<div\b[^>]*class=["'][^"']*\bprice-table__row\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const row of html.matchAll(pricePattern)) {
    const cells = [...row[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(cell => htmlText(cell[1]));
    if (cells.length >= 2) priceFields.set(cells[0].toLowerCase(), cells[1]);
  }
  const asOfMatch = /<div\b[^>]*class=["'][^"']*\bas-of-date-container\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const asOfText = htmlText(asOfMatch?.[1] ?? '').replace(/^as of\s+/i, '');
  const asOfDate = formatDateLabel(normalizeTemaDate(asOfText));
  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const heading = htmlText(h1Match?.[1] ?? '').replace(new RegExp(`^${expectedTicker}\\s+`, 'i'), '').trim();
  const ter = fields.get('total expense ratio') ?? '';
  const aum = fields.get('aum') ?? '';
  const nav = priceFields.get('nav') ?? '';
  const closePrice = priceFields.get('market price') ?? '';
  const premiumDiscount = priceFields.get('premium/discount') ?? '';
  const inceptionIso = normalizeTemaDate(fields.get('inception date') ?? '');

  return {
    ticker,
    name: catalogName || heading,
    cusip: fields.get('cusip') ?? '',
    inceptionDate: formatDateLabel(inceptionIso),
    ter,
    terValue: numericCell(ter),
    aum,
    aumValue: numericCell(aum),
    exchange: fields.get('primary exchange') ?? '',
    sharesOutstanding: numericCell(fields.get('shares outstanding') ?? ''),
    holdingsCount: numericCell(fields.get('# of holdings') ?? ''),
    nav,
    navValue: numericCell(nav),
    closePrice,
    closePriceValue: numericCell(closePrice),
    premiumDiscount,
    premiumDiscountValue: numericCell(premiumDiscount),
    asOfDate,
  };
}

function numericCell(value: string): number | null {
  const normalized = value.trim().replace(/[$,%\s]/g, '').replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function displayNumber(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Map Tema's published percentage fraction and security fields to the sibling holdings contract. */
export function parseTemaHoldingsCsv(text: string): ParsedTemaHoldings {
  const table = parseCsv(text);
  if (!table.length) throw new Error('holdings CSV is empty');
  const sourceHeaders = table[0].map(value => value.trim().replace(/^\uFEFF/, '').toLowerCase());
  const column = (name: string): number => sourceHeaders.indexOf(name);
  const required = ['holdings_date', 'ticker', 'cusip', 'proper_name', 'shares', 'market_value', 'percent_of_nav', 'is_cash', 'country', 'sector'];
  const missing = required.filter(name => column(name) < 0);
  if (missing.length) throw new Error(`holdings CSV is missing required columns: ${missing.join(', ')}`);

  const rows: Array<Record<string, string>> = [];
  let asOfDate = '';
  for (const cells of table.slice(1)) {
    const pick = (name: string): string => (cells[column(name)] ?? '').trim();
    if (!cells.some(value => value.trim())) continue;
    if (!asOfDate) asOfDate = normalizeTemaDate(pick('holdings_date'));
    const name = pick('proper_name');
    const ticker = pick('ticker');
    if (!name && !ticker) continue;
    const fraction = numericCell(pick('percent_of_nav'));
    const cusip = pick('cusip');
    const cashRaw = pick('is_cash').toLowerCase();
    const cash = ['1', 'true', 'yes', 'y'].includes(cashRaw) ? 'Yes' : ['0', 'false', 'no', 'n'].includes(cashRaw) ? 'No' : '';
    rows.push({
      Name: name,
      Ticker: ticker,
      Identifier: cusip || ticker || name,
      Weight: fraction === null ? '' : displayNumber(fraction * 100, 2),
      'Market Value': pick('market_value'),
      'Shares Held': pick('shares'),
      'Asset Category': pick('sector'),
      Country: pick('country'),
      Sector: pick('sector'),
      Cash: cash,
    });
  }
  if (!asOfDate) throw new Error('holdings CSV has no valid holdings_date');
  return { headers: [...HOLDINGS_HEADERS], rows, sourceHeaders, asOfDate, totalRows: rows.length };
}

export type NumericRange = { min: number | null; max: number | null; source: string };
export type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
export type RangeMap = Record<ReturnPeriod, NumericRange>;

const RETURN_PERIODS: ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
const EMPTY_RANGE: NumericRange = { min: null, max: null, source: ':' };

export type UpdaterConfig = {
  maxFetches: number;
  requestSleepSeconds: number;
  concurrency: number;
  maxRetries: number;
  holdingsPageSize: number;
  historyPageSize: number;
  outputDir: string;
  tickers: string[];
  categories: string[];
  aumRange: NumericRange;
  terRange: NumericRange;
  dividendYieldRange: NumericRange;
  secYieldRange: NumericRange;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
  edgarFallback: boolean;
  skipYahoo: boolean;
};

/** Read a canonical env name first, then older aliases; blank strings use the next source. */
export function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string | undefined {
  for (const key of [name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

export function parsePositiveInt(raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`expected a ${allowZero ? 'non-negative' : 'positive'} integer, got ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`expected a ${allowZero ? 'non-negative' : 'positive'} integer, got ${raw}`);
  }
  return value;
}

export function parseDecimal(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) throw new Error(`expected a non-negative decimal, got ${raw}`);
  return value;
}

/** Parse AUM money bounds. Bare numbers are USD; K/M/B/T suffixes are accepted. */
export function parseAumBound(bound: string): number | undefined {
  const text = bound.trim().replace(/[,$\s]/g, '').toLowerCase();
  if (!text) return undefined;
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([kmbt])?$/.exec(text);
  if (!match) throw new Error(`invalid AUM bound: ${bound}`);
  const scale = match[2] === 'k' ? 1e3 : match[2] === 'm' ? 1e6 : match[2] === 'b' ? 1e9 : match[2] === 't' ? 1e12 : 1;
  const value = Number(match[1]) * scale;
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid AUM bound: ${bound}`);
  return value;
}

function parseRangeFilter(raw: string | undefined, name: string, parseBound: (value: string) => number | undefined = value => {
  if (!value.trim()) return undefined;
  const parsed = Number(value.trim().replace(/%$/, ''));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name} bound: ${value}`);
  return parsed;
}): NumericRange {
  const source = raw === undefined || raw.trim() === '' ? ':' : raw.trim();
  if (source === ':') return { ...EMPTY_RANGE };
  const separator = source.indexOf(':');
  if (separator < 0 || source.indexOf(':', separator + 1) >= 0) throw new Error(`${name} must use MIN:MAX syntax, got ${source}`);
  const min = parseBound(source.slice(0, separator));
  const max = parseBound(source.slice(separator + 1));
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${name} minimum exceeds maximum: ${source}`);
  return { min: min ?? null, max: max ?? null, source };
}

function parseAumRange(raw: string | undefined): NumericRange {
  const source = raw === undefined || raw.trim() === '' ? ':' : raw.trim();
  const presets: Record<string, NumericRange> = {
    nano: { min: null, max: 10_000_000, source },
    micro: { min: 10_000_000, max: 300_000_000, source },
    small: { min: 300_000_000, max: 2_000_000_000, source },
    mid: { min: 2_000_000_000, max: 10_000_000_000, source },
    large: { min: 10_000_000_000, max: null, source },
  };
  return presets[source.toLowerCase()] ?? parseRangeFilter(source, 'AUM', parseAumBound);
}

export function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  return {
    YTD: parseRangeFilter(envValue(env, `${prefix}_YTD`), `${prefix}_YTD`),
    '1Y': parseRangeFilter(envValue(env, `${prefix}_1Y`), `${prefix}_1Y`),
    '3Y': parseRangeFilter(envValue(env, `${prefix}_3Y`), `${prefix}_3Y`),
    '5Y': parseRangeFilter(envValue(env, `${prefix}_5Y`), `${prefix}_5Y`),
    '10Y': parseRangeFilter(envValue(env, `${prefix}_10Y`), `${prefix}_10Y`),
  };
}

function parseList(raw: string | undefined): string[] {
  return raw ? [...new Set(raw.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean))] : [];
}

function parseCategoryList(raw: string | undefined): string[] {
  return raw ? [...new Set(raw.split(/[,;]+/).map(value => value.trim().toLowerCase()).filter(Boolean))] : [];
}

function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw.trim())) return true;
  if (/^(0|false|no|off)$/i.test(raw.trim())) return false;
  throw new Error(`expected true/false, got ${raw}`);
}

export function readUpdaterConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  const outputDir = resolve(envValue(env, 'OUTPUT_DIR') ?? 'api/tema');
  return {
    maxFetches: parsePositiveInt(envValue(env, 'MAX_FETCHES', ['TEMA_LIMIT']), 0, true),
    requestSleepSeconds: parseDecimal(envValue(env, 'REQUEST_SLEEP'), 1),
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), 2),
    maxRetries: parsePositiveInt(envValue(env, 'MAX_RETRIES'), 2, true),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), 250),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE'), 1000),
    outputDir,
    tickers: parseList(envValue(env, 'TICKERS')).map(value => value.toUpperCase()),
    categories: parseCategoryList(envValue(env, 'CATEGORY', ['ASSET_CLASS'])),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRangeFilter(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRangeFilter(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRangeFilter(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
    edgarFallback: parseFlag(envValue(env, 'EDGAR_FALLBACK'), true),
    skipYahoo: parseFlag(envValue(env, 'SKIP_YAHOO'), false),
  };
}

function rangeActive(range: NumericRange): boolean {
  return range.min !== null || range.max !== null;
}

export function passesRange(value: number | null | undefined, range: NumericRange): boolean {
  if (!rangeActive(range)) return true;
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  return (range.min === null || value >= range.min) && (range.max === null || value <= range.max);
}

export type FilterFund = {
  ticker: string;
  category?: string | null;
  aumValue?: number | null;
  terValue?: number | null;
  dividendYield?: number | null;
  secYield?: number | null;
  performance?: Partial<Record<ReturnPeriod, number | null>>;
  totalReturn?: Partial<Record<ReturnPeriod, number | null>>;
};

export function passesFundFilters(fund: FilterFund, config: UpdaterConfig): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker.toUpperCase())) return false;
  if (config.categories.length && !config.categories.includes((fund.category ?? '').toLowerCase())) return false;
  if (!passesRange(fund.aumValue, config.aumRange)) return false;
  if (!passesRange(fund.terValue, config.terRange)) return false;
  if (!passesRange(fund.dividendYield, config.dividendYieldRange)) return false;
  if (!passesRange(fund.secYield, config.secYieldRange)) return false;
  for (const period of RETURN_PERIODS) {
    if (!passesRange(fund.performance?.[period], config.performanceRanges[period])) return false;
    if (!passesRange(fund.totalReturn?.[period], config.totalReturnRanges[period])) return false;
  }
  return true;
}

function configRangeValue(range: NumericRange): string {
  return range.source || `${range.min ?? ''}:${range.max ?? ''}`;
}

function outputConfigEntries(config: UpdaterConfig): [string, string][] {
  const values: [string, string][] = [
    ['MAX_FETCHES', String(config.maxFetches)],
    ['REQUEST_SLEEP', String(config.requestSleepSeconds)],
    ['CONCURRENCY', String(config.concurrency)],
    ['CATEGORY', config.categories.join(',') || 'all'],
    ['AUM', configRangeValue(config.aumRange)],
    ['DIVIDEND_YIELD', configRangeValue(config.dividendYieldRange)],
    ['EDGAR_FALLBACK', String(config.edgarFallback)],
    ['HISTORY_PAGE_SIZE', String(config.historyPageSize)],
    ['HOLDINGS_PAGE_SIZE', String(config.holdingsPageSize)],
    ['MAX_RETRIES', String(config.maxRetries)],
    ['OUTPUT_DIR', config.outputDir],
    ['SEC_YIELD', configRangeValue(config.secYieldRange)],
    ['SKIP_YAHOO', String(config.skipYahoo)],
    ['TER', configRangeValue(config.terRange)],
    ['TICKERS', config.tickers.join(',') || 'all'],
  ];
  for (const period of RETURN_PERIODS) {
    values.push([`PERFORMANCE_${period}`, configRangeValue(config.performanceRanges[period])]);
  }
  for (const period of RETURN_PERIODS) {
    values.push([`TOTAL_RETURN_${period}`, configRangeValue(config.totalReturnRanges[period])]);
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return values.sort(([a], [b]) => {
    const ai = first.indexOf(a);
    const bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}

function outputVerbose(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.VERBOSE ?? '');
}

function outputClean(value: unknown): string {
  return String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
}

function outputNote(message: string): void {
  if (outputVerbose()) console.warn(message);
}

function outputPrintConfig(brand: string, config: UpdaterConfig): void {
  const entries = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())] as [string, string]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}

function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}

function outputHasOutputFilters(config: UpdaterConfig): boolean {
  if (config.tickers.length || config.categories.length) return true;
  const ranges = [config.aumRange, config.terRange, config.dividendYieldRange, config.secYieldRange,
    ...RETURN_PERIODS.map(period => config.performanceRanges[period]),
    ...RETURN_PERIODS.map(period => config.totalReturnRanges[period])];
  return ranges.some(rangeActive);
}

/** Timestamp-insensitive, recursively key-sorted representation for logs and write guards. */
export function outputStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort()
      .filter(key => !['generatedAt', 'catalogReadAt'].includes(key))
      .map(key => [key, outputStable(record[key])]));
  }
  return value;
}

export function outputContentKey(value: unknown): string {
  return JSON.stringify(outputStable(value)) ?? 'null';
}

export function samePublishedContent(left: unknown, right: unknown): boolean {
  return outputContentKey(left) === outputContentKey(right);
}

export type PageFile<T> = { ticker: string; page: number; pageSize: number; totalRows: number; headers: string[]; rows: T[] };

export function buildPages<T>(ticker: string, headers: string[], rows: T[], pageSize: number): PageFile<T>[] {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error(`pageSize must be a positive integer, got ${pageSize}`);
  const pages: PageFile<T>[] = [];
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    pages.push({ ticker, page: pages.length + 1, pageSize, totalRows: rows.length, headers: [...headers], rows: rows.slice(offset, offset + pageSize) });
  }
  return pages;
}

export function pageFileNames(kind: 'holdings' | 'history', pageCount: number): string[] {
  return Array.from({ length: pageCount }, (_unused, index) => `${kind}/${String(index + 1).padStart(3, '0')}.json`);
}

export function outputCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.totalRows === 'number') return record.totalRows;
    if (Array.isArray(record.rows)) return record.rows.length;
  }
  return null;
}

export function outputScalar(value: unknown): unknown {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return record.display ?? record.value ?? null;
  }
  return value;
}

export function outputMoney(value: unknown): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const units: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  const number = Number(match[1]) * (match[2] ? units[match[2].toUpperCase()] : 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}

export function outputFundLine(index: number, total: number, ticker: string, status: string, data: Record<string, unknown> = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics && typeof data.metrics === 'object' ? data.metrics as Record<string, unknown> : {};
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const history = data.history ?? data.historyCount;
  const holdings = data.holdings ?? data.holdingsCount;
  const distributions = data.distributions ?? data.dividends;
  const detail = [
    field('history', outputCount(history)),
    field('holdings', outputCount(holdings)),
    field('divs', outputCount(distributions)),
    field('netAssets', outputMoney(data.aumValue ?? data.aum)),
    field('div', outputScalar(metrics.dividendYield ?? data.dividendYield)),
    field('sec', outputScalar(metrics.secYield ?? data.secYield)),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}

export type FundSnapshot = { digest: string; meta: Record<string, unknown> };

export async function outputInspectFund(root: string, ticker: string): Promise<FundSnapshot> {
  const dir = join(root, 'funds', ticker);
  const hash = createHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.name.endsWith('.json')) {
        const text = await readFile(entryPath, 'utf8').catch(() => '');
        hash.update(entryPath.slice(dir.length));
        try {
          hash.update(outputContentKey(JSON.parse(text)));
        } catch {
          hash.update(text);
        }
      }
    }
  }
  await visit(dir);
  const metaValue = await readFile(join(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const meta = metaValue && typeof metaValue === 'object' && !Array.isArray(metaValue) ? metaValue as Record<string, unknown> : {};
  return { digest: hash.digest('hex'), meta };
}

export function outputCreateReporter(root: string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: FundSnapshot, status?: string, reason?: unknown, extra: Record<string, unknown> = {}): Promise<void> {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}

export function createRequestGate(
  concurrency: number,
  sleepMilliseconds: number,
  now: () => number = Date.now,
  sleep: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)),
): { pace: () => Promise<void> } {
  const laneCount = Math.max(1, Math.floor(concurrency));
  const lanes = Array.from({ length: laneCount }, () => ({ nextAllowedAt: 0, lastUsed: 0, tail: Promise.resolve() }));
  let sequence = 0;
  return {
    async pace(): Promise<void> {
      let laneIndex = 0;
      for (let index = 1; index < lanes.length; index += 1) {
        if (lanes[index].lastUsed < lanes[laneIndex].lastUsed) laneIndex = index;
      }
      const lane = lanes[laneIndex];
      lane.lastUsed = ++sequence;
      const work = lane.tail.then(async () => {
        const waitMilliseconds = Math.max(0, lane.nextAllowedAt - now());
        if (waitMilliseconds > 0) await sleep(waitMilliseconds);
        lane.nextAllowedAt = now() + sleepMilliseconds;
      });
      lane.tail = work.then(() => undefined, () => undefined);
      return work;
    },
  };
}

/** Build stable timestamp-insensitive JSON outputs without rewriting unchanged published content. */
export async function writeJsonIfChanged(filePath: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true });
  const previous = await readFile(filePath, 'utf8').then(JSON.parse).catch(() => null);
  if (previous !== null && samePublishedContent(previous, value)) return false;
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return true;
}

export async function readJsonFile(filePath: string): Promise<unknown | null> {
  return readFile(filePath, 'utf8').then(JSON.parse).catch(() => null);
}

export async function removeFileIfExists(filePath: string): Promise<void> {
  await unlink(filePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}
