/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { readUpdaterConfig, updaterHelpText } from './update-data.ts';

const [readme, workflow, indexText] = await Promise.all([
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/update-data.yml', import.meta.url), 'utf8'),
  readFile(new URL('../api/tema/index.json', import.meta.url), 'utf8'),
]);

function headingsOutsideFences(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push(`${match[1]} ${match[2]}`);
  }
  return headings;
}

function tableFirstColumn(markdown: string, heading: string): { label: string; row: string }[] {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) throw new Error(`README section not found: ${heading}`);
  const bodyStart = markdown.indexOf('\n', start) + 1;
  const followingHeading = /^##\s+/m.exec(markdown.slice(bodyStart));
  const bodyEnd = followingHeading ? bodyStart + followingHeading.index : markdown.length;
  return markdown.slice(bodyStart, bodyEnd).split(/\r?\n/)
    .filter(line => /^\|/.test(line) && !/^\|\s*:?-+/.test(line))
    .slice(1)
    .map(row => {
      const firstCell = /^\|\s*(.*?)\s*\|/.exec(row)?.[1];
      if (!firstCell) throw new Error(`Could not parse table row in ${heading}: ${row}`);
      return { label: firstCell.replace(/^\*\*(.*?)\*\*$/, '$1'), row };
    });
}

const expectedBrands = [
  'AAM', 'abrdn (Aberdeen)', 'Amplify', 'ARK Invest', 'Capital Group', 'Fidelity',
  'First Trust', 'Franklin Templeton', 'Global X', 'Goldman Sachs', 'Invesco', 'iShares',
  'JPMorgan', 'NEOS', 'Northern Trust', 'Pacer ETFs', 'ProShares', 'Schwab', 'SPDR',
  'Sprott ETFs', 'Tema ETFs', 'Themes ETFs', 'VanEck', 'Vanguard', 'VictoryShares',
  'WisdomTree', 'Xtrackers',
];

const documentedControls = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD', 'HOLDINGS_PAGE_SIZE',
  'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'OUTPUT_DIR', 'EDGAR_FALLBACK', 'SKIP_YAHOO',
  'SEC_UA', 'VERBOSE',
  ...['YTD', '1Y', '3Y', '5Y', '10Y'].map(period => `PERFORMANCE_${period}`),
  ...['YTD', '1Y', '3Y', '5Y', '10Y'].map(period => `TOTAL_RETURN_${period}`),
];

test('README preserves the sibling heading order and common intro wording', () => {
  expect(headingsOutsideFences(readme)).toEqual([
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

  const siblingCommonIntro = "One of the app's features lets you select JPMorgan ETFs in the Watchlist and aggregate their holdings to see how often each ticker appears across the selected funds. Repeated holdings make overlapping exposure visible: the more selected funds include a ticker, the greater its potential influence on the portfolio; gains in that holding may help, while declines may hurt, and actual impact also depends on each fund's position size.  Another feature makes it faster and easier to find funds with stronger growth over different periods, higher dividend yields or distributions, greater Total Return (price performance plus dividends), and other key performance metrics.";
  const intro = readme.split(/\r?\n\r?\n/)[1];
  expect(intro.startsWith(siblingCommonIntro.replaceAll('JPMorgan', 'Tema'))).toBe(true);
  expect(intro).toContain('`./api/tema`');
  expect(intro).toContain('the same look, feel, columns and business logic as the sibling applications');
});

test('Brands and sibling-application tables are complete and alphabetized', () => {
  const brandRows = tableFirstColumn(readme, 'Brands table');
  const appRows = tableFirstColumn(readme, 'Sibling applications');
  expect(brandRows.map(row => row.label)).toEqual(expectedBrands);
  expect(appRows.map(row => row.label)).toEqual(expectedBrands);
  expect(brandRows.find(row => row.label === 'Tema ETFs')?.row).toContain('https://temaetfs.com/funds');
  expect(brandRows.find(row => row.label === 'Tema ETFs')?.row).toContain('https://daggerok.github.io/Tema/');
  expect(appRows.find(row => row.label === 'Tema ETFs')?.row).toContain('https://github.com/daggerok/Tema');
});

test('README documents the real Tema sources, SEC scope and dated-source limitations', () => {
  for (const value of [
    'https://temaetfs.com/funds',
    'dated `Download Holdings (CSV)` links',
    'the updater discovers the current link from the page',
    'Tema ETF Trust (CIK `0001944285`)',
    'holdings fallback only',
    'not official NAV total returns',
    '0001193125-26-323013',
    '2026-05-31',
    '2026-09-02',
    'deployment is pending',
  ]) {
    expect(readme).toContain(value);
  }
  const dataSources = readme.slice(readme.indexOf('### Data sources'), readme.indexOf('### Update controls'));
  expect(dataSources).not.toContain('api/jpmorgan');
  expect(dataSources).toContain('Yahoo Finance');
});

test('README covers every canonical updater control and its safety caveats', () => {
  const help = updaterHelpText();
  for (const name of documentedControls.filter(name => !name.startsWith('PERFORMANCE_') && !name.startsWith('TOTAL_RETURN_'))) {
    expect(readme).toContain(`\`${name}\``);
    expect(help).toContain(name);
  }
  expect(readme).toContain('`PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}`');
  expect(readme).toContain('`TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}`');
  expect(help).toContain('PERFORMANCE_{YTD,1Y,3Y,5Y,10Y}');
  expect(help).toContain('TOTAL_RETURN_{YTD,1Y,3Y,5Y,10Y}');
  for (const marker of [
    '| `MAX_FETCHES` | `0` |',
    '| `REQUEST_SLEEP` | `1` |',
    '| `CONCURRENCY` | `2` |',
    '| `MAX_RETRIES` | `2` |',
    '| `HOLDINGS_PAGE_SIZE` | `250` |',
    '| `HISTORY_PAGE_SIZE` | `1000` |',
    '| `HISTORY_RANGE` | `max` |',
    '| `OUTPUT_DIR` | `api/tema` |',
    '| `EDGAR_FALLBACK` | `true` |',
    '| `SKIP_YAHOO` | `false` |',
  ]) expect(readme).toContain(marker);
  expect(readme).toContain('real, monitored address');
  expect(readme).toContain('All supplied filters use **AND** logic');
  expect(readme).toContain('24 common controls as individual manual inputs plus one `advanced` input');
  expect(readme).toContain('file defaults < `advanced` JSON < nonblank workflow inputs < protected Actions variable or environment variable');
});

test('README commands and examples parse with updater defaults and live catalog tickers', () => {
  const config = readUpdaterConfig({
    MAX_FETCHES: '5',
    TICKERS: 'VOLT WELD PRVT',
    AUM: '1B:',
    TER: ':0.5',
    PERFORMANCE_1Y: '15:',
    HISTORY_RANGE: '10y',
  });
  const defaultConfig = readUpdaterConfig({});
  const index = JSON.parse(indexText) as { funds: Array<{ ticker: string }> };
  const catalog = new Set(index.funds.map(fund => fund.ticker));
  expect(config.maxFetches).toBe(5);
  expect(config.tickers).toEqual(['VOLT', 'WELD', 'PRVT']);
  expect(config.aumRange.min).toBe(1_000_000_000);
  expect(config.terRange.max).toBe(0.5);
  expect(config.performanceRanges['1Y'].min).toBe(15);
  expect(config.historyRange).toBe('10y');
  expect(defaultConfig.maxFetches).toBe(0);
  for (const ticker of config.tickers) expect(catalog.has(ticker)).toBe(true);
  for (const command of [
    'bun test',
    'bun scripts/update-data.ts',
    'bun scripts/update-data.ts -h',
    'MAX_FETCHES=5 bun scripts/update-data.ts',
    'TICKERS="VOLT WELD PRVT" bun scripts/update-data.ts',
    'AUM="1B:" TER=":0.5" bun scripts/update-data.ts',
    'PERFORMANCE_1Y="15:" HISTORY_RANGE=10y bun scripts/update-data.ts',
  ]) expect(readme).toContain(command);
});

test('scheduled/manual updater workflow resolves controls through the shared resolver and fails closed on bad scope', () => {
  const inputNames = [...workflow.matchAll(/^      ([a-z0-9_]+):$/gm)].map(match => match[1]);
  expect(inputNames).toHaveLength(25);
  expect(inputNames).toContain('advanced');
  expect(workflow).toContain("cron: '0 0 * * 0'");
  expect(workflow).toContain('uses: actions/checkout@v7');
  expect(workflow).toContain('uses: oven-sh/setup-bun@v2');
  expect(workflow).toContain('run: bun install --frozen-lockfile');
  expect(workflow).toContain('run: bun test');
  expect(workflow).toContain('run: bun ./scripts/update-data.ts');
  expect(workflow).toContain('git add api/tema');
  expect(workflow).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
  expect(workflow).toContain('resolveControls(file, advanced, individual, protectedVars)');
  expect(workflow).toContain('controls.OUTPUT_DIR = "api/tema"');
  expect(workflow).not.toMatch(/^\s{2}push:/m);
});
