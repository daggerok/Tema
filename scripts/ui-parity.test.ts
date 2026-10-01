/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const [app, indexHtml] = await Promise.all([
  readFile(new URL('../app.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
]);

function frequencyFormatter(source: string): (value: unknown) => string {
  const signature = 'function formatDividendFrequency(value: unknown): string {';
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}\n\nfunction formatInteger', start);
  if (start < 0 || end < 0) throw new Error('formatDividendFrequency source was not found');
  const body = source.slice(start + signature.length, end);
  return new Function('value', body) as (value: unknown) => string;
}

function sourceBlock(source: string, startText: string, endText: string): string {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  if (start < 0 || end < 0) throw new Error(`Could not locate UI source block: ${startText}`);
  return source.slice(start, end);
}

test('Tema UI frequency display maps unavailable and dash values to None', () => {
  const format = frequencyFormatter(app);
  for (const value of [null, undefined, '', '   ', '-', '—', '–', '‐', '‑', '‒']) {
    expect(format(value)).toBe('00 - None');
  }
  expect(format('None')).toBe('00 - None');
});

test('Tema UI frequency display preserves Unknown and the sibling mappings', () => {
  const format = frequencyFormatter(app);
  expect(format('Unknown')).toBe('00 - Unknown');
  expect(format('unknown')).toBe('00 - Unknown');
  expect(format('Monthly')).toBe('01 - Monthly');
  expect(format('Quarterly')).toBe('04 - Quarterly');
  expect(format('Semi-annually')).toBe('06 - Semi-annually');
  expect(format('Annually')).toBe('12 - Annually');
  expect(format('Irregular')).toBe('99 - Irregular');
  expect(format('Provider-specific cadence')).toBe('Provider-specific cadence');
});

test('Tema app uses only its own static API and browser-storage prefixes', () => {
  expect(app).toContain("const INDEX_URL = './api/tema/index.json';");
  expect(app).not.toMatch(/api\/jpmorgan|jpmorgan-/i);
  expect(indexHtml).toContain('localStorage.getItem(\'tema-theme\')');
  expect(indexHtml).not.toMatch(/api\/jpmorgan|jpmorgan-/i);
  for (const key of [
    'tema-theme',
    'tema-selected-etfs',
    'tema-blacklisted-etfs',
    'tema-active-fund',
    'tema-tab-filters',
    'tema-searches',
    'tema-tab-sorts',
    'tema-site-state',
  ]) {
    expect(app).toContain(`'${key}'`);
  }
});

test('visible selection summary is empty or sorted clickable N-selected links', () => {
  const summary = sourceBlock(app, 'function renderHeaderSummary(', '\nfunction renderSubtitleDetails');
  expect(summary).toContain('panel.replaceChildren(...Array.from(subtitle.childNodes))');
  expect(summary).toContain('subtitle.replaceChildren()');
  expect(summary).toContain('const selected = [...tickers].sort();');
  expect(summary).toContain('if (!selected.length) return;');
  expect(summary).toContain('`${selected.length} selected: `');
  expect(summary).toContain("ticker === activeTicker ? 'text-blue-700 dark:text-blue-300 underline'");
  expect(summary).toContain('event.preventDefault(); activate(ticker);');
  expect(summary).not.toContain('All ${');
  expect(summary).not.toContain('state.selected.delete');
});

test('rich source panel keeps API/provider links and SEC trust attribution', () => {
  expect(indexHtml).toMatch(/<span id="app-summary"[^>]*hidden>/);
  expect(indexHtml).toContain('aria-controls="app-summary"');
  for (const source of [
    './api/tema/index.json',
    'https://temaetfs.com/funds',
    'Tema ETF Trust, CIK 0001944285',
    'holdings fallback only',
    'Yahoo Finance',
  ]) {
    expect(indexHtml).toContain(source);
    expect(app).toContain(source);
  }
  expect(indexHtml).toContain('<title>Tema ETFs</title>');
});

test('catalog header supports hover, keyboard, touch pinning, Escape and narrow viewports', () => {
  const behavior = sourceBlock(indexHtml, '<script id="catalog-summary-behavior">', '</script>');
  expect(behavior).toContain("event.pointerType !== 'touch'");
  expect(behavior).toContain("trigger.addEventListener('pointerenter'");
  expect(behavior).toContain("panel.addEventListener('pointerenter'");
  expect(behavior).toContain("trigger.addEventListener('focus'");
  expect(behavior).toContain("event.key !== 'Escape'");
  expect(behavior).toContain("trigger.addEventListener('click', () => { pinned = !pinned;");
  expect(behavior).toContain("document.addEventListener('pointerdown'");
  expect(behavior).toContain('innerWidth - panel.offsetWidth - 16');
  expect(behavior).toContain('innerHeight - panel.offsetHeight - 16');
  expect(behavior).toContain("addEventListener('resize'");
  expect(behavior).toContain('new ResizeObserver');
});
