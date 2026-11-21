import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const layoutSrc = readFileSync(new URL('../src/pages/terminal-panel-layout.ts', import.meta.url), 'utf8');
const terminalSrc = readFileSync(new URL('../src/pages/terminal.tsx', import.meta.url), 'utf8');
const sideSrc = readFileSync(new URL('../src/components/app/terminal/session-side.tsx', import.meta.url), 'utf8');

const PANEL_IDS = ['asks', 'talk', 'artifacts', 'updates', 'profile'];

// --- terminal-panel-layout.ts ---

test('layout exports TERMINAL_SIDE_PANEL_IDS covering all five panels', () => {
  for (const id of PANEL_IDS) {
    assert.ok(layoutSrc.includes(`'${id}'`), `TERMINAL_SIDE_PANEL_IDS missing: ${id}`);
  }
});

test('layout exports TERMINAL_SIDE_PANEL_KEY as a localStorage key string', () => {
  assert.match(layoutSrc, /TERMINAL_SIDE_PANEL_KEY\s*=\s*['"]paramount\./);
});

test('layout exports persistTerminalPanels that calls setItem', () => {
  assert.match(layoutSrc, /persistTerminalPanels/);
  assert.match(layoutSrc, /storage\.setItem/);
});

test('layout exports loadTerminalPanels that falls back to default on empty/invalid', () => {
  assert.match(layoutSrc, /loadTerminalPanels/);
  assert.match(layoutSrc, /TERMINAL_SIDE_PANEL_DEFAULT/);
  assert.match(layoutSrc, /return valid\.length \? valid : TERMINAL_SIDE_PANEL_DEFAULT/);
});

// --- terminal.tsx ---

test('terminal.tsx imports loadTerminalPanels and persistTerminalPanels', () => {
  assert.match(terminalSrc, /import.*loadTerminalPanels.*persistTerminalPanels.*from/);
});

test('terminal.tsx initialises sidePanels state from loadTerminalPanels', () => {
  assert.match(terminalSrc, /useState.*loadTerminalPanels/);
});

test('terminal.tsx toggleSidePanel calls persistTerminalPanels', () => {
  assert.match(terminalSrc, /toggleSidePanel/);
  assert.match(terminalSrc, /persistTerminalPanels/);
});

test('terminal.tsx preserves canonical panel order when re-enabling a panel', () => {
  assert.match(terminalSrc, /TERMINAL_SIDE_PANEL_IDS\.filter/);
});

test('terminal.tsx renders a Customize popover with a Switch per panel', () => {
  assert.match(terminalSrc, /<Switch/);
  assert.match(terminalSrc, /toggleSidePanel\(id,/);
});

test('terminal.tsx passes visibleTabs={sidePanels} to SessionSide', () => {
  assert.match(terminalSrc, /visibleTabs=\{sidePanels\}/);
});

// --- session-side.tsx ---

test('SessionSide accepts visibleTabs prop', () => {
  assert.match(sideSrc, /visibleTabs\?:\s*Tab\[\]/);
});

test('SessionSide falls back to ALL_TABS when visibleTabs is not provided', () => {
  assert.match(sideSrc, /visibleTabs\s*\?\?\s*ALL_TABS/);
});

test('SessionSide ALL_TABS constant covers all five panels', () => {
  for (const id of PANEL_IDS) {
    assert.ok(sideSrc.includes(`'${id}'`), `ALL_TABS missing: ${id}`);
  }
});

test('SessionSide redirects tab to first visible when current tab is hidden', () => {
  assert.match(sideSrc, /shownTabs\.includes\(tab\)/);
  assert.match(sideSrc, /setTab\(shownTabs\[0\]/);
});

test('SessionSide conditionally renders each TabsTrigger based on shownTabs', () => {
  for (const id of PANEL_IDS) {
    assert.ok(sideSrc.includes(`shownTabs.includes('${id}')`), `conditional render missing for tab: ${id}`);
  }
});
