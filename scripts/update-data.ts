#!/usr/bin/env bun
/// <reference types="bun" />

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
    if (!new RegExp(`^${ticker}(?:\\b|\\s)`, 'i').test(label) || !/\bETF\b/i.test(label)) continue;
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
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
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
    year = Number(us[3]);
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
