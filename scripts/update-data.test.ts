/// <reference types="bun" />

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  findTemaHoldingsCsvUrl,
  normalizeTemaDate,
  parseCsv,
  parseTemaFundPage,
  parseTemaCatalog,
  parseTemaHoldingsCsv,
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
