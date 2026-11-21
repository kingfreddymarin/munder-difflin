// PLAYWRIGHT_MODULE=playwright node scripts/verify-small-ui-browser.mjs <base-url> <output> [before]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const [base, directory, phase = 'after'] = process.argv.slice(2);
const before = phase === 'before';
const browser = await chromium.launch({ args: process.env.CHROMIUM_SINGLE_PROCESS ? ['--single-process', '--no-zygote', '--disable-gpu'] : [] });
try {
  if (directory) await mkdir(directory, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  page.setDefaultTimeout(10000);
  const calls = [];
  const cwd = '/fixture/worktree';
  const context = { floorLabel: 'Fixture floor', orchestratorId: 'lead', orchestratorName: 'Taylor', capturedAt: '2026-11-21T10:00:00Z', boardSummary: '', cards: [], roster: [], decisions: [] };
  const homeIds = ['objectives', 'asks', 'activity', 'closed', 'wins'];
  const snapshot = {
    registry: { godId: 'lead', agents: { lead: { name: 'Taylor', cwd, provider: 'claude' } } },
    floorSetup: { complete: true, harnessHome: '/fixture/floor', floorLock: { state: 'open', floor: '/fixture/floor' }, engines: [] },
    ptys: [{ id: 'terminal', agentId: 'lead', cwd }],
    messages: [], tasks: { tasks: [{ id: 'NSC-242', title: 'Path card', status: 'doing', assignee: 'lead', dir: cwd }] },
    config: {}, activity: {}, log: [],
    preferences: {
      home: { density: 'spacious', tiles: Object.fromEntries(homeIds.map((id) => [id, { size: 'lg' }])) },
      objectives: { version: 1, items: Array.from({ length: 50 }, (_, index) => ({ id: `objective-${index}`, title: `Fixture objective ${index}`, why: 'Exercise a crowded Home panel', owner: 'lead', cardKeys: [], health: 'on-track' })) },
    },
  };
  await page.exposeFunction('smallSnapshot', () => snapshot);
  await page.exposeFunction('smallDispatch', (command) => {
    calls.push(command);
    const event = { id: String(calls.length), at: '2026-11-21T10:00:00Z', actor: 'you', command };
    if (command.type === 'terminal.artifacts') return { ok: true, event, artifacts: { agentId: 'lead', cwd, repo: null, artifacts: [{ kind: 'changed', label: 'build.txt', path: `${cwd}/build.txt`, dir: cwd }], warnings: [] } };
    return { ok: true, event };
  });
  await page.addInitScript(({ context, cwd }) => {
    window.paramount = {
      paramountSnapshot: window.smallSnapshot, paramountDispatch: window.smallDispatch, onParamountEvent: () => () => {},
      sideAgentState: async () => ({ status: 'running', ptyId: 'side', provider: 'opencode', context, cwd: '/fixture/side/workspace' }),
      onSideAgentChanged: () => () => {}, onPtyData: () => () => {}, onPtyExit: () => () => {},
    };
  }, { context, cwd });

  async function capture(label) {
    if (directory) await page.screenshot({ path: join(directory, `${phase}-${label}.png`) });
  }
  async function checkPath(route, heading, app, expected, label, scope = page) {
    await page.goto(new URL(route, base).href);
    await heading.waitFor();
    if (!before) {
      const menu = scope.getByRole('button', { name: /^Open with/ }).first();
      await menu.click();
      await capture(label);
      await page.getByRole('menuitem', { name: app, exact: true }).click();
      assert.deepEqual(calls.at(-1), expected);
    } else await capture(label);
  }
  await checkPath('#/terminal?a=lead', page.getByRole('button', { name: /terminal sidebar/i }), 'VS Code', { type: 'shell.openIn', app: 'vscode', path: cwd }, 'terminal');
  if (!before) {
    await page.getByRole('tab', { name: 'Artifacts' }).click();
    const file = page.getByRole('listitem').filter({ hasText: 'build.txt' });
    await file.getByRole('button', { name: /^Open with/ }).click();
    await page.getByRole('menuitem', { name: 'VS Code', exact: true }).click();
    assert.deepEqual(calls.at(-1), { type: 'shell.openIn', app: 'vscode', path: `${cwd}/build.txt` });
  }
  await checkPath('#/team?agent=lead&tab=profile', page.getByLabel('Display name'), 'Warp', { type: 'shell.openIn', app: 'warp', path: cwd }, 'team', page.getByRole('dialog'));
  await checkPath('#/board?card=NSC-242', page.getByRole('dialog').getByText('Path card', { exact: true }), 'VS Code', { type: 'card.open', key: 'NSC-242', app: 'vscode' }, 'board', page.getByRole('dialog'));
  await checkPath('#/side-agent', page.getByRole('button', { name: 'Stop', exact: true }), 'Warp', { type: 'shell.openIn', app: 'warp', path: '/fixture/side/workspace' }, 'side-agent');
  await checkPath('#/settings?tab=team', page.getByTestId('floor-location-path'), 'VS Code', { type: 'shell.openIn', app: 'vscode', path: '/fixture/floor' }, 'settings');

  await page.goto(new URL('#/home', base).href);
  await page.getByText('Fixture objective 0', { exact: true }).waitFor();
  await capture('home');
  const geometry = await page.locator('main').last().evaluate((main) => ({
    viewport: main.clientHeight, content: main.scrollHeight,
    tiles: [...main.querySelectorAll('section')].map((tile) => ({
      title: tile.querySelector('h2')?.textContent,
      bottom: tile.getBoundingClientRect().bottom,
    })).filter((tile) => tile.title)
  }));
  console.log(phase, geometry);
  if (!before) {
    assert.equal(geometry.tiles.length, 5);
    assert.ok(geometry.tiles.every((tile) => tile.bottom <= 900), JSON.stringify(geometry));
    assert.ok(geometry.content <= geometry.viewport + 1, JSON.stringify(geometry));
    const objectives = page.getByRole('region', { name: 'Main objectives' });
    await objectives.focus();
    await objectives.press('End');
    await page.waitForFunction(() => document.activeElement?.scrollTop > 0);
    assert.equal(await page.locator('main').last().evaluate((el) => el.scrollTop), 0);
    await page.setViewportSize({ width: 780, height: 680 });
    const mobile = await objectives.boundingBox();
    assert.ok(mobile.height < 680);
  }
} finally {
  await browser.close();
}
