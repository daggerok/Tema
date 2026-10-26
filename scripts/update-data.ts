#!/usr/bin/env bun
/// <reference types="bun" />

import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

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
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [
  // liquidated: last trading day on Cboe BZX 2026-09-02, liquidation payment on or about 2026-09-04 (497 supplement of 2026-08-05; Form 25 filed 2026-08-24)
  { ticker: 'PRVT', closed: '2026-09-02', source: 'https://www.sec.gov/Archives/edgar/data/1944285/000182912626008372/temaetftrust_497.htm' },
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

/** Convert known issuer date spellings to an ISO calendar date without local-time shifts ('' when unreadable): the CSV's compact MMDDYYYY, else the shared calendarIso. */
export function normalizeTemaDate(value: string): string {
  const text = value.trim();
  const compact = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  return calendarIso(compact ? `${compact[1]}/${compact[2]}/${compact[3]}` : text) ?? '';
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

/** The output directory is fixed (never a control); only tests may point it elsewhere through the second argument. */
export const DEFAULT_OUTPUT_DIR = 'api/tema';

export function readUpdaterConfig(env: Record<string, string | undefined> = process.env, outputPath: string = DEFAULT_OUTPUT_DIR): UpdaterConfig {
  const outputDir = resolve(outputPath);
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
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE',
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

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

/** The `[ config ]` block: the parsed config under the canonical environment names (SEC_UA is redacted). */
export function printUpdaterConfig(config: UpdaterConfig): void {
  const range = (value: NumericRange) => ({ source: configRangeValue(value) });
  const periods = (ranges: Record<string, NumericRange>) => Object.fromEntries(RETURN_PERIODS.map(period => [period, range(ranges[period])]));
  outputPrintConfig('Tema ETFs', {
    maxFetches: config.maxFetches, requestSleepSeconds: config.requestSleepSeconds, concurrency: config.concurrency,
    categories: config.categories, aumRange: range(config.aumRange), dividendYieldRange: range(config.dividendYieldRange),
    edgarFallback: config.edgarFallback, historyPageSize: config.historyPageSize, historyRange: config.historyRange,
    holdingsPageSize: config.holdingsPageSize, maxRetries: config.maxRetries, SEC_UA: config.secUserAgent,
    secYieldRange: range(config.secYieldRange), skipYahoo: config.skipYahoo, terRange: range(config.terRange), tickers: config.tickers,
    performanceRanges: periods(config.performanceRanges), totalReturnRanges: periods(config.totalReturnRanges),
  });
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
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
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

/** Parse Yahoo chart history; adjusted close stays unrounded so returns are computed on full precision (only the results are rounded). */
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
      adjClose: adjustedClose,
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

/** Honest label for how every return in the feed is computed (hub contract: never empty). */
export const RETURNS_BASIS = 'derived from Yahoo Finance adjusted close at the last completed month-end (total-return proxy estimate, not official Tema NAV total returns)';

/** Parse a label such as "Sep 30 2026" (as written by formatDateLabel) back to ISO YYYY-MM-DD, or null. */
export function isoFromDateLabel(label: unknown): string | null {
  const text = typeof label === 'string' ? label.trim() : '';
  return /^[A-Za-z]{3} \d{2} \d{4}$/.test(text) ? calendarIso(text) : null;
}

export const DIVIDEND_YIELD_BASES = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'] as const;
export type DividendYieldBasis = typeof DIVIDEND_YIELD_BASES[number];

/** Tema publishes no yield: the only source is the updater's trailing 12-month Yahoo distributions over the latest price. */
export function dividendYieldBasisFor(dividendYield: unknown, kind: unknown = null): DividendYieldBasis | null {
  if (typeof dividendYield !== 'number' || !Number.isFinite(dividendYield)) return null;
  if (typeof kind === 'string' && (DIVIDEND_YIELD_BASES as readonly string[]).includes(kind)) return kind as DividendYieldBasis;
  return 'computed-trailing-12m';
}

/** Put dividendYieldBasis, then the mandatory returnsBasis and performanceAsOf keys last; basis never empty, as-of null or ISO, yield code null exactly when the yield is null. */
export function withReturnsContract(metrics: Record<string, unknown>, performanceAsOf: unknown = metrics.performanceAsOf): Record<string, unknown> {
  const { returnsBasis, performanceAsOf: _ignored, dividendYieldBasis, ...rest } = metrics;
  const basis = typeof returnsBasis === 'string' && returnsBasis.trim() && returnsBasis.trim() !== '-' ? returnsBasis : RETURNS_BASIS;
  const asOf = typeof performanceAsOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(performanceAsOf) ? performanceAsOf : null;
  return { ...rest, dividendYieldBasis: dividendYieldBasisFor(rest.dividendYield, dividendYieldBasis), returnsBasis: basis, performanceAsOf: asOf };
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
    sinceInception: sinceYears >= 1 ? annualizedReturn(first, anchor, sinceYears) : null,
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
      metrics: { ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, dividendYield, dividendYieldText: formatTemaPercent(dividendYield), secYield: null, secYieldText: '—', dividendYieldBasis: dividendYieldBasisFor(dividendYield), returnsBasis: RETURNS_BASIS, performanceAsOf: null },
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
      dividendYieldText: formatTemaPercent(dividendYield),
      secYield: null,
      secYieldText: '—',
      dividendYieldBasis: dividendYieldBasisFor(dividendYield),
      returnsBasis: RETURNS_BASIS,
      performanceAsOf: latest.date,
    },
    monthEnd,
    quarterEnd,
    dividendYield,
    latestDividend,
    frequency,
  };
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
    dataFile: null,
    cusip: null,
    isin: null,
    ter: '—',
    terValue: null,
    terGross: '—',
    terGrossValue: null,
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
    metrics: { ytd: null, tr1y: null, tr3y: null, tr5y: null, tr10y: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, dividendYield: null, dividendYieldText: '—', secYield: null, secYieldText: '—', dividendYieldBasis: null, returnsBasis: RETURNS_BASIS, performanceAsOf: null },
    holdings: 0,
    history: 0,
  };
  const merged = { ...base, ...previous, ticker: fund.ticker, name: fund.name, fundPage: fund.fundPage, dataFile: typeof previous.dataFile === 'string' ? previous.dataFile : null };
  return { ...merged, metrics: withReturnsContract({ ...recordOf(base.metrics), ...recordOf(previous.metrics) }) };
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
      holdings: funds.reduce((sum, fund) => sum + Number(outputCount(fund.holdings) ?? 0), 0),
      history: funds.reduce((sum, fund) => sum + Number(outputCount(fund.history) ?? 0), 0),
    },
    funds,
  };
}

export type PageManifest = { pages: string[]; pageSize: number; totalRows: number; asOfDate: string; source: string };

export async function removeStalePageFiles(directory: string, keep: Set<string>): Promise<void> {
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
  pruneStale = true,
): Promise<PageManifest> {
  const directory = join(outputDir, 'funds', ticker, kind);
  const pages = buildPages(ticker, headers, rows, pageSize);
  const names = pageFileNames(kind, pages.length);
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < pages.length; index += 1) {
    await writeJsonIfChanged(join(directory, names[index].split('/')[1]), pages[index]);
  }
  if (pruneStale) await removeStalePageFiles(directory, new Set(names.map(name => name.split('/')[1])));
  return { pages: names, pageSize, totalRows: rows.length, asOfDate, source };
}

/** Callable shape of fetch without the Bun-only static members (e.g. `preconnect`), so plain mocks type-check. */
export type FetchFunction = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
export type HttpGate = { pace: () => Promise<void> };
export type HttpClientOptions = {
  gate: HttpGate;
  retries: number;
  userAgent: string;
  fetchImpl?: FetchFunction;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  /** Per-attempt limit for headers AND body, default 45 s; a timeout is retried like a network error. */
  timeoutMs?: number;
};
export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;
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

/** One attempt with a hard deadline covering headers and the fully buffered body (a stalled body cannot hang the run). */
async function fetchWithDeadline(fetchImpl: FetchFunction, input: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const outer = init.signal;
  const onOuterAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener('abort', onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s for ${safeRequestPath(input)}`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const attempt = (async (): Promise<Response> => {
      const response = await fetchImpl(input, { ...init, signal: controller.signal });
      if (isRetryableHttpStatus(response.status)) return response;
      const body = [204, 205, 304].includes(response.status) ? null : await response.arrayBuffer();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    })();
    attempt.catch(() => undefined);
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/** Fetch wrapper with per-provider pacing, a per-attempt timeout, bounded retries, and no request-header logging. */
export function createPacedHttpClient(options: HttpClientOptions): PacedHttpClient {
  if (!Number.isSafeInteger(options.retries) || options.retries < 0) throw new Error(`retries must be a non-negative integer, got ${options.retries}`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`timeoutMs must be a positive number, got ${timeoutMs}`);
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
          const response = await fetchWithDeadline(fetchImpl, input, { ...init, headers }, timeoutMs);
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

export function createProviderHttpClients(config: Pick<UpdaterConfig, 'concurrency' | 'requestSleepSeconds' | 'maxRetries' | 'secUserAgent'>, fetchImpl?: FetchFunction) {
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

// ---------------------------------------------------------------------------
// SEC EDGAR Form N-PORT-P fallback: the shared nport-reader block at the end of this file finds, reads and checks the filing
// ---------------------------------------------------------------------------

export const SEC_COMPANY_TICKERS_MF_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
export const TEMA_ETF_TRUST_CIK = '0001944285';
/**
 * Series ids that SEC's company_tickers_mf.json does not list under the fund's current ticker. WELD is the former RSHO: one
 * series (S000078298, class C000239058) whose ticker changed; SEC still lists the class as RSHO and its N-PORT-P filings name
 * "Tema U.S. Manufacturing & Reshoring ETF" (the fund page still serves RSHO artwork). RSHO is no catalog fund any more.
 */
export const TEMA_NPORT_SERIES: Record<string, string> = { WELD: 'S000078298' };

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (runUpdater and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

/** SEC's ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(client: PacedHttpClient): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = responseJson(client, SEC_COMPANY_TICKERS_MF_URL).then((payload) => parseSecFundTickers(payload));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(client: PacedHttpClient): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = responseJson(client, SEC_COMPANY_TICKERS_URL).then((payload) => parseSecCompanyNames(payload));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/** Nasdaq Trader symbol directories for the N-PORT rows (shared nport-reader `readUsListings`), loaded once per run: a row with a
 * foreign ISIN keeps a ticker only for the company's own U.S. listing in U.S. dollars (Linde, NXP, IMAX). null when either failed. */
let usListings: Promise<Map<string, string> | null> | null = null;
function loadUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  if (!usListings) usListings = readUsListings(getText);
  return usListings;
}

/** The series name a Tema filing carries for a catalog fund: "VOLT Electrification ETF" -> "Tema Electrification ETF" (used only when no series id is known). */
export function temaSeriesName(ticker: string, name: string): string {
  const bare = name.trim().replace(new RegExp(`^${ticker.replace(/[^A-Za-z0-9]/g, '')}\\s+`, 'i'), '').trim();
  return !bare || /^tema\b/i.test(bare) ? bare : `Tema ${bare}`;
}

/**
 * The fund's newest own N-PORT-P filing through the shared reader: identity by the series id (TEMA_NPORT_SERIES, else SEC's
 * fund ticker table when it lists the fund under the Tema ETF Trust), by the series name only when no series id is known;
 * used only when its report period is strictly newer than the published holdings date (`published.asOfDate`, ISO).
 */
export async function readTemaNport(fund: Pick<TemaFund, 'ticker' | 'name'>, published: Pick<PageManifest, 'asOfDate' | 'totalRows'> | null, client: PacedHttpClient): Promise<NportRead> {
  const table = await loadFundTickerTable(client).catch((error: unknown) => {
    outputNote(`[ edgar    ] SEC fund ticker table unavailable, N-PORT name matching is used: ${errorMessage(error)}`);
    return null;
  });
  const listed = table ? table.get(fund.ticker) : undefined;
  const seriesId = TEMA_NPORT_SERIES[fund.ticker] || (listed && Number(listed.cik) === Number(TEMA_ETF_TRUST_CIK) ? listed.seriesId : null);
  return readNportHoldings(
    { ticker: fund.ticker, cik: TEMA_ETF_TRUST_CIK, seriesId, name: temaSeriesName(fund.ticker, fund.name) },
    { asOf: published ? calendarIso(published.asOfDate) || published.asOfDate : null, rows: published ? published.totalRows : 0 },
    (url) => responseText(client, url),
    { cache: secState.reader },
  );
}

/**
 * The Tema holdings sheet of an N-PORT filing (HOLDINGS_HEADERS): a missing number stays empty (never 0), the identifier is
 * the position's own (CUSIP, ISIN or other code, else its name), tickers come from nportTickers (U.S. equities only); the
 * filing has no sector, and its country is a code, so Country, Sector and Cash stay empty as before.
 */
export function temaNportRows(filing: NportFiling, tickers: ReadonlyArray<string>): Array<Record<string, string>> {
  return filing.positions.map((position, index) => {
    const name = position.name || 'Unnamed security';
    return {
      Name: name,
      Ticker: tickers[index] || '',
      Identifier: nportIdentifier(position) || name,
      Weight: nportCell(position.weight),
      'Market Value': nportCell(position.value, 2),
      'Shares Held': nportCell(position.balance),
      'Asset Category': position.assetCat,
      Country: '',
      Sector: '',
      Cash: '',
    };
  });
}

/** The N-PORT filing a fund's holdings came from in this run. */
export type TemaNport = { filing: NportFiling; accession: string; url: string };

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
  nport: TemaNport | null;
  generatedAt: string;
};

export function buildTemaFundMeta(input: TemaMetaBuildInput): Record<string, unknown> {
  const { fund, page, chart, derived, nport } = input;
  const latestDay = chart?.days.at(-1) ?? null;
  const latestPrice = chart?.regularMarketPrice ?? latestDay?.close ?? null;
  const netAssets = page?.aumValue ?? nport?.filing.netAssets ?? null;
  const name = page?.name && page.name !== fund.ticker ? page.name : nport?.filing.seriesName || fund.name;
  const asOfDate = page?.asOfDate || formatDateLabel(latestDay?.date ?? nport?.filing.repPdDate ?? '');
  const dividends = chart ? yahooDistributionRows(chart) : [];
  const frequency = derived?.frequency ?? { frequency: 'Unknown', paymentsPerYear: null };
  const chartReturns = derived ?? deriveTemaMetrics({ exchangeName: '', longName: '', currency: '', regularMarketPrice: null, regularMarketTime: null, firstTradeDate: null, days: [], dividends: [] });
  // the shared "younger than one year" rule on the published returns: no horizon the fund is too young for (calendar
  // anniversary of the page's inception date, else Yahoo's first trade date), whatever the history reaches back to
  const inception = page?.inceptionDate || (chart?.firstTradeDate ? epochToIsoDate(chart.firstTradeDate) : null);
  const aged = (set: PeriodReturnMetrics): PeriodReturnMetrics => withoutYoungReturns(set, inception, set.asOfDate, { yr1: 1, yr3: 3, yr5: 5, yr10: 10, sinceInception: 1 });
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
      nportFiling: nport?.url ?? null,
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
      // Tema publishes a single "Total Expense Ratio" (no waiver split): it is the net figure; gross stays null instead of being invented.
      value: page?.terValue ?? null,
      gross: null,
      net: page?.terValue ?? null,
    },
    nav: { display: page?.nav || '—', value: page?.navValue ?? null, asOfDate: page?.asOfDate || asOfDate || null },
    marketPrice: { display: page?.closePrice || formatTemaMoney(latestPrice), value: page?.closePriceValue ?? latestPrice, asOfDate: page?.asOfDate || asOfDate || null },
    premiumDiscount: { display: page?.premiumDiscount || '—', value: page?.premiumDiscountValue ?? null },
    aum: { display: page?.aum || formatTemaMoney(netAssets), value: netAssets, asOfDate: page?.asOfDate || (nport ? formatDateLabel(nport.filing.repPdDate) : null), source: page?.aum ? 'Tema official fund page' : nport ? 'SEC EDGAR N-PORT-P filing' : null },
    yields: {
      dividendYield,
      dividendYieldText: formatTemaPercent(dividendYield),
      dividendYieldBasis: dividendYieldBasisFor(dividendYield),
      dividendYieldKind: chart?.dividends.length ? 'Trailing 12-month Yahoo Finance chart distributions divided by latest market price' : null,
      distributionRate: null,
      secYield: null,
      secYieldText: '—',
      secYieldKind: null,
      unsubsidizedSecYield: null,
    },
    returns: {
      derivedFrom: 'Yahoo Finance adjusted-close total-return proxy; not official NAV total returns',
      returnsBasis: RETURNS_BASIS,
      performanceAsOf: isoFromDateLabel(chartReturns.monthEnd.asOfDate),
      monthEnd: returnSetForMeta(aged(chartReturns.monthEnd)),
      quarterEnd: returnSetForMeta(aged(chartReturns.quarterEnd)),
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
    dividendYieldText: typeof yields.dividendYieldText === 'string' && yields.dividendYieldText ? yields.dividendYieldText : formatTemaPercent(numberOrNull(yields.dividendYield)),
    secYield: numberOrNull(yields.secYield),
    secYieldText: typeof yields.secYieldText === 'string' && yields.secYieldText ? yields.secYieldText : formatTemaPercent(numberOrNull(yields.secYield)),
    dividendYieldBasis: dividendYieldBasisFor(numberOrNull(yields.dividendYield), yields.dividendYieldBasis),
    returnsBasis: typeof returns.returnsBasis === 'string' ? returns.returnsBasis : '',
    performanceAsOf: returns.performanceAsOf ?? isoFromDateLabel(monthEnd.asOfDate),
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
    terValue: numberOrNull(expenseRatio.net ?? expenseRatio.value),
    terGross: numberOrNull(expenseRatio.gross) === null ? '—' : `${numberOrNull(expenseRatio.gross)?.toFixed(2)}%`,
    terGrossValue: numberOrNull(expenseRatio.gross),
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
    metrics: withReturnsContract(metrics),
    holdings: numberOrNull(holdings.totalRows) ?? 0,
    history: numberOrNull(history.totalRows) ?? 0,
  };
}

/**
 * Retention is for FAILED sources only: copy whole sections of the previous meta that a skipped or
 * failed source would have produced. An honest null from a source that answered is never replaced.
 */
export function carryPreviousSections(meta: Record<string, unknown>, previousMeta: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) if (previousMeta[key] !== undefined) meta[key] = previousMeta[key];
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

export function hasDataDependentFilters(config: UpdaterConfig): boolean {
  return rangeActive(config.aumRange) || rangeActive(config.terRange) || rangeActive(config.dividendYieldRange) || rangeActive(config.secYieldRange) ||
    RETURN_PERIODS.some(period => rangeActive(config.performanceRanges[period]) || rangeActive(config.totalReturnRanges[period]));
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
  const row = { ...fallback, ...projected };
  return { ...row, metrics: withReturnsContract(recordOf(row.metrics)) };
}

function reconcileFreshSources(meta: Record<string, unknown>, prepared: Pick<PreparedFund, 'holdings' | 'history' | 'nport'>): void {
  const source = recordOf(meta.source);
  if (prepared.holdings) {
    source.holdingsSource = prepared.holdings.source;
    source.holdingsDownload = prepared.holdings.downloadUrl ? stablePublicUrl(prepared.holdings.downloadUrl) : null;
    source.nportFiling = prepared.nport?.url ?? null;
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
  nport: TemaNport | null;
  freshSource: boolean;
  /** Names of required sources that failed; a fund with previous data and any missing source is kept as it was. */
  missing: string[];
  hasPrevious: boolean;
  meta: Record<string, unknown>;
  indexRow: Record<string, unknown>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pages first, then meta.json, then stale pages (only after the new meta exists). The index row is written last by the caller. */
async function writePreparedFund(outputDir: string, fund: TemaFund, prepared: PreparedFund, config: UpdaterConfig): Promise<Record<string, unknown>> {
  const written: Array<{ kind: 'holdings' | 'history'; names: Set<string> }> = [];
  if (prepared.holdings) {
    const manifest = await writeFundPages(
      outputDir, fund.ticker, 'holdings', prepared.holdings.headers, prepared.holdings.rows,
      config.holdingsPageSize, prepared.holdings.asOfDate, prepared.holdings.source, false,
    );
    written.push({ kind: 'holdings', names: new Set(manifest.pages.map(name => name.split('/')[1])) });
  }
  if (prepared.history) {
    const manifest = await writeFundPages(
      outputDir, fund.ticker, 'history', prepared.history.headers, prepared.history.rows,
      config.historyPageSize, prepared.history.asOfDate, prepared.history.source, false,
    );
    written.push({ kind: 'history', names: new Set(manifest.pages.map(name => name.split('/')[1])) });
  }
  await writeJsonIfChanged(join(outputDir, 'funds', fund.ticker, 'meta.json'), prepared.meta);
  for (const item of written) await removeStalePageFiles(join(outputDir, 'funds', fund.ticker, item.kind), item.names);
  return prepared.meta;
}

/** A published sheet of a fund (all pages of its manifest), or null when a page is missing or unreadable. */
async function readPublishedSheet(outputDir: string, ticker: string, manifest: PageManifest): Promise<{ headers: string[]; rows: Array<Record<string, unknown>> } | null> {
  let headers: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (const page of manifest.pages) {
    const file = recordOf(await readJsonFile(join(outputDir, 'funds', ticker, page)));
    if (!Array.isArray(file.rows)) return null;
    if (Array.isArray(file.headers)) headers = file.headers.map(String);
    for (const row of file.rows) rows.push(recordOf(row));
  }
  return { headers, rows };
}

/**
 * The published Tema history as the windowed-chart block reads it (`Date`, `Close`, `Adj Close`, `Volume`). The sheet keeps
 * only the market close, so each day's Adj Close is rebuilt from the published closes and distributions the way Yahoo
 * adjusts: every later distribution multiplies by 1 - amount / close of the trading day before its ex-date (checked against
 * Yahoo for WELD, TOLL, CANC, DSPY, HRTS and VOLT: within 2e-7). A window then joins with factor 1 and the older days give
 * the same returns as a full run.
 */
export function temaWindowHistory(historyRows: ReadonlyArray<Record<string, unknown>>, distributionRows: ReadonlyArray<unknown>): Array<Record<string, unknown>> {
  const days: Array<{ date: string; close: number }> = [];
  for (const row of historyRows) {
    const date = calendarIso(row.Date);
    const close = numberOrNull(row['Market Price']);
    if (date && close !== null && close > 0) days.push({ date, close });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  // boundary[k]: the product of the distribution factors that apply to every day before index k
  const boundary: number[] = new Array(days.length + 1).fill(1);
  for (const cells of distributionRows) {
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? numberOrNull(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    let k = days.findIndex(day => day.date >= date);
    if (k < 0) k = days.length;
    if (k > 0) boundary[k] *= 1 - amount / days[k - 1].close;
  }
  const rows: Array<Record<string, unknown>> = new Array(days.length);
  let factor = 1;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    factor *= boundary[index + 1];
    rows[index] = { Date: days[index].date, Close: days[index].close, 'Adj Close': days[index].close * factor, Volume: 0 };
  }
  return rows;
}

/** A Yahoo window joined to the published history and distributions (shared windowed-chart block); null when it cannot be joined. */
export function windowedTemaChart(chart: ParsedYahooChart, published: ReadonlyArray<Record<string, unknown>>, distributions: ReadonlyArray<unknown>): ParsedYahooChart | null {
  const dividends = chart.dividends.map(dividend => ({ epoch: Date.parse(`${dividend.date}T00:00:00Z`) / 1000, amount: dividend.amount }));
  const merged = mergeWindowedChart({ days: chart.days, dividends }, published, distributions);
  if (!merged) return null;
  return {
    ...chart,
    days: merged.days.map(day => ({ date: day.date, close: day.close, adjClose: day.adjClose, volume: day.volume })),
    dividends: merged.dividends.map(dividend => ({ date: epochToIsoDate(dividend.epoch), amount: dividend.amount })),
  };
}

/** The workflow times out at 30 min: stop taking new funds after 25 min and still write the index. */
export const SOFT_DEADLINE_MS = 25 * 60_000;

/** Run one full or bounded refresh. All provider calls are injected behind paced clients. */
export async function runUpdater(
  config: UpdaterConfig = readUpdaterConfig(),
  clients: ReturnType<typeof createProviderHttpClients> = createProviderHttpClients(config),
  options: { deadlineMs?: number; now?: () => number } = {},
): Promise<UpdaterRunSummary> {
  const now = options.now ?? Date.now;
  const deadlineAt = now() + (options.deadlineMs ?? SOFT_DEADLINE_MS);
  const startedAt = Date.now();
  resetSecState();
  printUpdaterConfig(config);

  const indexPath = join(config.outputDir, 'index.json');
  const statePath = join(config.outputDir, 'update-state.json');
  const previousIndex = recordOf(await readJsonFile(indexPath));
  const previousFundValues = Array.isArray(previousIndex.funds) ? previousIndex.funds : [];
  const previousByTicker = previousRowsByTicker(previousFundValues);
  let liveCatalog: TemaFund[] = [];
  let catalogSource = 'temaetfs.com/funds';
  // The live catalog (null when only the published feed is known): a catalog-only row it no longer lists is dropped, never retried.
  let live: string[] | null = null;
  try {
    const html = await responseText(clients.issuer, TEMA_CATALOG_URL);
    liveCatalog = parseTemaCatalog(html, TEMA_CATALOG_URL);
    if (!liveCatalog.length) throw new Error('Tema catalog contained no ticker-linked fund routes');
    live = liveCatalog.map(fund => fund.ticker);
  } catch (error) {
    outputNote(`[ catalog  ] live Tema catalog unavailable: ${errorMessage(error)}`);
    liveCatalog = previousFundValues.map(previousCatalogFund).filter((fund): fund is TemaFund => fund !== null);
    catalogSource = 'previous api/tema/index.json fallback';
  }
  if (!liveCatalog.length) throw new Error('No live or previously published Tema catalog entries are available');
  if (previousFundValues.length && liveCatalog.length < previousFundValues.length / 2) {
    outputNote(`[ catalog  ] live catalog is unexpectedly small (${liveCatalog.length}); retaining all previously published fund rows`);
  }
  const catalog = retainCatalogEntries(liveCatalog, withoutStalePlaceholders(previousFundValues.map(recordOf), live));
  console.log(`[ catalog  ] ${catalog.length} Tema ETFs (${catalogSource}${liveCatalog.length < catalog.length ? ' + retained previous entries' : ''})`);

  // Q27: a TICKERS entry outside the live catalog and the published funds stops the run before any fund request
  assertKnownTickers(config.tickers, knownTickers(live, previousFundValues.map(recordOf)), 'the Tema catalog or published feed');

  const staticCandidates = catalog.filter(fund => passesStaticFundFilters(fund, 'Equity', config));
  outputPrintFilter(staticCandidates.length, catalog.length, hasDataDependentFilters(config));
  const state = recordOf(await readJsonFile(statePath));
  const cursor = config.maxFetches > 0 && !config.tickers.length && typeof state.cursor === 'string' ? state.cursor : null;
  // Closed funds leave after the TICKERS filter (so the [ closed ] line names only requested funds) and before MAX_FETCHES is spent.
  const requested = withoutClosedFunds(selectUpdateBatch(staticCandidates, null, 0, config.tickers), fund => fund.ticker, CLOSED_FUNDS);
  const selected = selectUpdateBatch(requested, cursor, config.maxFetches, config.tickers);
  if (config.maxFetches > 0) {
    console.log(`[ cursor   ] selected ${selected.length} of ${staticCandidates.length} eligible funds${cursor ? ` after ${cursor}` : ''}`);
  }

  /** The previous index row of a fund that has published data; a catalog-only row (dataFile null) is never read back as published state. */
  const publishedRow = (ticker: string): Record<string, unknown> | undefined => {
    const row = previousByTicker.get(ticker);
    return row && typeof row.dataFile === 'string' ? row : undefined;
  };

  const output = outputCreateReporter(config.outputDir, selected.length);
  const queue = selected.map(fund => ({ fund }));
  const updated = new Map<string, Record<string, unknown>>();
  let updatedCount = 0;
  let skippedCount = 0;
  let failures = 0;
  let notStartedAtDeadline = 0;
  let startedCount = 0;

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

    const previousHoldings = manifestFromPrevious(previousMeta.holdings, config.holdingsPageSize);
    const previousHistory = manifestFromPrevious(previousMeta.history, config.historyPageSize);
    let nport: TemaNport | null = null;
    if (!holdings && config.edgarFallback) {
      try {
        // the fund's own newest filing, read only when strictly newer than the published holdings date (shared nport-reader block)
        const read = await readTemaNport({ ticker: fund.ticker, name: page?.name || fund.name }, previousHoldings, clients.sec);
        if ('problem' in read) {
          outputNote(`[ edgar    ] ${read.problem}; keeping published holdings`);
        } else {
          const names = await loadCompanyNames(clients.sec).catch((error: unknown) => {
            outputNote(`[ edgar    ] SEC company ticker table unavailable: ${errorMessage(error)}`);
            return null;
          });
          nport = { filing: read.filing, accession: read.candidate.accession, url: read.url };
          holdings = {
            headers: [...HOLDINGS_HEADERS],
            rows: temaNportRows(read.filing, nportTickers(read.filing.positions, names, await loadUsListings((url) => responseText(clients.sec, url)))),
            asOfDate: read.filing.repPdDate,
            source: `SEC EDGAR N-PORT-P fallback (${read.candidate.accession}; report ${read.filing.repPdDate})`,
            downloadUrl: null,
          };
          outputNote(`[ edgar    ] ${fund.ticker}: ${holdings.source}, series ${read.filing.seriesId} "${read.filing.seriesName}"${read.loose ? ' (loose name match)' : ''}`);
        }
      } catch (error) {
        outputNote(`[ edgar    ] ${fund.ticker}: ${errorMessage(error)}`);
      }
    }
    // Fresh holdings (official CSV or N-PORT) that look broken (no weight column, non-numeric weights, a bad weight sum,
    // half the rows gone) never replace the published ones: the fund fails before anything of it is written.
    const published = holdings && previousHoldings && previousHoldings.totalRows ? await readPublishedSheet(config.outputDir, fund.ticker, previousHoldings) : null;
    const publishedWeights = published ? holdingsWeightCount(published.headers, published.rows) : null;
    const holdingsProblem = holdings ? holdingsGuard(holdings.headers, holdings.rows, numberOrNull(recordOf(previousMeta.holdings).totalRows), HOLDINGS_GUARD_RELAX[fund.ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights) : null;
    if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${Object.keys(previousMeta).length ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

    let chart: ParsedYahooChart | null = null;
    let derived: DerivedTemaMetrics | null = null;
    let history: NewHistoryData | null = null;
    if (!config.skipYahoo) {
      try {
        const fetched = parseYahooChart(await responseJson(clients.yahoo, yahooChartUrl(fund.ticker, config.historyRange)));
        // A HISTORY_RANGE window never shrinks the published history (and with it 3y, 5y, 10y and since inception)
        if (/^\d+y$/.test(config.historyRange) && previousHistory && previousHistory.totalRows) {
          const publishedHistory = await readPublishedSheet(config.outputDir, fund.ticker, previousHistory);
          if (!publishedHistory) throw new Error('published history unreadable; a window cannot join it');
          const distributions = Array.isArray(recordOf(previousMeta.distributions).rows) ? recordOf(previousMeta.distributions).rows as unknown[] : [];
          chart = windowedTemaChart(fetched, temaWindowHistory(publishedHistory.rows, distributions), distributions);
          if (!chart) throw new Error(`chart window does not join the published history (${config.historyRange})`);
        } else {
          chart = fetched;
        }
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

    const missing: string[] = [];
    if (!page) missing.push('fund page');
    if (!holdings) missing.push('holdings');
    if (!config.skipYahoo && !history) missing.push('Yahoo history');
    const previewHoldings = holdings
      ? buildPageManifest(fund.ticker, 'holdings', holdings.headers, holdings.rows, config.holdingsPageSize, holdings.asOfDate, holdings.source)
      : previousHoldings;
    const previewHistory = history
      ? buildPageManifest(fund.ticker, 'history', history.headers, history.rows, config.historyPageSize, history.asOfDate, history.source)
      : previousHistory;
    const meta = buildTemaFundMeta({
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
    // SKIP_YAHOO is an explicit request not to refresh the market-derived sections: those travel together, including their as-of date.
    if (config.skipYahoo) carryPreviousSections(meta, previousMeta, ['returns', 'yields', 'distributions']);
    else preservePreviousDividendFrequency(meta, previousMeta, chart);
    reconcileFreshSources(meta, { holdings, history, nport });
    const indexRow = candidateIndexRow(fund, meta, publishedRow(fund.ticker));
    const freshSource = page !== null || holdings !== null || history !== null || (chart !== null && chart.dividends.length > 0);
    // A catalog-only row (dataFile null, written for a new fund no source answered) is no published state: such a fund still fails.
    const hasPrevious = publishedRow(fund.ticker) !== undefined || Object.keys(previousMeta).length > 0;
    return { page, holdings, history, chart, derived, nport, freshSource, missing, hasPrevious, meta, indexRow };
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (now() >= deadlineAt && queue.length) {
        // reported once after the pool drains, so it never lands between fund lines
        notStartedAtDeadline += queue.length;
        skippedCount += queue.length;
        queue.length = 0;
        return;
      }
      const item = queue.shift();
      if (!item) return;
      startedCount += 1;
      const fund = item.fund;
      const before = await output.before(fund.ticker);
      try {
        const prepared = await prepareFund(fund);
        if (!prepared.freshSource || (prepared.missing.length && prepared.hasPrevious)) {
          // Fund-level consistency: every fund is either fully updated or fully kept from before.
          // A new fund no source answered is failed (counted once): it keeps its catalog-only row and gets no funds/<T>/ files.
          const reason = prepared.freshSource ? `${prepared.missing.join(', ')} unavailable; previous state kept` : 'all providers unavailable; previous data retained';
          await output.result(fund.ticker, before, prepared.hasPrevious ? 'skipped' : 'failed', prepared.hasPrevious ? reason : 'no source answered; no data published for this fund yet');
          if (prepared.hasPrevious) skippedCount += 1;
          else failures += 1;
          continue;
        }
        if (!fundFilterPasses(prepared.indexRow, config)) {
          skippedCount += 1;
          await output.result(fund.ticker, before, 'skipped', 'does not match configured output filters');
          continue;
        }
        const meta = await writePreparedFund(config.outputDir, fund, prepared, config);
        const row = candidateIndexRow(fund, meta, publishedRow(fund.ticker));
        updated.set(fund.ticker, row);
        updatedCount += 1;
        await output.result(fund.ticker, before, undefined, undefined, { ...row, distributions: meta.distributions });
      } catch (error) {
        failures += 1;
        await output.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(1, config.concurrency), Math.max(1, queue.length)) }, () => worker()));

  const metaExists = async (ticker: string): Promise<boolean> => (await readJsonFile(join(config.outputDir, 'funds', ticker, 'meta.json'))) !== null;
  const indexFunds: Array<Record<string, unknown>> = [];
  for (const fund of catalog) {
    const fresh = updated.get(fund.ticker);
    const row = fresh ?? minimalIndexFund(fund, previousByTicker.get(fund.ticker));
    indexFunds.push({ ...row, dataFile: (await metaExists(fund.ticker)) ? `./funds/${fund.ticker}/meta.json` : null });
  }
  // a fund that has funds/<T>/meta.json is always listed, even when it dropped out of the catalog and the previous index
  const listed = new Set(indexFunds.map(row => String(row.ticker)));
  for (const entry of await readdir(join(config.outputDir, 'funds'), { withFileTypes: true }).catch(() => [])) {
    const ticker = entry.name.toUpperCase();
    if (!entry.isDirectory() || listed.has(ticker) || !/^[A-Z0-9]{2,5}$/.test(ticker)) continue;
    const meta = await readJsonFile(join(config.outputDir, 'funds', entry.name, 'meta.json'));
    if (meta === null) continue;
    const fund = { ticker, name: String(recordOf(meta).name || ticker), fundPage: `https://temaetfs.com/${ticker.toLowerCase()}` };
    indexFunds.push(candidateIndexRow(fund, recordOf(meta), previousByTicker.get(ticker)));
  }
  indexFunds.sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const finalFunds = markClosedFunds(indexFunds, CLOSED_FUNDS);
  const index = buildIndexDocument(finalFunds, generatedAt, generatedAt);
  await writeJsonIfChanged(indexPath, index);
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(previousFundValues.map(recordOf), finalFunds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');

  if (config.maxFetches > 0 && !config.tickers.length && startedCount > 0) {
    const lastTicker = selected[startedCount - 1].ticker;
    await writeJsonIfChanged(statePath, { cursor: lastTicker });
    console.log(`[ cursor   ] batch of ${selected.length} reached - next run continues after ${lastTicker}`);
  } else if (config.maxFetches === 0 && !config.tickers.length) {
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
  if (notStartedAtDeadline) console.log(`[ deadline ] soft run deadline reached; ${notStartedAtDeadline} funds not started keep their published state`);
  console.log(output.summary(startedAt));
  console.log(outputCounts(catalog.length, summary.holdings, summary.history));
  // A TICKERS run never reads, writes or deletes the cursor (see the state handling above).
  if (config.tickers.length) console.log('[ cursor   ] TICKERS run: cursor untouched');
  else if (config.maxFetches === 0) console.log('[ cursor   ] full pass complete (cursor reset)');
  return summary;
}

/** True when something was selected and every selected fund failed (the CLI then exits non-zero). */
export function allFundsFailed(summary: UpdaterRunSummary): boolean {
  return summary.selectedCount > 0 && summary.failures >= summary.selectedCount;
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
  const summary = await runUpdater(readUpdaterConfig(controls));
  if (allFundsFailed(summary)) {
    console.error('[ error    ] every selected fund failed');
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main().catch(error => {
    console.error(`[ error    ] ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, or with a foreign ISIN when the Nasdaq Trader directories list that ticker for the same company (a U.S.
 *   listing such as Linde, NXP, IMAX); renamed issuers through `nportRenamedIssuers`; an abbreviated or reordered name the
 *   exact key misses through a looser key that must name one company (`nportLooseKey`, Q35: `Lowe's Cos` = `LOWES COMPANIES`,
 *   `SCHWAB CHARLES CORP`); never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/**
 * Abbreviated words of issuer names (open-items etfs Q35) -> one spelling, each seen in N-PORT-P filings of the brands against
 * the SEC company_tickers.json title of the same CUSIP issuer (2026-10-26): `LOWES COS` / `LOWES COMPANIES`, `AMERIPRISE FINL`,
 * `VICI PPTYS`, `TAIWAN SEMICONDUCTOR MFG`, `ZIONS BANCORP NA` / `ZIONS BANCORPORATION NATIONAL ASSOCIATION`. '' drops the word.
 */
function nportLooseWords(): Record<string, string> {
  return {
    COS: '', COMPANIES: '', AND: '', OF: '', NA: '', NATIONAL_ASSOCIATION: '', INCORPORATION: '', REIT: '',
    BANCORPORATION: 'BANCORP', FINL: 'FINANCIAL', PPTYS: 'PROPERTIES', PPTY: 'PROPERTY', MFG: 'MANUFACTURING', GRP: 'GROUP',
    HLDGS: 'HOLDINGS', HLDG: 'HOLDING', INTL: 'INTERNATIONAL', SVCS: 'SERVICES', TECH: 'TECHNOLOGIES', TECHNOLOGY: 'TECHNOLOGIES',
    SYS: 'SYSTEMS', NATL: 'NATIONAL', RES: 'RESOURCES', RLTY: 'REALTY', INDS: 'INDUSTRIES', INS: 'INSURANCE', BROS: 'BROTHERS', SVGS: 'SAVINGS',
  };
}

/**
 * The second, looser company key (open-items etfs Q35), used only for a row the exact key (`nportNameKey`) left without a
 * ticker: a Bloomberg location or article after a slash dropped (`Charles Schwab Corp/The`, `Energy Fuels Inc/canada`; never a
 * one-word start like `RE/MAX`), abbreviations read as one word (`nportLooseWords`), the share class dropped (the caller picks
 * the class) and the words sorted, so EDGAR's reordered titles meet the usual order: `SCHWAB CHARLES CORP` = `Charles Schwab
 * Corp`, `HORTON D R INC` = `DR Horton Inc`, `PRICE T ROWE GROUP INC` = `T Rowe Price Group Inc`. Several companies can share a
 * loose key: `parseSecCompanyNames` and `parseUsListings` keep such a key empty, so it never gives a ticker.
 */
export function nportLooseKey(value: unknown): string {
  let raw = String(value === null || value === undefined ? '' : value).trim();
  const slash = /^(.*\s\S*[A-Za-z]{2}[.,]?)\s*\/\s*([A-Za-z][A-Za-z .,']*)$/.exec(raw);
  if (slash) raw = slash[1];
  // a trailing EDGAR or Bloomberg qualifier after the legal form: `CHEVRON CORP NEW`, `US BANCORP DEL`, `PROGRESSIVE CORP OHIO`
  raw = raw.replace(/\b(CORP(?:ORATION)?|INC(?:ORPORATED)?|CO(?:MPANY)?|LTD|BANCORP|GROUP|GRP|TRUST|HOLDINGS?)\.?,?\s+(?:NEW|DEL|REINCORPORATION|OHIO|AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\.?$/i, '$1');
  const words = nportLooseWords();
  const key = nportNameKey(raw).replace(/ CL [A-Z]$/, '').replace(/\bNATIONAL ASSOCIATION\b/g, 'NATIONAL_ASSOCIATION');
  return key.split(' ').map((word) => (Object.prototype.hasOwnProperty.call(words, word) ? words[word] : word)).filter(Boolean).sort().join(' ');
}

/**
 * SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too).
 * Each loose key (`nportLooseKey`) is added as `\u0001<loose key>` -> the company's tickers, space-separated in the table's
 * order, or '' when two companies (CIKs) share it; `nportTickers` reads them for rows the exact key misses.
 */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const loose = new Map<string, { cik: string; tickers: string[] } | null>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown; cik_str?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
    const looseKey = nportLooseKey(row.title);
    const cik = String(row.cik_str === null || row.cik_str === undefined ? '' : row.cik_str).replace(/\D/g, '');
    if (!looseKey || !Number(cik)) continue;
    const seen = loose.get(looseKey);
    if (seen === undefined) loose.set(looseKey, { cik: String(Number(cik)), tickers: [ticker] });
    else if (seen && seen.cik === String(Number(cik))) { if (seen.tickers.indexOf(ticker) < 0) seen.tickers.push(ticker); }
    else loose.set(looseKey, null);
  }
  loose.forEach((seen, looseKey) => names.set(`\u0001${looseKey}`, seen ? seen.tickers.join(' ') : ''));
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Renamed issuers (open-items etfs Q33): N-PORT filers keep an issuer's old name for months while SEC's company_tickers.json
 * titles only the new one, so the name match misses (JPMorgan JEPI's Exxon). Old name key (`nportNameKey`) -> [ticker, CUSIP
 * issuer number (the first six characters)]. Used only when the SEC table has no such key, the row's CUSIP (or U.S. ISIN) has
 * that issuer number and the SEC table still lists the ticker. Each entry was confirmed on 2026-10-26: an EC row without a
 * ticker in the N-PORT-P filings of large U.S. equity funds (VTI, SCHB, ITOT, JEPI, IWB, VB, SCHA, FNDX, FNDA, ...) whose name
 * is a former EDGAR name of the CIK that has the ticker today (data.sec.gov submissions `formerNames`, the date the old name
 * ended), the ticker the CIK's only common stock in the Nasdaq Trader directories. Add an entry only with the same evidence.
 * A function, not a const: blocks sit at the end of update-data.ts, below the top-level run, so only declarations are hoisted.
 */
export function nportRenamedIssuers(): Array<[string, string, string]> {
  return [
    ['AADI BIOSCIENCE', 'WHWK', '00032Q'], // CIK 1422142 Whitehawk Therapeutics, Inc., former EDGAR name until 2025-03-18
    ['ABACUS LIFE', 'ABX', '00258Y'], // CIK 1814287 Abacus Global Management, Inc., former EDGAR name until 2025-02-04
    ['ACUITY BRANDS', 'AYI', '00508Y'], // CIK 1144215 ACUITY INC. (DE), former EDGAR name until 2025-04-17
    ['AEROVATE THERAPEUTICS', 'JBIO', '008064'], // CIK 1798749 Jade Biosciences, Inc., former EDGAR name until 2025-04-30
    ['AILERON THERAPEUTICS', 'RNTX', '00887A'], // CIK 1420565 Rein Therapeutics, Inc., former EDGAR name until 2024-12-09
    ['ALLOVIR', 'KLRS', '482929'], // CIK 1754068 Kalaris Therapeutics, Inc., former EDGAR name until 2025-03-12
    ['AMC NETWORKS', 'AMCX', '00164V'], // CIK 1514991 AMC Global Media Inc., former EDGAR name until 2026-04-03
    ['AMMO', 'POWW', '00175J'], // CIK 1015383 Outdoor Holding Co, former EDGAR name until 2025-04-24
    ['ARDENT HEALTH PARTNERS', 'ARDT', '03980N'], // CIK 1756655 Ardent Health, Inc., former EDGAR name until 2025-05-23
    ['ARENA GROUP HOLDINGS', 'PAAI', '040044'], // CIK 894871 Paradium.AI, Inc., former EDGAR name until 2026-08-13
    ['ATEGRITY SPECIALTY HOLDINGS LLC', 'ASIC', '04681Y'], // CIK 2040491 Ategrity Specialty Insurance Co Holdings, former EDGAR name until 2025-06-11
    ['BAKKT HOLDINGS', 'BKKT', '05759B'], // CIK 1820302 Bakkt, Inc., former EDGAR name until 2026-01-20
    ['BED BATH AND BEYOND', 'NXH', '690370'], // CIK 1130713 NEIGHBORHOOD INTELLIGENCE, INC., former EDGAR name until 2026-08-14
    ['BLACKROCK FUNDING', 'BLK', '09290D'], // CIK 2012383 BlackRock, Inc., former EDGAR name until 2024-10-01
    ['BRIGHTSPHERE INVESTMENT GROUP', 'AAMI', '10948W'], // CIK 1748824 Acadian Asset Management Inc., former EDGAR name until 2024-11-14
    ['CARA THERAPEUTICS', 'TVRD', '140755'], // CIK 1346830 Tvardi Therapeutics, Inc., former EDGAR name until 2025-04-11
    ['CEA INDUSTRIES', 'BNC', '86887P'], // CIK 1482541 BNB Standard Corp, former EDGAR name until 2026-09-21
    ['CHROMADEX', 'NAGE', '171077'], // CIK 1386570 Niagen Bioscience, Inc., former EDGAR name until 2025-03-10
    ['CLEANCORE SOLUTIONS', 'ZONE', '184492'], // CIK 1956741 Zone Frontier Inc., former EDGAR name until 2026-08-20
    ['CORPORATE OFFICE PROPERTIES TRUST', 'CDP', '22002T'], // CIK 860546 COPT DEFENSE PROPERTIES, former EDGAR name until 2023-09-14
    ['CULLINAN ONCOLOGY', 'CGEM', '230031'], // CIK 1789972 Cullinan Therapeutics, Inc., former EDGAR name until 2024-04-02
    ['DIME COMMUNITY BANCSHARES', 'DCOM', '25432X'], // CIK 846617 Dime Commercial Bancshares, Inc. /NY/, former EDGAR name until 2026-05-27
    ['DOMO', 'HUCK', '257554'], // CIK 1505952 Huckleberry.ai, Inc., former EDGAR name until 2026-09-03
    ['EASTSIDE DISTILLING', 'BLNE', '277802'], // CIK 1534708 Beeline Holdings, Inc., former EDGAR name until 2025-03-11
    ['EQUITY RESIDENTIAL', 'VMRK', '29476L'], // CIK 906107 VIVMARK RESIDENTIAL, former EDGAR name until 2026-08-12
    ['EXP WORLD HOLDINGS', 'AGNT', '30212W'], // CIK 1495932 AGNT, Inc., former EDGAR name until 2026-06-01
    ['EXXON MOBIL', 'XOM', '30231G'], // holding company reorganization: XOM is CIK 2115436 ExxonMobil Holdings Corp since 2026, the old Exxon Mobil Corp is CIK 34088
    ['EYEPOINT PHARMACEUTICALS', 'EYPT', '30233G'], // CIK 1314102 EyePoint, Inc., former EDGAR name until 2025-12-08
    ['EZFILL HOLDINGS', 'NXXT', '652941'], // CIK 1817004 NEXTNRG, INC., former EDGAR name until 2025-02-14
    ['FORTUNE BRANDS HOME AND SECURITY', 'FBIN', '34964C'], // CIK 1519751 Fortune Brands Innovations, Inc., former EDGAR name until 2022-12-14
    ['FRANKLIN RESOURCES', 'BEN', '354613'], // CIK 38777 FRANKLIN TEMPLETON INC, former EDGAR name until 2026-08-14
    ['FREYR BATTERY', 'TE', '35834F'], // CIK 1992243 T1 Energy Inc., former EDGAR name until 2025-02-14
    ['GALLAGHER ARTHUR J AND', 'AJG', '363576'], // CIK 354190 Arthur J. Gallagher & Co., former EDGAR name until 2019-08-14
    ['GRAINGER WW', 'GWW', '384802'], // CIK 277135 W.W. GRAINGER, INC., former EDGAR name until 2019-10-15
    ['GRAY TELEVISION', 'GTN', '389375'], // CIK 43196 GRAY MEDIA, INC, former EDGAR name until 2025-02-24
    ['GREAT AJAX', 'RPT', '38983D'], // CIK 1614806 Rithm Property Trust Inc., former EDGAR name until 2024-11-13
    ['GREENIDGE GENERATION HOLDINGS', 'VIP', '39531G'], // CIK 1844971 Vulcan Infrastructure & Power Inc., former EDGAR name until 2026-07-09
    ['HANNON ARMSTRONG SUSTAINABLE INFRASTRUCTURE CAPITAL', 'HASI', '41068X'], // CIK 1561894 HA Sustainable Infrastructure Capital, Inc., former EDGAR name until 2024-07-02
    ['HARTFORD FINANCIAL SERVICES GROUP', 'HIG', '416515'], // CIK 874766 HARTFORD INSURANCE GROUP, INC., former EDGAR name until 2025-01-30
    ['HELIX ENERGY SOLUTIONS GROUP', 'HOS', '42330P'], // CIK 866829 HORNBECK OFFSHORE SERVICES, INC., former EDGAR name until 2026-08-31
    ['HYSTER YALE MATERIALS HANDLING', 'HY', '449172'], // CIK 1173514 HYSTER-YALE, INC., former EDGAR name until 2024-05-30
    ['IAC', 'PPLI', '44891N'], // CIK 1800227 People Inc, former EDGAR name until 2026-06-02
    ['IDENTIV', 'INVE', '45170X'], // CIK 1036044 INVE Technologies, Inc., former EDGAR name until 2026-08-25
    ['IRHYTHM TECHNOLOGIES', 'IRTC', '450056'], // CIK 1388658 iRhythm Holdings, Inc., former EDGAR name until 2026-01-12
    ['ISSUER DIRECT', 'ACCS', '46520M'], // CIK 843006 ACCESS Newswire Inc., former EDGAR name until 2025-01-16
    ['JANOVER', 'DFDV', '47100L'], // CIK 1805526 DeFi Development Corp., former EDGAR name until 2025-04-15
    ['JOHN BEAN TECHNOLOGIES', 'JBTM', '477839'], // CIK 1433660 JBT MAREL Corp, former EDGAR name until 2024-12-20
    ['LENDINGCLUB', 'HAPN', '52603A'], // CIK 1409970 Happen, Inc., former EDGAR name until 2026-06-18
    ['LIXTE BIOTECHNOLOGY HOLDINGS', 'NMAD', '539319'], // CIK 1335105 NOMAD POWER SOLUTIONS, INC., former EDGAR name until 2026-07-02
    ['MKS INSTRUMENTS', 'MKSI', '55306N'], // CIK 1049502 MKS INC, former EDGAR name until 2025-05-15
    ['MONTANA TECHNOLOGIES', 'AIRJ', '612160'], // CIK 1855474 AirJoule Technologies Corp., former EDGAR name until 2024-10-21
    ['MULTIPLAN', 'CTEV', '62548M'], // CIK 1793229 Claritev Corp, former EDGAR name until 2025-02-07
    ['NEWPARK RESOURCES', 'NPKI', '651718'], // CIK 71829 NPK International Inc., former EDGAR name until 2024-12-03
    ['ONCOLOGY INSTITUTE', 'STLN', '68236X'], // CIK 1799191 Starling Oncology, Inc., former EDGAR name until 2026-08-03
    ['OREILLY AUTOMOTIVE', 'ORLY', '67103H'], // CIK 898173 O REILLY AUTOMOTIVE INC, former EDGAR name until 1998-04-10
    ['ORION OFFICE REIT', 'ONL', '68629Y'], // CIK 1873923 Orion Properties Inc., former EDGAR name until 2025-03-07
    ['PALTALK', 'IPM', '69764K'], // CIK 1355839 INTELLIGENT PROTECTION MANAGEMENT CORP., former EDGAR name until 2025-01-02
    ['PARAMOUNT SKYDANCE', 'SKYD', '69932A'], // CIK 2041610 Skydance Corp, former EDGAR name until 2026-10-06
    ['PIEDMONT OFFICE REALTY TRUST', 'PDM', '720190'], // CIK 1042776 Piedmont Realty Trust, Inc., former EDGAR name until 2025-06-02
    ['PIERIS PHARMACEUTICALS', 'PVLA', '697947'], // CIK 1583648 PALVELLA THERAPEUTICS, INC., former EDGAR name until 2024-12-12
    ['PLUS THERAPEUTICS', 'CNSY', '72941H'], // CIK 1095981 CERENOME, INC., former EDGAR name until 2026-07-01
    ['RUMBLE', 'RUM', '78137L'], // CIK 1830081 RUM Group Inc., former EDGAR name until 2026-06-17
    ['SCHWEITZER MAUDUIT INTERNATIONAL', 'MATV', '808541'], // CIK 1000623 Mativ Holdings, Inc., former EDGAR name until 2022-07-01
    ['SEQLL', 'CIRC', '048592'], // CIK 1605888 CIRCLE8 GROUP INC, former EDGAR name until 2024-06-06
    ['SHOE CARNIVAL', 'SHOE', '824889'], // CIK 895447 SHOE STATION GROUP INC, former EDGAR name until 2026-06-11
    ['TANGER FACTORY OUTLET CENTERS', 'SKT', '875465'], // CIK 899715 TANGER INC., former EDGAR name until 2023-11-15
    ['TECNOGLASS', 'TGLS', '87877F'], // CIK 1534675 Tecnoglass Holdings Inc., former EDGAR name until 2026-07-07
    ['TEMPUR SEALY INTERNATIONAL', 'SGI', '88023U'], // CIK 1206264 SOMNIGROUP INTERNATIONAL INC., former EDGAR name until 2025-02-14
    ['TEVOGEN BIO HOLDINGS', 'TVGN', '88165K'], // CIK 1860871 Tevogen Inc., former EDGAR name until 2026-07-30
    ['TORO COMBINECO', 'TTGT', '87874R'], // CIK 2018064 TechTarget, Inc., former EDGAR name until 2024-11-20
    ['VIAD', 'PRSU', '92552R'], // CIK 884219 Pursuit Attractions & Hospitality, Inc., former EDGAR name until 2024-12-31
    ['WELLGISTICS HEALTH', 'MEDS', '949503'], // CIK 2030763 DataMeds AI, Inc., former EDGAR name until 2026-07-21
    ['ZOOM VIDEO COMMUNICATIONS', 'ZM', '98980L'], // CIK 1585521 Zoom Communications, Inc., former EDGAR name until 2024-11-12
    ['ZYMEWORKS DELAWARE', 'ZYME', '98985Y'], // CIK 1937653 Zymeworks Inc., former EDGAR name until 2022-10-13
  ];
}

/** Nasdaq Trader symbol directories: Nasdaq listings, and NYSE, NYSE American, NYSE Arca, Cboe and IEX listings. */
export function nportUsListingsUrls(): string[] {
  return ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'];
}

/**
 * The Nasdaq Trader symbol directories (the texts of `nportUsListingsUrls()`, in any order) as U.S.-listed symbol -> security
 * name; test issues and ETFs left out, CQS class dots as SEC dashes (`BRK.B` -> `BRK-B`). An issuer listed under several
 * symbols (Liberty Global LBTYA, LBTYB, LBTYK) also gets the entry `\u0000<name key>` -> its symbols, which `nportUsListed` reads
 * to require the share class. null unless every text is a whole directory (a header with Security Name and the File Creation
 * Time footer), so a failed or cut download changes nothing.
 */
export function parseUsListings(texts: ReadonlyArray<string>): Map<string, string> | null {
  const listings = new Map<string, string>();
  if (!texts.length) return null;
  for (let t = 0; t < texts.length; t++) {
    const lines = String(texts[t] === null || texts[t] === undefined ? '' : texts[t]).split(/\r?\n/).filter((line) => line.trim());
    const header = (lines[0] || '').split('|').map((cell) => cell.trim().toUpperCase());
    const nameAt = header.indexOf('SECURITY NAME'), testAt = header.indexOf('TEST ISSUE'), etfAt = header.indexOf('ETF');
    if (nameAt < 0 || !/^FILE CREATION TIME/i.test(lines[lines.length - 1] || '')) return null;
    for (let i = 1; i < lines.length - 1; i++) {
      const cells = lines[i].split('|');
      const symbol = String(cells[0] || '').trim().toUpperCase().replace(/[./ ]/g, '-');
      if (!symbol || String(cells[testAt] || '').trim() === 'Y' || String(cells[etfAt] || '').trim() === 'Y' || listings.has(symbol)) continue;
      listings.set(symbol, String(cells[nameAt] || '').trim());
    }
  }
  const issuers = new Map<string, string[]>();
  const loose = new Map<string, string[]>();
  listings.forEach((name, symbol) => {
    const key = nportNameKey(nportIssuerName(name));
    if (key) issuers.set(key, (issuers.get(key) || []).concat(symbol));
    const looseKey = nportLooseKey(nportIssuerName(name));
    if (looseKey && nportListedCommon(name)) loose.set(looseKey, (loose.get(looseKey) || []).concat(symbol));
  });
  issuers.forEach((symbols, key) => { if (symbols.length > 1) listings.set(`\u0000${key}`, symbols.join(' ')); });
  loose.forEach((symbols, looseKey) => listings.set(`\u0001${looseKey}`, symbols.join(' ')));
  return listings;
}

/** Is a symbol directory security name a company's own common or ordinary shares (not preferred, depositary, notes, warrants, units, rights)? */
function nportListedCommon(name: string): boolean {
  return !/\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b|\bPREFERRED\b|\bPREF\b|\bPFD\b|\bNOTES?\b|\bDEBENTURES?\b|\bWARRANTS?\b|\bUNITS?\b|\bRIGHTS?\b|%|\bDUE\s+\d{4}\b|\bPERPETUAL\b|\bCUMULATIVE\b|\bSUBORDINATED\b|\bTRUST\s+(?:SECURITIES|CERTIFICATES)\b|\bETNS?\b|\bEXCHANGE[- ]TRADED\b/i.test(name);
}

/** The share class a name or title states (`Class C`, `CL C`, `Series A`, `LIBERTY GLOBAL-C`), '' for none. */
function nportShareClass(...texts: unknown[]): string {
  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] === null || texts[i] === undefined ? '' : texts[i]);
    const match = /\b(?:CLASS|CL|SERIES|SER)\.?\s+([A-Z])\b/i.exec(text) || /[A-Z]-\s?([A-Z])(?:\s|$)/i.exec(text);
    if (match) return match[1].toUpperCase();
  }
  return '';
}

/** Both symbol directories through the brand's `getText`, null when one fails (`parseUsListings`); load once per run. */
export async function readUsListings(getText: (url: string, label: string) => Promise<string>): Promise<Map<string, string> | null> {
  try {
    return parseUsListings(await Promise.all(nportUsListingsUrls().map((url) => getText(url, `Nasdaq Trader ${url.replace(/^.*\//, '')}`))));
  } catch {
    return null;
  }
}

/** A security or sheet name without its share description: `Accenture plc Class A Ordinary Shares (Ireland)` -> `Accenture plc`. */
function nportIssuerName(value: unknown): string {
  return String(value === null || value === undefined ? '' : value).split(' - ')[0]
    .replace(/\s+(?:\(|(?:CLASS|SERIES)\s+[A-Z]\b|COMMON\b|ORDINARY\b|SUBORDINATE\b|SUB\.?\s+VOT|(?:LIMITED|RESTRICTED)\s+VOTING\b|VOTING\b|SHARES?\b|STOCK\b|AMERICAN\s+DEPOSITARY\b|TRADING\s+UNDER\b)[\s\S]*$/i, '');
}

/**
 * Is `ticker` the company's own U.S. listing? The Nasdaq Trader directories (`parseUsListings`) list it under the same company
 * (same name key, or one key the start of the other: `BUNGE GLOBAL` and the directory's `BUNGE`, a name cut short after two words
 * or more: `CHECK POINT SOFTWARE TECH`), and not as depositary or New York registry shares, which are another security than
 * the foreign line (Shell's SHEL ADR, ASML's New York shares). When the issuer has several listed classes, the name or title
 * must state the listed class (Liberty Latin America Class C is LILAK, not LILA). False without listings. Callers check that
 * the line trades in U.S. dollars: a Toronto or London line of the same company in its own currency never gets the U.S. ticker.
 */
export function nportUsListed(listings: Map<string, string> | null, ticker: string, name: unknown, title: unknown = ''): boolean {
  if (!listings) return false;
  const listed = listings.get(String(ticker).trim().toUpperCase().replace(/[./ ]/g, '-'));
  if (listed === undefined || /\bDEPOSITARY\b|\bADSS?\b|\bADRS?\b|\bREGISTRY\b/i.test(listed)) return false;
  const a = nportNameKey(nportIssuerName(listed)), b = nportNameKey(nportIssuerName(name));
  if (!a || !b) return false;
  const short = a.length < b.length ? a : b, long = a.length < b.length ? b : a;
  if (a !== b && !(short.length >= 4 && long.indexOf(`${short} `) === 0) && !(short.split(' ').length >= 2 && long.indexOf(short) === 0)) return false;
  const listedClass = nportShareClass(listed);
  return !listedClass || !listings.has(`\u0000${a}`) || nportShareClass(name, title) === listedClass;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker):
 * - U.S. ISIN or none, traded in USD (or with no currency): the filer's own `<ticker value>`, else the SEC issuer-name table
 *   (`names`) when the row has a CUSIP or a U.S. ISIN, else a renamed issuer (`nportRenamedIssuers`)
 * - foreign ISIN (Linde IE, NXP NL, IMAX CA): only traded in USD and only when the symbol directories (`listings`,
 *   `parseUsListings`) confirm the filer's or the name-matched ticker for the same company (`nportUsListed`); a local line in
 *   another currency, and every foreign row without listings, gets none
 * A ticker that lands on two different securities (Alphabet A and C, an ordinary share and its ADR) is dropped from the
 * name-matched rows; when the filer itself gave it to two securities it is dropped from all of them. Rows still without a
 * ticker get the second, looser name match (`nportLooseTickers`), which never changes a ticker given here. Bonds, cash, funds
 * and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null, listings: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const secTickers = new Set<string>();
  if (names) names.forEach((ticker, key) => { if (key.charAt(0) !== '\u0001') secTickers.add(ticker); });
  const renames = nportRenamedIssuers();
  const renamed = (position: NportPosition, key: string): string => {
    const issuer = (position.cusip || (/^US[0-9A-Z]{10}$/.test(position.isin) ? position.isin.slice(2, 11) : '')).slice(0, 6);
    const hit = renames.filter((entry) => entry[0] === key && entry[2] === issuer && secTickers.has(entry[1]))[0];
    return hit ? hit[1] : '';
  };
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    const usd = foreign ? position.currency === 'USD' && Boolean(listings) : !position.currency || position.currency === 'USD';
    if (!equity || !usd) return '';
    const filer = /^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker) ? position.ticker : '';
    const key = nportNameKey(position.name);
    const named = names && (/^[0-9A-Z]{9}$/.test(position.cusip) || /^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) ? names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '' : '';
    if (!foreign) {
      fromFiler[index] = Boolean(filer);
      return filer || named || (names ? renamed(position, key) : '');
    }
    if (filer && nportUsListed(listings, filer, position.name, position.title)) {
      fromFiler[index] = true;
      return filer;
    }
    return named && nportUsListed(listings, named, position.name, position.title) ? named : '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  const exact = tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
  return nportLooseTickers(positions, exact, names, listings);
}

/**
 * The second name match (open-items etfs Q35) for the common-stock rows `nportTickers` left without a ticker; the tickers it
 * already gave never change. The row's loose key (`nportLooseKey`) must name one company: in the SEC table (`\u0001` entries of
 * `parseSecCompanyNames`, one CIK) and/or in the symbol directories (`\u0001` entries of `parseUsListings`, common shares only),
 * and when both know the key they must agree on the company. Of that company's tickers only its listed common shares count
 * (with one SEC ticker and no listing, that ticker); several of them (Fox, Lennar, Zillow) need the class the row states in its
 * name or title, matched to the listed security name, else no ticker. A foreign ISIN needs the directory listing of the same
 * key (its own U.S. shares, never depositary ones). A ticker that a row of `exact` holds for another security, or that this pass
 * finds for two securities, is dropped.
 */
function nportLooseTickers(positions: ReadonlyArray<NportPosition>, exact: string[], names: Map<string, string> | null, listings: Map<string, string> | null): string[] {
  if (!names) return exact;
  const companyOf = new Map<string, string>();
  names.forEach((tickers, key) => { if (key.charAt(0) === '\u0001' && tickers) tickers.split(' ').forEach((ticker) => companyOf.set(ticker, key)); });
  const securityOf = (position: NportPosition): string => position.cusip || position.isin || position.other || nportNameKey(position.name);
  const listedClass = (symbol: string): string => nportShareClass(listings ? listings.get(symbol) : '');
  const found = positions.map((position, index) => {
    if (exact[index] || position.assetCat !== 'EC' || position.derivative || nportIsRight(position)) return '';
    const foreign = Boolean(position.isin) && position.isin.slice(0, 2) !== 'US';
    if (foreign ? position.currency !== 'USD' || !listings : position.currency && position.currency !== 'USD') return '';
    if (!/^[0-9A-Z]{9}$/.test(position.cusip) && !/^[A-Z]{2}[0-9A-Z]{10}$/.test(position.isin)) return '';
    const key = nportLooseKey(position.name);
    if (!key) return '';
    const sec = names.get(`\u0001${key}`);
    const listed = listings ? listings.get(`\u0001${key}`) : undefined;
    if (sec === '' || (sec === undefined && listed === undefined) || (foreign && !listed)) return '';
    const listedSymbols = listed ? listed.split(' ') : [];
    // the company: the SEC entry of the key, else the one SEC entry every listed symbol of the key belongs to
    const company = sec !== undefined ? `\u0001${key}` : companyOf.get(listedSymbols[0]) || '';
    if (!company || listedSymbols.some((symbol) => companyOf.get(symbol) !== company)) return '';
    const tickers = String(names.get(company) || '').split(' ').filter(Boolean);
    const common = tickers.filter((ticker) => listings && listings.has(ticker) && nportListedCommon(String(listings.get(ticker))));
    const candidates = common.length ? common : tickers.length === 1 && !foreign ? tickers : [];
    if (foreign && candidates.some((ticker) => listedSymbols.indexOf(ticker) < 0)) return '';
    const wanted = nportShareClass(position.name, position.title);
    if (candidates.length === 1) return !wanted || !listings || !listings.has(candidates[0]) || !listedClass(candidates[0]) || listedClass(candidates[0]) === wanted ? candidates[0] : '';
    const classed = wanted ? candidates.filter((ticker) => listedClass(ticker) === wanted) : [];
    return classed.length === 1 ? classed[0] : '';
  });
  const taken = new Map<string, string[]>();
  exact.forEach((ticker, index) => { if (ticker) taken.set(ticker, (taken.get(ticker) || []).concat(securityOf(positions[index]))); });
  found.forEach((ticker, index) => {
    if (!ticker) return;
    const seen = taken.get(ticker) || [];
    if (seen.indexOf(securityOf(positions[index])) < 0) taken.set(ticker, seen.concat(securityOf(positions[index])));
  });
  return exact.map((ticker, index) => ticker || (found[index] && (taken.get(found[index]) || []).length === 1 ? found[index] : ''));
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
