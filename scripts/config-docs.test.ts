/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readUpdaterConfig, resolveControls, runtimeControls, updaterHelpText } from './update-data.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = JSON.parse(read('scripts/update-data.config.json'));

test('precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'VOLT' }, { CONCURRENCY: 3, TICKERS: 'WELD' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
  expect(c.CONCURRENCY).toBe('5');
  expect(c.TICKERS).toBe('WELD');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'VOLT' }, {}, { TICKERS: '' }).TICKERS).toBe('VOLT');
  expect(resolveControls({ TICKERS: 'VOLT' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
  expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { TEMA_LIMIT: '7' }).MAX_FETCHES).toBe('7');
  expect(resolveControls({ CATEGORY: '' }, {}, {}, { ASSET_CLASS: 'Equity' }).CATEGORY).toBe('Equity');
});

test('scheduled path (empty inputs and advanced) equals config defaults', () => {
  expect(resolveControls(file, {}, {})).toEqual(Object.fromEntries(Object.entries(file).map(([k, v]) => [k, String(v)])));
  const config = readUpdaterConfig(resolveControls(file));
  expect(config.maxFetches).toBe(0);
  expect(config.requestSleepSeconds).toBe(1);
  expect(config.concurrency).toBe(2);
  expect(config.maxRetries).toBe(2);
  expect(config.holdingsPageSize).toBe(250);
  expect(config.historyPageSize).toBe(1000);
  expect(config.historyRange).toBe('max');
  expect(config.outputDir.endsWith('api/tema')).toBe(true);
  expect(config.edgarFallback).toBe(true);
  expect(config.skipYahoo).toBe(false);
  expect(config.tickers).toEqual([]);
  expect(config.secUserAgent).not.toMatch(/@/);
});

test('resolver rejects unknown keys, non-scalars, newlines and invalid values', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { AUM: '1:2:3' }, { TER: '2:1' }, { HISTORY_RANGE: '10d' }, { TICKERS: ['VOLT'] }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, [] as unknown)).toThrow();
  expect(() => JSON.parse('{bad')).toThrow();
});

test('runtimeControls reads the tracked config file and env overrides win', async () => {
  const controls = await runtimeControls({ TICKERS: 'VOLT', REQUEST_SLEEP: '0' });
  expect(controls.TICKERS).toBe('VOLT');
  expect(controls.REQUEST_SLEEP).toBe('0');
  expect(controls.HISTORY_PAGE_SIZE).toBe('1000');
});

test('config keys == CONTROL_NAMES == --help == README rows', () => {
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  for (const value of Object.values(file)) expect(typeof value).toBe('string');
  const doc = read('README.md');
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

test('workflow inputs map to controls, stay within 25, and never write outside api/tema', () => {
  const wf = read('.github/workflows/update-data.yml');
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
  expect(wf).toContain('controls.OUTPUT_DIR = "api/tema"');
  expect(wf).toContain('git add api/tema\n');
  expect(wf).not.toMatch(/git add (?!api\/tema\b)/);
  expect(wf).toContain('PROTECTED_SEC_UA: ${{ vars.SEC_UA }}');
});
