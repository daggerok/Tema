#!/usr/bin/env bun
/// <reference types="bun" />

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

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
    name: catalogName && catalogName.toUpperCase() !== expectedTicker ? catalogName : heading,
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
  historyRange: string;
  secUserAgent: string;
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

function parseHistoryRange(raw: string | undefined): string {
  const value = (raw ?? 'max').trim().toLowerCase() || 'max';
  if (value !== 'max' && !/^\d+y$/.test(value)) throw new Error(`HISTORY_RANGE must be max or a number of years (for example 10y), got ${value}`);
  return value;
}

export function readUpdaterConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  const outputDir = resolve(envValue(env, 'OUTPUT_DIR') ?? 'api/tema');
  return {
    maxFetches: parsePositiveInt(envValue(env, 'MAX_FETCHES', ['TEMA_LIMIT']), 0, true),
    requestSleepSeconds: parseDecimal(envValue(env, 'REQUEST_SLEEP'), 1),
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), 2),
    maxRetries: parsePositiveInt(envValue(env, 'MAX_RETRIES'), 2),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), 250),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE'), 1000),
    historyRange: parseHistoryRange(envValue(env, 'HISTORY_RANGE')),
    secUserAgent: envValue(env, 'SEC_UA') ?? 'daggerok ETF feed daggerok@gmail.com',
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

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

// File defaults and explicit overrides, same mechanism as the sibling updaters:
// allowlisted scalar controls only, so GitHub Actions can resolve them without
// interpolating user input into bash. Precedence: config file < advanced JSON <
// nonblank inputs < environment (the older TEMA_LIMIT / ASSET_CLASS names remain aliases).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap(prefix => RETURN_PERIODS.map(period => `${prefix}_${period}`)),
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'OUTPUT_DIR',
  'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SEC_UA', 'VERBOSE', 'USE_SYSTEM_CA',
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
const CONTROL_ALIASES: Record<string, string[]> = { MAX_FETCHES: ['TEMA_LIMIT'], CATEGORY: ['ASSET_CLASS'] };

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = env[key] ?? (CONTROL_ALIASES[key] ?? []).map(alias => env[alias]).find(item => item !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  if (result.VERBOSE && !/^(0|1|true|false|yes|no|on|off)$/i.test(result.VERBOSE.trim())) throw new Error(`VERBOSE: expected boolean, got ${result.VERBOSE}`);
  if (result.USE_SYSTEM_CA !== undefined) {
    const mode = result.USE_SYSTEM_CA.trim().toLowerCase();
    if (!['auto', 'true', 'false'].includes(mode)) throw new Error(`USE_SYSTEM_CA: expected auto, true or false, got ${result.USE_SYSTEM_CA}`);
    result.USE_SYSTEM_CA = mode;
  }
  readUpdaterConfig(result); // validate every integer, boolean, range and filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  const file: unknown = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8'));
  return resolveControls(file, {}, {}, env);
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
    ['HISTORY_RANGE', config.historyRange],
    ['HOLDINGS_PAGE_SIZE', String(config.holdingsPageSize)],
    ['MAX_RETRIES', String(config.maxRetries)],
    ['OUTPUT_DIR', config.outputDir],
    ['SEC_UA', config.secUserAgent],
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
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
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
      const reportData = { ...after.meta, ...extra };
      const publishedDistributions = recordOf(after.meta.distributions);
      if (outputCount(reportData.distributions) === null && outputCount(publishedDistributions) !== null) reportData.distributions = publishedDistributions;
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), reportData, reason));
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

export function decodeTemaCsv(bytes: Uint8Array, contentType = ''): string {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? 'utf-8';
  if (/^(x-)?mac-?roman$|^macintosh$/.test(charset)) return new TextDecoder('macintosh').decode(bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };
export type ChartDividend = { date: string; amount: number };
export type ParsedYahooChart = {
  exchangeName: string;
  longName: string;
  currency: string;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  firstTradeDate: number | null;
  days: ChartDay[];
  dividends: ChartDividend[];
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,%\s,]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function epochToIsoDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) return '';
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Parse Yahoo chart history while rounding adjusted close to two decimals to eliminate source jitter. */
export function parseYahooChart(payload: unknown): ParsedYahooChart {
  const chart = recordOf(recordOf(payload).chart);
  const error = chart.error;
  if (error) throw new Error(`Yahoo chart error: ${JSON.stringify(error)}`);
  const resultList = Array.isArray(chart.result) ? chart.result : [];
  const result = recordOf(resultList[0]);
  if (!resultList.length) throw new Error('Yahoo chart returned an empty result');
  const meta = recordOf(result.meta);
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const indicators = recordOf(result.indicators);
  const quote = recordOf((Array.isArray(indicators.quote) ? indicators.quote : [])[0]);
  const adjusted = recordOf((Array.isArray(indicators.adjclose) ? indicators.adjclose : [])[0]);
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const adjustedCloses = Array.isArray(adjusted.adjclose) ? adjusted.adjclose : closes;
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];
  const days: ChartDay[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = numberOrNull(timestamps[index]);
    const close = numberOrNull(closes[index]);
    if (timestamp === null || close === null) continue;
    const adjustedClose = numberOrNull(adjustedCloses[index]) ?? close;
    const date = epochToIsoDate(timestamp);
    if (!date) continue;
    days.push({
      date,
      close: roundTo(close, 6),
      adjClose: roundTo(adjustedClose, 2),
      volume: numberOrNull(volumes[index]) ?? 0,
    });
  }
  const eventObject = recordOf(recordOf(result.events).dividends);
  const dividends = Object.entries(eventObject).flatMap(([epochKey, rawEvent]) => {
    const event = recordOf(rawEvent);
    const epoch = numberOrNull(event.date) ?? numberOrNull(epochKey);
    const amount = numberOrNull(event.amount);
    if (epoch === null || amount === null || amount <= 0) return [];
    const date = epochToIsoDate(epoch);
    return date ? [{ date, amount: roundTo(amount, 6) }] : [];
  }).sort((a, b) => a.date.localeCompare(b.date));
  return {
    exchangeName: String(meta.fullExchangeName ?? meta.exchangeName ?? ''),
    longName: String(meta.longName ?? meta.shortName ?? ''),
    currency: String(meta.currency ?? ''),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days: days.sort((a, b) => a.date.localeCompare(b.date)),
    dividends,
  };
}

export function yahooChartUrl(ticker: string, historyRange: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  let period1 = 0;
  const years = /^(\d+)y$/.exec(historyRange.toLowerCase());
  if (years) period1 = Math.floor(nowSeconds - Number(years[1]) * 365.25 * 86_400);
  const params = new URLSearchParams({ period1: String(period1), period2: String(nowSeconds), interval: '1d', events: 'div,splits' });
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?${params.toString()}`;
}

export type FrequencyResult = { frequency: string; paymentsPerYear: number | null };

export function inferDistributionFrequency(dividends: ChartDividend[]): FrequencyResult {
  if (dividends.length < 3) return { frequency: 'Unknown', paymentsPerYear: null };
  const sorted = [...dividends].sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-8);
  const gaps = recent.slice(1).map((item, index) => {
    const start = new Date(`${recent[index].date}T00:00:00Z`).getTime();
    const end = new Date(`${item.date}T00:00:00Z`).getTime();
    return (end - start) / 86_400_000;
  }).filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!gaps.length) return { frequency: 'Unknown', paymentsPerYear: null };
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median >= 300) return { frequency: 'Annually', paymentsPerYear: 1 };
  if (median >= 150) return { frequency: 'Semi-annually', paymentsPerYear: 2 };
  if (median >= 75) return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (median >= 25) return { frequency: 'Monthly', paymentsPerYear: 12 };
  return { frequency: 'Irregular', paymentsPerYear: null };
}

export type PeriodReturnMetrics = {
  asOfDate: string;
  mo1: number | null;
  qtd: number | null;
  ytd: number | null;
  yr1: number | null;
  yr3: number | null;
  yr5: number | null;
  yr10: number | null;
  sinceInception: number | null;
};

export type DerivedTemaMetrics = {
  metrics: Record<string, number | string | null>;
  monthEnd: PeriodReturnMetrics;
  quarterEnd: PeriodReturnMetrics;
  dividendYield: number | null;
  latestDividend: ChartDividend | null;
  frequency: FrequencyResult;
};

function dayAtOrBefore(days: ChartDay[], isoDate: string): ChartDay | null {
  for (let index = days.length - 1; index >= 0; index -= 1) if (days[index].date <= isoDate) return days[index];
  return null;
}

export function shiftIsoDate(isoDate: string, years: number, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const monthIndex = month - 1 + months;
  const targetYear = year + years + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
  return epochToIsoDate(target.getTime() / 1000);
}

function percentChange(start: ChartDay | null, end: ChartDay | null): number | null {
  if (!start || !end || start.adjClose <= 0) return null;
  return roundTo(((end.adjClose / start.adjClose) - 1) * 100, 2);
}

function annualizedReturn(start: ChartDay | null, end: ChartDay | null, years: number): number | null {
  if (!start || !end || start.adjClose <= 0 || years <= 0) return null;
  return roundTo(((end.adjClose / start.adjClose) ** (1 / years) - 1) * 100, 2);
}

function rangeReturnAtAnchor(days: ChartDay[], anchor: ChartDay): PeriodReturnMetrics {
  const date = anchor.date;
  const year = Number(date.slice(0, 4));
  const previousMonthEnd = dayAtOrBefore(days, shiftIsoDate(date, 0, -1));
  const previousQuarterMonth = Math.floor((Number(date.slice(5, 7)) - 1) / 3) * 3 - 1;
  const quarterStart = new Date(Date.UTC(year, previousQuarterMonth + 1, 0));
  const previousQuarterEnd = dayAtOrBefore(days, epochToIsoDate(quarterStart.getTime() / 1000));
  const priorYearEnd = dayAtOrBefore(days, `${year - 1}-12-31`);
  const oneYear = dayAtOrBefore(days, shiftIsoDate(date, -1, 0));
  const threeYear = dayAtOrBefore(days, shiftIsoDate(date, -3, 0));
  const fiveYear = dayAtOrBefore(days, shiftIsoDate(date, -5, 0));
  const tenYear = dayAtOrBefore(days, shiftIsoDate(date, -10, 0));
  const first = days[0] ?? null;
  const sinceYears = first ? (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${first.date}T00:00:00Z`).getTime()) / (365.25 * 86_400_000) : 0;
  return {
    asOfDate: formatDateLabel(date),
    mo1: percentChange(previousMonthEnd, anchor),
    qtd: percentChange(previousQuarterEnd, anchor),
    ytd: percentChange(priorYearEnd, anchor),
    yr1: percentChange(oneYear, anchor),
    yr3: annualizedReturn(threeYear, anchor, 3),
    yr5: annualizedReturn(fiveYear, anchor, 5),
    yr10: annualizedReturn(tenYear, anchor, 10),
    sinceInception: sinceYears >= 0.75 ? annualizedReturn(first, anchor, sinceYears) : null,
  };
}

function lastPeriodEnd(days: ChartDay[], monthsPerPeriod: number): ChartDay | null {
  const latest = days[days.length - 1];
  if (!latest) return null;
  const [year, month, day] = latest.date.split('-').map(Number);
  const startMonth = Math.floor((month - 1) / monthsPerPeriod) * monthsPerPeriod;
  let periodEnd = new Date(Date.UTC(year, startMonth + monthsPerPeriod, 0));
  if (new Date(`${latest.date}T00:00:00Z`).getTime() < periodEnd.getTime()) periodEnd = new Date(Date.UTC(year, startMonth, 0));
  return dayAtOrBefore(days, epochToIsoDate(periodEnd.getTime() / 1000));
}

export function deriveTemaMetrics(chart: ParsedYahooChart): DerivedTemaMetrics {
  const days = chart.days;
  const dividends = chart.dividends;
  const latest = days[days.length - 1] ?? null;
  const latestDividend = dividends[dividends.length - 1] ?? null;
  const frequency = inferDistributionFrequency(dividends);
  let dividendYield: number | null = null;
  if (latest && latest.close > 0 && dividends.length) {
    const cutoff = shiftIsoDate(latest.date, -1, 0);
    const trailing = dividends.filter(dividend => dividend.date >= cutoff && dividend.date <= latest.date).reduce((sum, dividend) => sum + dividend.amount, 0);
    dividendYield = roundTo(trailing / latest.close * 100, 2);
  }
  if (!latest) {
    return {
      metrics: { ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, dividendYield, secYield: null },
      monthEnd: { asOfDate: '', mo1: null, qtd: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      quarterEnd: { asOfDate: '', mo1: null, qtd: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null },
      dividendYield, latestDividend, frequency,
    };
  }
  const latestReturns = rangeReturnAtAnchor(days, latest);
  const monthAnchor = lastPeriodEnd(days, 1) ?? latest;
  const quarterAnchor = lastPeriodEnd(days, 3) ?? latest;
  const monthEnd = rangeReturnAtAnchor(days, monthAnchor);
  const quarterEnd = rangeReturnAtAnchor(days, quarterAnchor);
  const cagr3y = latestReturns.yr3;
  const cagr5y = latestReturns.yr5;
  const cagr10y = latestReturns.yr10;
  return {
    metrics: {
      ytd: latestReturns.ytd,
      tr1y: latestReturns.yr1,
      tr3y: cagr3y === null ? null : roundTo(((1 + cagr3y / 100) ** 3 - 1) * 100, 2),
      tr5y: cagr5y === null ? null : roundTo(((1 + cagr5y / 100) ** 5 - 1) * 100, 2),
      tr10y: cagr10y === null ? null : roundTo(((1 + cagr10y / 100) ** 10 - 1) * 100, 2),
      cagr3y,
      cagr5y,
      cagr10y,
      siAnn: latestReturns.sinceInception,
      dividendYield,
      secYield: null,
    },
    monthEnd,
    quarterEnd,
    dividendYield,
    latestDividend,
    frequency,
  };
}

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };
export type ParsedNport = {
  regName: string;
  regCik: string;
  seriesName: string;
  seriesId: string;
  reportDate: string;
  holdings: Array<Record<string, string>>;
  netAssets: number | null;
};

export const TEMA_ETF_TRUST_CIK = '0001944285';

export function nportUrlFor(cik: string, accession: string): string {
  const numericCik = String(Number(cik.replace(/\D/g, '')));
  return `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}

export function parseTemaFundTickerTable(payload: unknown, trustCik = TEMA_ETF_TRUST_CIK): Map<string, NportSeriesRef> {
  const record = recordOf(payload);
  const fields = Array.isArray(record.fields) ? record.fields.map(value => String(value)) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const column = (row: unknown[], name: string): string => {
    const index = fields.indexOf(name);
    return index >= 0 ? String(row[index] ?? '') : '';
  };
  const wantedCik = String(Number(trustCik.replace(/\D/g, '')));
  const map = new Map<string, NportSeriesRef>();
  for (const value of rows) {
    if (!Array.isArray(value)) continue;
    const ticker = column(value, 'symbol').trim().toUpperCase();
    const rawCik = column(value, 'cik').replace(/\D/g, '');
    if (!ticker || String(Number(rawCik)) !== wantedCik) continue;
    map.set(ticker, {
      cik: rawCik.padStart(10, '0'),
      seriesId: column(value, 'seriesId').toUpperCase(),
      classId: column(value, 'classId').toUpperCase(),
    });
  }
  return map;
}

export function parseCompanyTickerMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const records = recordOf(payload);
  for (const value of Object.values(records)) {
    const company = recordOf(value);
    const ticker = String(company.ticker ?? '').trim().toUpperCase();
    const title = String(company.title ?? '').trim();
    if (!ticker || !title) continue;
    map.set(title.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim(), ticker);
  }
  return map;
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'");
}

function xmlTag(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i');
  const match = pattern.exec(xml);
  return match ? decodeXml(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

export function parseNportAccessions(payload: unknown): NportAccession[] {
  const submissions = recordOf(payload);
  const recent = recordOf(recordOf(submissions.filings).recent);
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const reportDates = Array.isArray(recent.reportDate) ? recent.reportDate : [];
  const cik = String(submissions.cik ?? TEMA_ETF_TRUST_CIK).replace(/\D/g, '');
  const result: NportAccession[] = [];
  for (let index = 0; index < forms.length; index += 1) {
    if (String(forms[index]).toUpperCase() !== 'NPORT-P') continue;
    const accession = String(accessions[index] ?? '');
    if (!accession) continue;
    result.push({
      accession,
      filed: String(filingDates[index] ?? ''),
      reportDate: String(reportDates[index] ?? ''),
      url: nportUrlFor(cik, accession),
    });
  }
  return result;
}

export function parseEdgarAtomFilings(xml: string): NportAccession[] {
  const result: NportAccession[] = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = match[1];
    const form = xmlTag(body, 'filing-type') || xmlTag(body, 'type');
    if (form && form.toUpperCase() !== 'NPORT-P') continue;
    const accession = xmlTag(body, 'accession-number') || xmlTag(body, 'accession-nunber');
    if (!accession) continue;
    const filingHref = xmlTag(body, 'filing-href');
    const cik = /\/edgar\/data\/(\d+)\//i.exec(filingHref)?.[1] ?? TEMA_ETF_TRUST_CIK;
    result.push({
      accession,
      filed: xmlTag(body, 'filing-date'),
      reportDate: xmlTag(body, 'period'),
      url: nportUrlFor(cik, accession),
    });
  }
  return result;
}

export function parseNport(xml: string): ParsedNport {
  const genInfo = /<genInfo\b[^>]*>([\s\S]*?)<\/genInfo\s*>/i.exec(xml)?.[1] ?? xml.slice(0, 4000);
  const fundInfo = /<fundInfo\b[^>]*>([\s\S]*?)<\/fundInfo\s*>/i.exec(xml)?.[1] ?? '';
  const holdings: Array<Record<string, string>> = [];
  for (const match of xml.matchAll(/<invstOrSec\b[^>]*>([\s\S]*?)<\/invstOrSec\s*>/gi)) {
    const body = match[1];
    const name = xmlTag(body, 'name') || xmlTag(body, 'title') || 'Unnamed security';
    const cusip = xmlTag(body, 'cusip');
    const alternate = /<(?:isin|sedol|other|cusip)\b[^>]*\bvalue=["']([^"']+)["']/i.exec(body)?.[1] ?? '';
    const identifier = cusip && !/^n\/?a$/i.test(cusip) ? cusip : decodeXml(alternate);
    const pctValue = numberOrNull(xmlTag(body, 'pctVal'));
    const marketValue = numberOrNull(xmlTag(body, 'valUSD')) ?? numberOrNull(xmlTag(body, 'curVal'));
    const shares = xmlTag(body, 'balance');
    holdings.push({
      Name: name,
      Ticker: '',
      Identifier: identifier || name,
      Weight: pctValue === null ? '' : String(pctValue),
      'Market Value': marketValue === null ? '' : String(marketValue),
      'Shares Held': shares,
      'Asset Category': xmlTag(body, 'assetCat'),
      Country: '',
      Sector: '',
      Cash: /cash/i.test(xmlTag(body, 'assetCat')) ? 'Yes' : '',
    });
  }
  return {
    regName: xmlTag(genInfo, 'regName'),
    regCik: xmlTag(genInfo, 'regCik'),
    seriesName: xmlTag(genInfo, 'seriesName'),
    seriesId: xmlTag(genInfo, 'seriesId'),
    reportDate: normalizeTemaDate(xmlTag(genInfo, 'repPdDate')),
    holdings,
    netAssets: numberOrNull(xmlTag(fundInfo, 'netAssets')),
  };
}

export function edgarSeriesFilingsUrl(seriesId: string, count = 10): string {
  const params = new URLSearchParams({ action: 'getcompany', CIK: seriesId.toUpperCase(), type: 'NPORT-P', owner: 'include', count: String(count), output: 'atom' });
  return `https://www.sec.gov/cgi-bin/browse-edgar?${params.toString()}`;
}

export function fillNportTickers(rows: Array<Record<string, string>>, tickerMap: Map<string, string>): Array<Record<string, string>> {
  return rows.map(row => {
    if (row.Ticker) return row;
    const key = row.Name.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    const ticker = tickerMap.get(key);
    return ticker ? { ...row, Ticker: ticker } : row;
  });
}

export function retainCatalogEntries(current: TemaFund[], previousValue: unknown): TemaFund[] {
  const previousRows = Array.isArray(previousValue) ? previousValue : [];
  const previousByTicker = new Map<string, Record<string, unknown>>();
  for (const value of previousRows) {
    const row = recordOf(value);
    const ticker = String(row.ticker ?? '').trim().toUpperCase();
    if (ticker) previousByTicker.set(ticker, row);
  }
  const currentTickers = new Set(current.map(fund => fund.ticker.toUpperCase()));
  const merged = current.map(fund => {
    const previous = previousByTicker.get(fund.ticker.toUpperCase());
    const oldName = typeof previous?.name === 'string' ? previous.name : '';
    const name = fund.name === fund.ticker && oldName.length > fund.ticker.length ? oldName : fund.name;
    return { ...fund, name };
  });
  for (const [ticker, previous] of previousByTicker) {
    if (currentTickers.has(ticker)) continue;
    const name = typeof previous.name === 'string' && previous.name ? previous.name : ticker;
    const fundPage = typeof previous.fundPage === 'string' ? previous.fundPage : `https://temaetfs.com/${ticker.toLowerCase()}`;
    merged.push({ ticker, name, fundPage });
  }
  return merged.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function selectUpdateBatch<T extends { ticker: string }>(
  candidates: T[],
  lastTicker: string | null,
  maxFetches: number,
  explicitTickers: string[] = [],
): T[] {
  if (!Number.isSafeInteger(maxFetches) || maxFetches < 0) throw new Error(`MAX_FETCHES must be a non-negative integer, got ${maxFetches}`);
  const requested = new Set(explicitTickers.map(ticker => ticker.toUpperCase()));
  const eligible = requested.size ? candidates.filter(item => requested.has(item.ticker.toUpperCase())) : [...candidates];
  if (maxFetches === 0 || eligible.length <= maxFetches) return eligible;
  if (requested.size) return eligible.slice(0, maxFetches);
  const cursor = lastTicker?.toUpperCase() ?? '';
  const cursorIndex = eligible.findIndex(item => item.ticker.toUpperCase() === cursor);
  const start = cursorIndex < 0 ? 0 : (cursorIndex + 1) % eligible.length;
  return Array.from({ length: eligible.length }, (_unused, offset) => eligible[(start + offset) % eligible.length]).slice(0, maxFetches);
}

function emptyReturnSet(): PeriodReturnMetrics {
  return { asOfDate: '', mo1: null, qtd: null, ytd: null, yr1: null, yr3: null, yr5: null, yr10: null, sinceInception: null };
}

export function minimalIndexFund(fund: TemaFund, previousValue: unknown = null): Record<string, unknown> {
  const previous = recordOf(previousValue);
  const base: Record<string, unknown> = {
    ticker: fund.ticker,
    name: fund.name,
    category: 'Equity',
    fundPage: fund.fundPage,
    dataFile: `./funds/${fund.ticker}/meta.json`,
    cusip: null,
    isin: null,
    ter: '—',
    terValue: null,
    nav: '—',
    navValue: null,
    aum: '—',
    aumValue: null,
    asOfDate: '',
    inceptionDate: '',
    exchange: '',
    closePrice: '—',
    closePriceValue: null,
    premiumDiscount: '—',
    premiumDiscountValue: null,
    distributions: { frequency: null, exDate: null, dividend: null },
    returns: { monthEnd: emptyReturnSet(), quarterEnd: emptyReturnSet() },
    metrics: { ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, dividendYield: null, secYield: null },
    holdings: 0,
    history: 0,
  };
  return { ...base, ...previous, ticker: fund.ticker, name: fund.name, fundPage: fund.fundPage, dataFile: `./funds/${fund.ticker}/meta.json` };
}

export function buildIndexDocument(funds: Array<Record<string, unknown>>, generatedAt: string, catalogReadAt: string): Record<string, unknown> {
  return {
    generatedAt,
    catalogReadAt,
    source: {
      catalog: 'https://temaetfs.com/funds',
      holdings: 'Tema ETFs official fund pages and daily HubSpot CSVs',
      history: 'Yahoo Finance chart API (adjusted-close total-return proxy)',
      nportRegistrant: 'SEC EDGAR Form N-PORT-P, Tema ETF Trust CIK 0001944285 (holdings fallback only)',
    },
    counts: {
      funds: funds.length,
      holdings: funds.reduce((sum, fund) => sum + (outputCount(fund.holdings) ?? 0), 0),
      history: funds.reduce((sum, fund) => sum + (outputCount(fund.history) ?? 0), 0),
    },
    funds,
  };
}

export type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string; source: string };

async function removeStalePageFiles(directory: string, keep: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{3}\.json$/.test(entry.name) || keep.has(entry.name)) continue;
    await unlink(join(directory, entry.name));
  }
}

export async function writeFundPages(
  outputDir: string,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: Array<Record<string, string>>,
  pageSize: number,
  asOfDate: string,
  source: string,
): Promise<PageManifest> {
  const directory = join(outputDir, 'funds', ticker, kind);
  const pages = buildPages(ticker, headers, rows, pageSize);
  const names = pageFileNames(kind, pages.length);
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < pages.length; index += 1) {
    await writeJsonIfChanged(join(directory, names[index].split('/')[1]), pages[index]);
  }
  await removeStalePageFiles(directory, new Set(names.map(name => name.split('/')[1])));
  return { pages: names, pageSize, totalRows: rows.length, asOfDate, source };
}

export type HttpGate = { pace: () => Promise<void> };
export type HttpClientOptions = {
  gate: HttpGate;
  retries: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};
export type PacedHttpClient = { fetch: (input: string | URL, init?: RequestInit) => Promise<Response> };

export function isRetryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

export function retryDelayMilliseconds(retryAfter: string | null, attempt: number, now = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.round(seconds * 1000));
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(120_000, at - now));
  }
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
}

/** Fetch wrapper with per-provider pacing, bounded retries, and no request-header logging. */
export function createPacedHttpClient(options: HttpClientOptions): PacedHttpClient {
  if (!Number.isSafeInteger(options.retries) || options.retries < 0) throw new Error(`retries must be a non-negative integer, got ${options.retries}`);
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const sleep = options.sleep ?? (milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)));
  const now = options.now ?? Date.now;
  return {
    async fetch(input, init = {}): Promise<Response> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= options.retries; attempt += 1) {
        await options.gate.pace();
        const headers = new Headers(init.headers);
        if (options.userAgent && !headers.has('user-agent')) headers.set('user-agent', options.userAgent);
        try {
          const response = await fetchImpl(input, { ...init, headers });
          if (attempt >= options.retries || !isRetryableHttpStatus(response.status)) return response;
          const delay = retryDelayMilliseconds(response.headers.get('retry-after'), attempt, now());
          await response.body?.cancel().catch(() => undefined);
          await sleep(delay);
        } catch (error) {
          if (init.signal?.aborted || attempt >= options.retries) throw error;
          lastError = error;
          await sleep(retryDelayMilliseconds(null, attempt, now()));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('HTTP request failed after retries');
    },
  };
}

export function createProviderHttpClients(config: Pick<UpdaterConfig, 'concurrency' | 'requestSleepSeconds' | 'maxRetries' | 'secUserAgent'>, fetchImpl?: typeof fetch) {
  const make = (userAgent: string) => createPacedHttpClient({
    gate: createRequestGate(config.concurrency, Math.round(config.requestSleepSeconds * 1000)),
    retries: config.maxRetries,
    userAgent,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    issuer: make('Mozilla/5.0 (compatible; TemaETFWatchlist/1.0)'),
    yahoo: make('Mozilla/5.0 (compatible; TemaETFWatchlist/1.0)'),
    sec: make(config.secUserAgent),
  };
}

function safeRequestPath(input: string | URL): string {
  try {
    const url = new URL(input);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'request';
  }
}

export async function responseText(client: PacedHttpClient, input: string | URL, init?: RequestInit): Promise<string> {
  const response = await client.fetch(input, init);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const statusText = response.statusText.trim();
    throw new Error(`HTTP ${response.status}${statusText ? ` ${statusText}` : ''} for ${safeRequestPath(input)}`);
  }
  return response.text();
}

export async function responseBytes(client: PacedHttpClient, input: string | URL, init?: RequestInit): Promise<{ bytes: Uint8Array; contentType: string }> {
  const response = await client.fetch(input, init);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const statusText = response.statusText.trim();
    throw new Error(`HTTP ${response.status}${statusText ? ` ${statusText}` : ''} for ${safeRequestPath(input)}`);
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? '' };
}

export async function responseJson(client: PacedHttpClient, input: string | URL, init?: RequestInit): Promise<unknown> {
  const text = await responseText(client, input, init);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON response from ${safeRequestPath(input)}`);
  }
}

export const SEC_COMPANY_TICKERS_MF_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
export const SEC_SUBMISSIONS_URL = `https://data.sec.gov/submissions/CIK${TEMA_ETF_TRUST_CIK}.json`;
export type NportMatch = { accession: NportAccession; report: ParsedNport };
export type NportResolver = (fund: Pick<TemaFund, 'ticker' | 'name'>) => Promise<NportMatch | null>;

export function resolveTemaNportSeriesRef(ticker: string, seriesMap: Map<string, NportSeriesRef>): NportSeriesRef | null {
  const normalized = ticker.trim().toUpperCase();
  const candidates = normalized === 'WELD' ? ['WELD', 'RSHO'] : normalized === 'RSHO' ? ['RSHO', 'WELD'] : [normalized];
  for (const candidate of candidates) {
    const reference = seriesMap.get(candidate);
    if (reference?.seriesId) return reference;
  }
  return null;
}

function comparableSeriesWords(value: string): string[] {
  const ignored = new Set(['TEMA', 'ETF', 'FUND', 'TRUST', 'SERIES', 'STRATEGY', 'THE', 'AND', 'OF', 'AT', 'FOR']);
  return [...new Set(value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').split(/\s+/).filter(word => word.length > 2 && !ignored.has(word)))];
}

export function nportSeriesMatchesFund(report: ParsedNport, ticker: string, fundName: string): boolean {
  const seriesName = report.seriesName.trim();
  if (!seriesName) return false;
  const normalizedTicker = ticker.trim().toUpperCase();
  if (normalizedTicker && new RegExp(`(?:^|[^A-Z0-9])${normalizedTicker}(?:$|[^A-Z0-9])`).test(seriesName.toUpperCase())) return true;
  const desired = comparableSeriesWords(fundName);
  const actual = new Set(comparableSeriesWords(seriesName));
  if (!desired.length) return false;
  const overlap = desired.filter(word => actual.has(word)).length;
  return overlap >= 2 && overlap / desired.length >= 0.7;
}

/** SEC series Atom endpoints can be blocked; scan the trust's recent submissions instead. */
export function createNportResolver(
  client: PacedHttpClient,
  options: { concurrency?: number; maxDocuments?: number; tickerMapUrl?: string; submissionsUrl?: string } = {},
): NportResolver {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
  const maxDocuments = Math.min(500, Math.max(1, Math.floor(options.maxDocuments ?? 160)));
  const tickerMapUrl = options.tickerMapUrl ?? SEC_COMPANY_TICKERS_MF_URL;
  const submissionsUrl = options.submissionsUrl ?? SEC_SUBMISSIONS_URL;
  let tickerMapPromise: Promise<Map<string, NportSeriesRef>> | null = null;
  let accessionPromise: Promise<NportAccession[]> | null = null;
  const reportBySeriesId = new Map<string, NportMatch>();
  const scannedReports: NportMatch[] = [];
  const resolvedByKey = new Map<string, Promise<NportMatch | null>>();
  let scanIndex = 0;
  let scanTail: Promise<void> = Promise.resolve();

  const getTickerMap = (): Promise<Map<string, NportSeriesRef>> => {
    if (!tickerMapPromise) {
      tickerMapPromise = responseJson(client, tickerMapUrl)
        .then(payload => parseTemaFundTickerTable(payload))
        .catch(error => {
          outputNote(`SEC ticker table unavailable; N-PORT name matching will be used: ${error instanceof Error ? error.message : 'request failed'}`);
          return new Map<string, NportSeriesRef>();
        });
    }
    return tickerMapPromise;
  };
  const getAccessions = (): Promise<NportAccession[]> => {
    if (!accessionPromise) {
      accessionPromise = responseJson(client, submissionsUrl)
        .then(parseNportAccessions)
        .catch(error => {
          outputNote(`SEC trust submissions unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
          return [];
        });
    }
    return accessionPromise;
  };

  async function readFiling(accession: NportAccession): Promise<NportMatch | null> {
    try {
      const xml = await responseText(client, accession.url);
      const report = parseNport(xml);
      if (!report.seriesId) return null;
      return { accession, report };
    } catch (error) {
      outputNote(`SEC N-PORT ${accession.accession} unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
      return null;
    }
  }

  async function scanFor(fund: Pick<TemaFund, 'ticker' | 'name'>, reference: NportSeriesRef | null): Promise<NportMatch | null> {
    const seriesId = reference?.seriesId.toUpperCase() ?? '';
    const matches = (entry: NportMatch): boolean => seriesId
      ? entry.report.seriesId.toUpperCase() === seriesId
      : nportSeriesMatchesFund(entry.report, fund.ticker, fund.name);
    const cached = seriesId ? reportBySeriesId.get(seriesId) : scannedReports.find(matches);
    if (cached) return cached;
    const operation = scanTail.then(async () => {
      const previousMatch = seriesId ? reportBySeriesId.get(seriesId) : scannedReports.find(matches);
      if (previousMatch) return previousMatch;
      const accessions = await getAccessions();
      const limit = Math.min(accessions.length, maxDocuments);
      while (scanIndex < limit) {
        const batch = accessions.slice(scanIndex, scanIndex + concurrency);
        scanIndex += batch.length;
        const reports = await Promise.all(batch.map(readFiling));
        for (const entry of reports) {
          if (!entry) continue;
          if (!reportBySeriesId.has(entry.report.seriesId.toUpperCase())) reportBySeriesId.set(entry.report.seriesId.toUpperCase(), entry);
          scannedReports.push(entry);
        }
        const found = reports.find((entry): entry is NportMatch => Boolean(entry && matches(entry)));
        if (found) return found;
      }
      return seriesId ? reportBySeriesId.get(seriesId) ?? null : scannedReports.find(matches) ?? null;
    });
    scanTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return async fund => {
    const seriesMap = await getTickerMap();
    const reference = resolveTemaNportSeriesRef(fund.ticker, seriesMap);
    const key = `${fund.ticker.toUpperCase()}|${reference?.seriesId ?? fund.name.toUpperCase()}`;
    let promise = resolvedByKey.get(key);
    if (!promise) {
      promise = scanFor(fund, reference);
      resolvedByKey.set(key, promise);
    }
    try {
      return await promise;
    } catch (error) {
      resolvedByKey.delete(key);
      throw error;
    }
  };
}

const HISTORY_HEADERS = ['Date', 'NAV', 'Market Price', 'Premium/Discount'];

export function formatTemaMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  for (const [scale, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (absolute >= scale) return `$${(value / scale).toFixed(2)} ${suffix}`;
  }
  return `$${value.toFixed(2)}`;
}

export function formatTemaPercent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}%`;
}

function isoDateToUs(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : '';
}

export function yahooHistoryRows(chart: ParsedYahooChart): Array<Record<string, string>> {
  return chart.days.map(day => ({
    Date: formatDateLabel(day.date),
    NAV: '',
    'Market Price': displayNumber(day.close, 6),
    'Premium/Discount': '',
  }));
}

export function yahooDistributionRows(chart: ParsedYahooChart): string[][] {
  return chart.dividends.map(dividend => [isoDateToUs(dividend.date), displayNumber(dividend.amount, 6)]);
}

export function buildPageManifest(
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: Array<Record<string, string>>,
  pageSize: number,
  asOfDate: string,
  source: string,
): PageManifest {
  const pageCount = buildPages(ticker, headers, rows, pageSize).length;
  return { pages: pageFileNames(kind, pageCount), pageSize, totalRows: rows.length, asOfDate, source };
}

function returnSetForMeta(value: PeriodReturnMetrics): Record<string, unknown> {
  return {
    ...value,
    mo1Text: formatTemaPercent(value.mo1),
    qtdText: formatTemaPercent(value.qtd),
    ytdText: formatTemaPercent(value.ytd),
    yr1Text: formatTemaPercent(value.yr1),
    yr3Text: formatTemaPercent(value.yr3),
    yr5Text: formatTemaPercent(value.yr5),
    yr10Text: formatTemaPercent(value.yr10),
    sinceInceptionText: formatTemaPercent(value.sinceInception),
  };
}

export type TemaMetaBuildInput = {
  fund: TemaFund;
  page: ParsedTemaFundPage | null;
  holdings: PageManifest | null;
  history: PageManifest | null;
  chart: ParsedYahooChart | null;
  derived: DerivedTemaMetrics | null;
  holdingsDownloadUrl: string | null;
  nport: NportMatch | null;
  generatedAt: string;
};

export function buildTemaFundMeta(input: TemaMetaBuildInput): Record<string, unknown> {
  const { fund, page, chart, derived, nport } = input;
  const latestDay = chart?.days.at(-1) ?? null;
  const latestPrice = chart?.regularMarketPrice ?? latestDay?.close ?? null;
  const netAssets = page?.aumValue ?? nport?.report.netAssets ?? null;
  const name = page?.name && page.name !== fund.ticker ? page.name : nport?.report.seriesName || fund.name;
  const asOfDate = page?.asOfDate || formatDateLabel(latestDay?.date ?? nport?.report.reportDate ?? '');
  const dividends = chart ? yahooDistributionRows(chart) : [];
  const frequency = derived?.frequency ?? { frequency: 'Unknown', paymentsPerYear: null };
  const chartReturns = derived ?? deriveTemaMetrics({ exchangeName: '', longName: '', currency: '', regularMarketPrice: null, regularMarketTime: null, firstTradeDate: null, days: [], dividends: [] });
  const stableYahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(fund.ticker)}`;
  const holdingsSource = input.holdings?.source ?? '';
  const historySource = input.history?.source ?? '';
  const holdingsDownload = input.holdingsDownloadUrl ? stablePublicUrl(input.holdingsDownloadUrl) : null;
  const frequencyCode = frequency.paymentsPerYear === 12 ? 'M' : frequency.paymentsPerYear === 4 ? 'Q' : frequency.paymentsPerYear === 2 ? 'S' : frequency.paymentsPerYear === 1 ? 'A' : null;
  const dividendYield = derived?.dividendYield ?? null;
  return {
    generatedAt: input.generatedAt,
    ticker: fund.ticker,
    name,
    category: 'Equity',
    categoryPath: 'Thematic Equity',
    source: {
      fundPage: fund.fundPage,
      catalog: 'https://temaetfs.com/funds',
      holdingsDownload,
      yahooChart: stableYahooUrl,
      nportFiling: nport?.accession.url ?? null,
      holdingsSource,
      historySource,
      provider: 'Tema ETFs official fund pages and holdings CSVs + SEC EDGAR Form N-PORT-P (Tema ETF Trust, CIK 0001944285; holdings fallback only) + Yahoo Finance public chart API',
    },
    identifiers: { cusip: page?.cusip || null, isin: null, indexTicker: null },
    inception: {
      fundInceptionDate: page?.inceptionDate || null,
      shareClassInceptionDate: null,
      exchange: page?.exchange || null,
    },
    expenseRatio: {
      display: page?.ter || '—',
      value: page?.terValue ?? null,
      gross: page?.terValue ?? null,
      net: null,
    },
    nav: { display: page?.nav || '—', value: page?.navValue ?? null, asOfDate: page?.asOfDate || asOfDate || null },
    marketPrice: { display: page?.closePrice || formatTemaMoney(latestPrice), value: page?.closePriceValue ?? latestPrice, asOfDate: page?.asOfDate || asOfDate || null },
    premiumDiscount: { display: page?.premiumDiscount || '—', value: page?.premiumDiscountValue ?? null },
    aum: { display: page?.aum || formatTemaMoney(netAssets), value: netAssets, asOfDate: page?.asOfDate || (nport ? formatDateLabel(nport.report.reportDate) : null), source: page?.aum ? 'Tema official fund page' : nport ? 'SEC EDGAR N-PORT-P filing' : null },
    yields: {
      dividendYield,
      dividendYieldText: formatTemaPercent(dividendYield),
      dividendYieldKind: chart?.dividends.length ? 'Trailing 12-month Yahoo Finance chart distributions divided by latest market price' : null,
      distributionRate: null,
      secYield: null,
      secYieldText: '—',
      secYieldKind: null,
      unsubsidizedSecYield: null,
    },
    returns: {
      derivedFrom: 'Yahoo Finance adjusted-close total-return proxy; not official NAV total returns',
      monthEnd: returnSetForMeta(chartReturns.monthEnd),
      quarterEnd: returnSetForMeta(chartReturns.quarterEnd),
    },
    distributions: {
      frequency: frequency.frequency,
      paymentsPerYear: frequency.paymentsPerYear,
      frequencyCode,
      headers: ['Ex-Date', 'Amount'],
      rows: dividends,
    },
    holdings: input.holdings ?? { pages: [], pageSize: 0, totalRows: 0, asOfDate: '', source: '' },
    history: input.history ?? { pages: [], pageSize: 0, totalRows: 0, asOfDate: '', source: '' },
  };
}

function cumulativeReturnFromAnnualized(value: unknown, years: number): number | null {
  const annualized = numberOrNull(value);
  if (annualized === null || annualized < -100) return null;
  return roundTo(((1 + annualized / 100) ** years - 1) * 100, 2);
}

export function indexFundFromMeta(fund: TemaFund, metaValue: unknown): Record<string, unknown> {
  const meta = recordOf(metaValue);
  const expenseRatio = recordOf(meta.expenseRatio);
  const nav = recordOf(meta.nav);
  const marketPrice = recordOf(meta.marketPrice);
  const premiumDiscount = recordOf(meta.premiumDiscount);
  const aum = recordOf(meta.aum);
  const distributions = recordOf(meta.distributions);
  const returns = recordOf(meta.returns);
  const monthEnd = recordOf(returns.monthEnd);
  const quarterEnd = recordOf(returns.quarterEnd);
  const yields = recordOf(meta.yields);
  const holdings = recordOf(meta.holdings);
  const history = recordOf(meta.history);
  const distributionRows = Array.isArray(distributions.rows) ? distributions.rows : [];
  const lastDistributionRow = distributionRows.at(-1);
  const latestDistribution = Array.isArray(lastDistributionRow) ? lastDistributionRow : [];
  const metric3Y = numberOrNull(monthEnd.yr3);
  const metric5Y = numberOrNull(monthEnd.yr5);
  const metric10Y = numberOrNull(monthEnd.yr10);
  const metrics = {
    ytd: numberOrNull(monthEnd.ytd),
    tr1y: numberOrNull(monthEnd.yr1),
    tr3y: cumulativeReturnFromAnnualized(metric3Y, 3),
    tr5y: cumulativeReturnFromAnnualized(metric5Y, 5),
    tr10y: cumulativeReturnFromAnnualized(metric10Y, 10),
    cagr3y: metric3Y,
    cagr5y: metric5Y,
    cagr10y: metric10Y,
    siAnn: numberOrNull(monthEnd.sinceInception),
    dividendYield: numberOrNull(yields.dividendYield),
    secYield: numberOrNull(yields.secYield),
  };
  return {
    ticker: fund.ticker,
    name: String(meta.name || fund.name),
    category: String(meta.category || 'Equity'),
    fundPage: fund.fundPage,
    dataFile: `./funds/${fund.ticker}/meta.json`,
    cusip: recordOf(meta.identifiers).cusip ?? null,
    isin: recordOf(meta.identifiers).isin ?? null,
    ter: expenseRatio.display ?? '—',
    terValue: numberOrNull(expenseRatio.value),
    nav: nav.display ?? '—',
    navValue: numberOrNull(nav.value),
    aum: aum.display ?? '—',
    aumValue: numberOrNull(aum.value),
    asOfDate: nav.asOfDate || marketPrice.asOfDate || '',
    inceptionDate: recordOf(meta.inception).fundInceptionDate ?? '',
    exchange: recordOf(meta.inception).exchange ?? '',
    closePrice: marketPrice.display ?? '—',
    closePriceValue: numberOrNull(marketPrice.value),
    premiumDiscount: premiumDiscount.display ?? '—',
    premiumDiscountValue: numberOrNull(premiumDiscount.value),
    distributions: {
      frequency: distributions.frequency ?? null,
      exDate: String(latestDistribution[0] ?? '') || null,
      dividend: String(latestDistribution[1] ?? '') || null,
    },
    returns: { monthEnd: returns.monthEnd ?? emptyReturnSet(), quarterEnd: returns.quarterEnd ?? emptyReturnSet() },
    metrics,
    holdings: numberOrNull(holdings.totalRows) ?? 0,
    history: numberOrNull(history.totalRows) ?? 0,
  };
}

export function mergePublishedFallback(currentValue: unknown, previousValue: unknown): unknown {
  if (currentValue === null || currentValue === undefined || currentValue === '' || currentValue === '—' || currentValue === '--') {
    return previousValue ?? currentValue;
  }
  if (Array.isArray(currentValue)) {
    return currentValue.length ? currentValue : Array.isArray(previousValue) && previousValue.length ? previousValue : currentValue;
  }
  if (currentValue && typeof currentValue === 'object') {
    const current = recordOf(currentValue);
    const previous = recordOf(previousValue);
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      result[key] = mergePublishedFallback(current[key], previous[key]);
    }
    return result;
  }
  return currentValue;
}

function stablePublicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

export function outputHasOutputFilters(config: UpdaterConfig): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}

export function hasDataDependentFilters(config: UpdaterConfig): boolean {
  return rangeActive(config.aumRange) || rangeActive(config.terRange) || rangeActive(config.dividendYieldRange) || rangeActive(config.secYieldRange) ||
    RETURN_PERIODS.some(period => rangeActive(config.performanceRanges[period]) || rangeActive(config.totalReturnRanges[period]));
}

export function outputPrintConfig(brand: string, config: UpdaterConfig): void {
  const entries: Array<[string, string]> = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}

export function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}

export function updaterHelpText(): string {
  return `Tema ETFs static data updater
Usage: bun scripts/update-data.ts [--help|-h]

Defaults come from scripts/update-data.config.json; environment variables override
them (the older TEMA_LIMIT and ASSET_CLASS names remain aliases of MAX_FETCHES and CATEGORY).

Controls:
  MAX_FETCHES=0                 0 runs the full catalog; a positive value limits a resumable batch
  REQUEST_SLEEP=1               minimum seconds between requests per provider lane
  CONCURRENCY=2                 independently paced worker lanes per provider
  MAX_RETRIES=2                 retries for network/408/425/429/5xx errors (integer >= 1)
  TICKERS="VOLT ARMY DSPY"      comma/space/semicolon-separated fund allowlist
  CATEGORY=equity               comma/semicolon-separated category allowlist (Tema default: Equity)
  AUM=MIN:MAX                   USD bounds or nano/micro/small/mid/large presets
  TER=MIN:MAX                   total expense ratio percentage bounds
  DIVIDEND_YIELD=MIN:MAX        trailing-12-month distribution yield bounds, in percent
  SEC_YIELD=MIN:MAX             SEC-yield percentage bounds (unavailable values do not match an active bound)
  PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}=MIN:MAX
  TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}=MIN:MAX
  HOLDINGS_PAGE_SIZE=250        holdings rows per static JSON page
  HISTORY_PAGE_SIZE=1000        history rows per static JSON page
  HISTORY_RANGE=max             max history or a bounded range such as 10y
  OUTPUT_DIR=api/tema           static API output directory
  EDGAR_FALLBACK=true           use SEC N-PORT-P for holdings when Tema CSV/page data is unavailable
  SKIP_YAHOO=false              retain prior history instead of requesting Yahoo when true
  SEC_UA="daggerok ETF feed daggerok@gmail.com" SEC User-Agent with a contact address (redacted in logs)
  VERBOSE=false                 show per-request/per-fund retry and fallback notices
  USE_SYSTEM_CA=auto            auto|true|false: restart once with Bun's --use-system-ca on an untrusted-certificate error (auto), always (true) or never (false)

A full run always ignores and clears the saved MAX_FETCHES cursor. TICKERS filters
which funds are processed; CATEGORY and data-dependent bounds are applied before
or during evaluation. The updater retains previously published data when a source
is unavailable. No network requests are made for --help.`;
}

export function printHelp(): void {
  console.log(updaterHelpText());
}

export function passesStaticFundFilters(fund: Pick<TemaFund, 'ticker'>, category: string, config: Pick<UpdaterConfig, 'tickers' | 'categories'>): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker.toUpperCase())) return false;
  return !config.categories.length || config.categories.includes(category.toLowerCase());
}

export function filterFundFromIndex(value: unknown): FilterFund {
  const row = recordOf(value);
  const returns = recordOf(row.returns);
  const monthEnd = recordOf(returns.monthEnd);
  const metrics = recordOf(row.metrics);
  const numeric = (item: unknown): number | null => numberOrNull(item);
  return {
    ticker: String(row.ticker ?? '').toUpperCase(),
    category: String(row.category ?? ''),
    aumValue: numeric(row.aumValue),
    terValue: numeric(row.terValue),
    dividendYield: numeric(metrics.dividendYield ?? row.dividendYield),
    secYield: numeric(metrics.secYield ?? row.secYield),
    performance: {
      YTD: numeric(monthEnd.ytd ?? metrics.ytd),
      '1Y': numeric(monthEnd.yr1 ?? metrics.tr1y),
      '3Y': numeric(monthEnd.yr3 ?? metrics.cagr3y),
      '5Y': numeric(monthEnd.yr5 ?? metrics.cagr5y),
      '10Y': numeric(monthEnd.yr10 ?? metrics.cagr10y),
    },
    totalReturn: {
      YTD: numeric(monthEnd.ytd ?? metrics.ytd),
      '1Y': numeric(metrics.tr1y),
      '3Y': numeric(metrics.tr3y),
      '5Y': numeric(metrics.tr5y),
      '10Y': numeric(metrics.tr10y),
    },
  };
}

export const TEMA_CATALOG_URL = 'https://temaetfs.com/funds';
export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

function manifestFromPrevious(value: unknown, defaultPageSize: number): PageManifest | null {
  const manifest = recordOf(value);
  if (!Array.isArray(manifest.pages)) return null;
  const pages = manifest.pages.filter((page): page is string => typeof page === 'string');
  return {
    pages,
    pageSize: numberOrNull(manifest.pageSize) ?? defaultPageSize,
    totalRows: numberOrNull(manifest.totalRows) ?? 0,
    asOfDate: String(manifest.asOfDate ?? ''),
    source: String(manifest.source ?? ''),
  };
}

function previousCatalogFund(value: unknown): TemaFund | null {
  const row = recordOf(value);
  const ticker = String(row.ticker ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(ticker)) return null;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : ticker;
  const fundPage = typeof row.fundPage === 'string' && row.fundPage.startsWith('https://temaetfs.com/')
    ? row.fundPage
    : `https://temaetfs.com/${ticker.toLowerCase()}`;
  return { ticker, name, fundPage };
}

function previousRowsByTicker(values: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(values)) return map;
  for (const value of values) {
    const row = recordOf(value);
    const ticker = String(row.ticker ?? '').trim().toUpperCase();
    if (/^[A-Z0-9]{2,5}$/.test(ticker)) map.set(ticker, row);
  }
  return map;
}

function preservePreviousDividendFrequency(meta: Record<string, unknown>, previousMeta: Record<string, unknown>, chart: ParsedYahooChart | null): void {
  if (chart && chart.dividends.length >= 3) return;
  const previousDistributions = recordOf(previousMeta.distributions);
  if (typeof previousDistributions.frequency !== 'string' || !previousDistributions.frequency) return;
  const distributions = recordOf(meta.distributions);
  meta.distributions = {
    ...distributions,
    frequency: previousDistributions.frequency,
    paymentsPerYear: previousDistributions.paymentsPerYear ?? distributions.paymentsPerYear,
    frequencyCode: previousDistributions.frequencyCode ?? distributions.frequencyCode,
  };
}

function candidateIndexRow(fund: TemaFund, meta: Record<string, unknown>, previousIndex: unknown): Record<string, unknown> {
  const projected = indexFundFromMeta(fund, meta);
  const fallback = minimalIndexFund(fund, previousIndex);
  return recordOf(mergePublishedFallback(projected, fallback));
}

function reconcileFreshSources(meta: Record<string, unknown>, prepared: Pick<PreparedFund, 'holdings' | 'history' | 'nport'>): void {
  const source = recordOf(meta.source);
  if (prepared.holdings) {
    source.holdingsSource = prepared.holdings.source;
    source.holdingsDownload = prepared.holdings.downloadUrl ? stablePublicUrl(prepared.holdings.downloadUrl) : null;
    source.nportFiling = prepared.nport?.accession.url ?? null;
  }
  if (prepared.history) source.historySource = prepared.history.source;
  meta.source = source;
}

function fundFilterPasses(indexRow: Record<string, unknown>, config: UpdaterConfig): boolean {
  return passesFundFilters(filterFundFromIndex(indexRow), config);
}

export type UpdaterRunSummary = { catalogCount: number; selectedCount: number; updatedCount: number; skippedCount: number; failures: number; holdings: number; history: number };

type NewHoldingsData = { headers: string[]; rows: Array<Record<string, string>>; asOfDate: string; source: string; downloadUrl: string | null };
type NewHistoryData = { headers: string[]; rows: Array<Record<string, string>>; asOfDate: string; source: string };
type PreparedFund = {
  page: ParsedTemaFundPage | null;
  holdings: NewHoldingsData | null;
  history: NewHistoryData | null;
  chart: ParsedYahooChart | null;
  derived: DerivedTemaMetrics | null;
  nport: NportMatch | null;
  freshSource: boolean;
  hasPrevious: boolean;
  meta: Record<string, unknown>;
  indexRow: Record<string, unknown>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writePreparedFund(outputDir: string, fund: TemaFund, prepared: PreparedFund, previousMeta: Record<string, unknown>, config: UpdaterConfig): Promise<Record<string, unknown>> {
  let holdingsManifest = manifestFromPrevious(previousMeta.holdings, config.holdingsPageSize);
  let historyManifest = manifestFromPrevious(previousMeta.history, config.historyPageSize);
  if (prepared.holdings) {
    holdingsManifest = await writeFundPages(
      outputDir, fund.ticker, 'holdings', prepared.holdings.headers, prepared.holdings.rows,
      config.holdingsPageSize, prepared.holdings.asOfDate, prepared.holdings.source,
    );
  }
  if (prepared.history) {
    historyManifest = await writeFundPages(
      outputDir, fund.ticker, 'history', prepared.history.headers, prepared.history.rows,
      config.historyPageSize, prepared.history.asOfDate, prepared.history.source,
    );
  }
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const freshMeta = buildTemaFundMeta({
    fund,
    page: prepared.page,
    holdings: holdingsManifest,
    history: historyManifest,
    chart: prepared.chart,
    derived: prepared.derived,
    holdingsDownloadUrl: prepared.holdings?.downloadUrl ?? null,
    nport: prepared.nport,
    generatedAt,
  });
  const meta = recordOf(mergePublishedFallback(freshMeta, previousMeta));
  preservePreviousDividendFrequency(meta, previousMeta, prepared.chart);
  reconcileFreshSources(meta, prepared);
  await writeJsonIfChanged(join(outputDir, 'funds', fund.ticker, 'meta.json'), meta);
  return meta;
}

/** Run one full or bounded refresh. All provider calls are injected behind paced clients. */
export async function runUpdater(
  config: UpdaterConfig = readUpdaterConfig(),
  clients: ReturnType<typeof createProviderHttpClients> = createProviderHttpClients(config),
): Promise<UpdaterRunSummary> {
  outputPrintConfig('Tema ETFs', config);
  console.log('');

  const indexPath = join(config.outputDir, 'index.json');
  const statePath = join(config.outputDir, 'update-state.json');
  const previousIndex = recordOf(await readJsonFile(indexPath));
  const previousFundValues = Array.isArray(previousIndex.funds) ? previousIndex.funds : [];
  const previousByTicker = previousRowsByTicker(previousFundValues);
  let liveCatalog: TemaFund[] = [];
  let catalogSource = 'temaetfs.com/funds';
  try {
    const html = await responseText(clients.issuer, TEMA_CATALOG_URL);
    liveCatalog = parseTemaCatalog(html, TEMA_CATALOG_URL);
    if (!liveCatalog.length) throw new Error('Tema catalog contained no ticker-linked fund routes');
  } catch (error) {
    outputNote(`[ catalog  ] live Tema catalog unavailable: ${errorMessage(error)}`);
    liveCatalog = previousFundValues.map(previousCatalogFund).filter((fund): fund is TemaFund => fund !== null);
    catalogSource = 'previous api/tema/index.json fallback';
  }
  if (!liveCatalog.length) throw new Error('No live or previously published Tema catalog entries are available');
  if (previousFundValues.length && liveCatalog.length < previousFundValues.length / 2) {
    outputNote(`[ catalog  ] live catalog is unexpectedly small (${liveCatalog.length}); retaining all previously published fund rows`);
  }
  const catalog = retainCatalogEntries(liveCatalog, previousFundValues);
  console.log(`[ catalog  ] ${catalog.length} Tema ETFs (${catalogSource}${liveCatalog.length < catalog.length ? ' + retained previous entries' : ''})`);

  const staticCandidates = catalog.filter(fund => passesStaticFundFilters(fund, 'Equity', config));
  outputPrintFilter(staticCandidates.length, catalog.length, hasDataDependentFilters(config));
  const state = recordOf(await readJsonFile(statePath));
  const cursor = config.maxFetches > 0 && !config.tickers.length && typeof state.cursor === 'string' ? state.cursor : null;
  const selected = selectUpdateBatch(staticCandidates, cursor, config.maxFetches, config.tickers);
  if (config.maxFetches > 0) {
    console.log(`[ cursor   ] selected ${selected.length} of ${staticCandidates.length} eligible funds${cursor ? ` after ${cursor}` : ''}`);
  }

  const nportResolver = config.edgarFallback ? createNportResolver(clients.sec, { concurrency: config.concurrency }) : null;
  let companyTickerMapPromise: Promise<Map<string, string>> | null = null;
  const loadCompanyTickerMap = (): Promise<Map<string, string>> => {
    if (!companyTickerMapPromise) {
      companyTickerMapPromise = responseJson(clients.sec, SEC_COMPANY_TICKERS_URL)
        .then(parseCompanyTickerMap)
        .catch(error => {
          outputNote(`SEC company ticker map unavailable: ${errorMessage(error)}`);
          return new Map<string, string>();
        });
    }
    return companyTickerMapPromise;
  };

  const output = outputCreateReporter(config.outputDir, selected.length);
  const queue = selected.map(fund => ({ fund }));
  const updated = new Map<string, Record<string, unknown>>();
  let updatedCount = 0;
  let skippedCount = 0;
  let failures = 0;

  async function prepareFund(fund: TemaFund): Promise<PreparedFund> {
    const previousMeta = recordOf(await readJsonFile(join(config.outputDir, 'funds', fund.ticker, 'meta.json')));
    let pageHtml: string | null = null;
    let page: ParsedTemaFundPage | null = null;
    try {
      pageHtml = await responseText(clients.issuer, fund.fundPage);
      try {
        page = parseTemaFundPage(pageHtml, fund.ticker, fund.name);
      } catch (error) {
        outputNote(`[ product  ] ${fund.ticker}: ${errorMessage(error)}`);
      }
    } catch (error) {
      outputNote(`[ product  ] ${fund.ticker}: ${errorMessage(error)}`);
    }

    let holdings: NewHoldingsData | null = null;
    if (pageHtml) {
      try {
        const downloadUrl = findTemaHoldingsCsvUrl(pageHtml, fund.ticker, fund.fundPage);
        const downloaded = await responseBytes(clients.issuer, downloadUrl);
        const parsed = parseTemaHoldingsCsv(decodeTemaCsv(downloaded.bytes, downloaded.contentType));
        if (!parsed.rows.length) throw new Error('official holdings CSV contains no security rows');
        holdings = {
          headers: parsed.headers,
          rows: parsed.rows,
          asOfDate: parsed.asOfDate,
          source: `Tema official daily holdings CSV (${parsed.asOfDate})`,
          downloadUrl,
        };
      } catch (error) {
        outputNote(`[ holdings ] ${fund.ticker}: official CSV unavailable: ${errorMessage(error)}`);
      }
    }

    let nport: NportMatch | null = null;
    if (!holdings && nportResolver) {
      try {
        const match = await nportResolver({ ticker: fund.ticker, name: page?.name || fund.name });
        if (match?.report.holdings.length) {
          nport = match;
          const tickerMap = await loadCompanyTickerMap();
          holdings = {
            headers: [...HOLDINGS_HEADERS],
            rows: fillNportTickers(match.report.holdings, tickerMap),
            asOfDate: match.report.reportDate,
            source: `SEC EDGAR N-PORT-P fallback (${match.accession.accession}; report ${match.report.reportDate})`,
            downloadUrl: null,
          };
          outputNote(`[ edgar    ] ${fund.ticker}: ${holdings.source}`);
        } else {
          outputNote(`[ edgar    ] ${fund.ticker}: no matching recent N-PORT positions; keeping published holdings`);
        }
      } catch (error) {
        outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(error)}`);
      }
    }

    let chart: ParsedYahooChart | null = null;
    let derived: DerivedTemaMetrics | null = null;
    let history: NewHistoryData | null = null;
    if (!config.skipYahoo) {
      try {
        chart = parseYahooChart(await responseJson(clients.yahoo, yahooChartUrl(fund.ticker, config.historyRange)));
        derived = deriveTemaMetrics(chart);
        const rows = yahooHistoryRows(chart);
        if (rows.length) {
          history = {
            headers: [...HISTORY_HEADERS],
            rows,
            asOfDate: chart.days.at(-1)?.date ?? '',
            source: 'Yahoo Finance public chart history (adjusted close used for total-return estimates)',
          };
        } else {
          outputNote(`[ history  ] ${fund.ticker}: Yahoo returned no daily closes; keeping published history`);
        }
      } catch (error) {
        outputNote(`[ history  ] ${fund.ticker}: Yahoo chart unavailable: ${errorMessage(error)}`);
      }
    }

    const previousHoldings = manifestFromPrevious(previousMeta.holdings, config.holdingsPageSize);
    const previousHistory = manifestFromPrevious(previousMeta.history, config.historyPageSize);
    const previewHoldings = holdings
      ? buildPageManifest(fund.ticker, 'holdings', holdings.headers, holdings.rows, config.holdingsPageSize, holdings.asOfDate, holdings.source)
      : previousHoldings;
    const previewHistory = history
      ? buildPageManifest(fund.ticker, 'history', history.headers, history.rows, config.historyPageSize, history.asOfDate, history.source)
      : previousHistory;
    const freshMeta = buildTemaFundMeta({
      fund,
      page,
      holdings: previewHoldings,
      history: previewHistory,
      chart,
      derived,
      holdingsDownloadUrl: holdings?.downloadUrl ?? null,
      nport,
      generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    const meta = recordOf(mergePublishedFallback(freshMeta, previousMeta));
    preservePreviousDividendFrequency(meta, previousMeta, chart);
    reconcileFreshSources(meta, { holdings, history, nport });
    const indexRow = candidateIndexRow(fund, meta, previousByTicker.get(fund.ticker));
    const freshSource = page !== null || holdings !== null || history !== null || (chart !== null && chart.dividends.length > 0);
    const hasPrevious = previousByTicker.has(fund.ticker) || Object.keys(previousMeta).length > 0;
    return { page, holdings, history, chart, derived, nport, freshSource, hasPrevious, meta, indexRow };
  }

  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const fund = item.fund;
      const before = await output.before(fund.ticker);
      try {
        const prepared = await prepareFund(fund);
        if (!prepared.freshSource) {
          skippedCount += 1;
          await output.result(fund.ticker, before, prepared.hasPrevious ? 'skipped' : 'failed', prepared.hasPrevious ? 'all providers unavailable; previous data retained' : 'no source data available');
          if (!prepared.hasPrevious) failures += 1;
          continue;
        }
        if (!fundFilterPasses(prepared.indexRow, config)) {
          skippedCount += 1;
          await output.result(fund.ticker, before, 'skipped', 'does not match configured output filters');
          continue;
        }
        const previousMeta = recordOf(await readJsonFile(join(config.outputDir, 'funds', fund.ticker, 'meta.json')));
        const meta = await writePreparedFund(config.outputDir, fund, prepared, previousMeta, config);
        const row = candidateIndexRow(fund, meta, previousByTicker.get(fund.ticker));
        updated.set(fund.ticker, row);
        updatedCount += 1;
        await output.result(fund.ticker, before, undefined, undefined, row);
      } catch (error) {
        failures += 1;
        await output.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, config.concurrency), Math.max(1, queue.length)) }, () => worker()));

  const indexFunds = catalog.map(fund => {
    const fresh = updated.get(fund.ticker);
    if (fresh) return fresh;
    return minimalIndexFund(fund, previousByTicker.get(fund.ticker));
  }).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const index = buildIndexDocument(indexFunds, generatedAt, generatedAt);
  await writeJsonIfChanged(indexPath, index);

  if (config.maxFetches > 0 && !config.tickers.length && selected.length) {
    const lastTicker = selected[selected.length - 1].ticker;
    await writeJsonIfChanged(statePath, { cursor: lastTicker });
    console.log(`[ cursor   ] batch of ${selected.length} reached — next run continues after ${lastTicker}`);
  } else if (config.maxFetches === 0) {
    await removeFileIfExists(statePath);
  }

  const indexRecord = recordOf(await readJsonFile(indexPath));
  const counts = recordOf(indexRecord.counts);
  const summary: UpdaterRunSummary = {
    catalogCount: catalog.length,
    selectedCount: selected.length,
    updatedCount,
    skippedCount,
    failures,
    holdings: numberOrNull(counts.holdings) ?? 0,
    history: numberOrNull(counts.history) ?? 0,
  };
  console.log('');
  console.log(`[ done     ] ${updatedCount} funds updated, ${skippedCount} skipped, ${failures} failures`);
  console.log(`[ done     ] counts: ${catalog.length} funds / ${summary.holdings.toLocaleString('en-US')} holdings rows / ${summary.history.toLocaleString('en-US')} history rows`);
  if (config.maxFetches === 0) console.log('[ cursor   ] full pass complete (cursor reset)');
  return summary;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const unknown = args.filter(arg => arg !== '--help' && arg !== '-h');
  if (unknown.length) throw new Error(`Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}`);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const controls = await runtimeControls();
  installSystemCa(controls.USE_SYSTEM_CA ?? 'auto');
  if (controls.VERBOSE !== undefined) process.env.VERBOSE = controls.VERBOSE;
  await runUpdater(readUpdaterConfig(controls));
}

if (import.meta.main) {
  void main().catch(error => {
    console.error(`[ error    ] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
