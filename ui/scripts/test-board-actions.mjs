// Run with the UI dev server and Playwright installed:
// BOARD_TEST_URL=http://127.0.0.1:4179 PLAYWRIGHT_MODULE=playwright node ui/scripts/test-board-actions.mjs
// Set CHROMIUM_EXECUTABLE for an existing Chrome installation. CHROMIUM_SINGLE_PROCESS=1 enables local single-process Chromium.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const { dispatchParamount } = require('../../test/load-ts.cjs')('src/main/paramount.ts');
const url = process.env.BOARD_TEST_URL ?? 'http://127.0.0.1:4179';
const key = 'NSC-231';
async function fixture(t, { rejectUpdate = false } = {}) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: process.env.CHROMIUM_SINGLE_PROCESS === '1' ? ['--single-process'] : [],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const task = { id: key, title: 'Original title', status: 'doing', createdAt: '2026-11-21T10:00:00.000Z' };
  const commands = [];
  const deps = {
    board: {}, canMutateBoard: () => true, tasks: () => ({ tasks: [task] }), agents: () => ({}),
    patchTask: (id, patch) => {
      assert.equal(id, key);
      if (rejectUpdate) return false;
      Object.assign(task, patch);
      return true;
    },
    appendEvent() {}, publish() {},
  };
  await page.exposeFunction('testSnapshot', () => ({ registry: { agents: {} }, tasks: { tasks: [task] }, ptys: [], messages: [] }));
  await page.exposeFunction('testDispatch', (command) => {
    commands.push(command);
    return dispatchParamount(command, deps);
  });
  await page.exposeFunction('testMove', (id, patch) => {
    commands.push({ type: 'card.move', key: id, ...patch });
    Object.assign(task, patch);
    return { ok: true };
  });
  await page.addInitScript(() => {
    window.paramount = {
      paramountSnapshot: window.testSnapshot,
      paramountDispatch: window.testDispatch,
      hivePatchTask: window.testMove,
      onParamountEvent: () => () => {},
    };
  });
  const card = page.locator(`[role="button"][draggable]`).filter({ hasText: key });
  await page.goto(`${url}/#/board`);
  await card.waitFor();
  return { page, card, commands, task, menuItem: (name) => page.getByRole('menuitem', { name }) };
}

const focused = (locator) => locator.evaluate((element) => element === document.activeElement);

async function expectTabSequence(page, key, controls) {
  for (const control of controls) {
    await page.keyboard.press(key);
    if (await focused(control)) continue;
    const active = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
      text: document.activeElement?.closest('button')?.textContent?.trim(),
    }));
    assert.fail(`${key} expected ${control}, focused ${JSON.stringify(active)}`);
  }
}

test('Shift+F10, arrow keys and Escape move and restore focus', async (t) => {
  const { page, card, menuItem } = await fixture(t);
  await card.press('Shift+F10');
  assert.equal(await focused(menuItem('Rename…')), true);
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(menuItem('Edit fields…')), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await focused(menuItem('Rename…')), true);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  await card.evaluate((element) => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await focused(card), true);
});

test('Rename cycles Tab and Shift+Tab within the form and restores card focus on Escape', async (t) => {
  const { page, card } = await fixture(t);
  await card.press('Shift+F10');
  await page.keyboard.press('Enter');
  const group = page.getByRole('group', { name: `Rename ${key}` });
  const title = group.getByLabel('New title');
  const save = group.getByRole('button', { name: 'Save', exact: true });
  const cancel = group.getByRole('button', { name: 'Cancel' });
  assert.equal(await focused(title), true);
  await title.fill('Edited title');
  await expectTabSequence(page, 'Tab', [save, cancel, title, save]);
  await expectTabSequence(page, 'Shift+Tab', [title, cancel, save, title]);

  await title.fill('Original title');
  assert.equal(await save.isDisabled(), true);
  await expectTabSequence(page, 'Tab', [cancel, title]);
  await expectTabSequence(page, 'Shift+Tab', [cancel, title]);
  await page.keyboard.press('Escape');
  await group.waitFor({ state: 'hidden' });
  await card.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await focused(card), true);
});

test('Edit fields cycles Tab and Shift+Tab within the dialog and restores card focus on Escape', async (t) => {
  const { page, card } = await fixture(t);
  await card.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: `Edit ${key}` });
  const title = dialog.getByLabel('Title', { exact: true });
  const description = dialog.getByLabel('Description');
  const assignee = dialog.getByLabel('Assignee');
  const priority = dialog.getByRole('radio', { name: 'P1' });
  const cancel = dialog.getByRole('button', { name: 'Cancel' });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  const close = dialog.getByRole('button', { name: 'Close' });
  assert.equal(await focused(title), true);
  await title.fill('Edited title');
  await expectTabSequence(page, 'Tab', [description, assignee, priority, cancel, save, close, title]);
  await expectTabSequence(page, 'Shift+Tab', [close, save, cancel, priority, assignee, description, title]);

  await title.fill('Original title');
  assert.equal(await save.isDisabled(), true);
  await expectTabSequence(page, 'Shift+Tab', [close, cancel]);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await card.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await focused(card), true);
});

test('Rename and Edit fields keep the form on a failed desktop save and restore focus on Escape', async (t) => {
  const { page, card, menuItem, task } = await fixture(t, { rejectUpdate: true });
  await card.click({ button: 'right' });
  await menuItem('Rename…').click();
  const title = page.getByLabel('New title');
  assert.equal(await focused(title), true);
  await title.fill('Rejected title');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Could not save. Try again.', { exact: true }).waitFor();
  assert.equal(await title.inputValue(), 'Rejected title');
  assert.equal(task.title, 'Original title');
  await page.keyboard.press('Escape');
  await title.waitFor({ state: 'hidden' });
  await card.evaluate((element) => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await focused(card), true);

  await card.click({ button: 'right' });
  await menuItem('Edit fields…').click();
  const dialog = page.getByRole('dialog', { name: `Edit ${key}` });
  await dialog.getByLabel('Description').fill('Rejected description');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.getByText('Could not save. Try again.', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('Description').inputValue(), 'Rejected description');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await card.evaluate((element) => new Promise((resolve) => requestAnimationFrame(resolve)));
  assert.equal(await focused(card), true);
});

test('a description-only edit preserves a concurrent rename and missing priority', async (t) => {
  const { page, card, menuItem, task, commands } = await fixture(t);
  await card.click({ button: 'right' });
  await menuItem('Edit fields…').click();
  const dialog = page.getByRole('dialog', { name: `Edit ${key}` });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  const couldSaveUnchanged = await save.isEnabled();
  task.title = 'Concurrent title';
  await dialog.getByLabel('Description').fill('A new description');
  await save.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(commands, [{ type: 'card.update', key, patch: { description: 'A new description' } }]);
  assert.equal(couldSaveUnchanged, false);
  assert.equal(task.priority, undefined);
  assert.equal(task.title, 'Concurrent title');
  await page.reload();
  await card.getByText('Concurrent title', { exact: true }).waitFor();
});

test('Archive hides the card across reload without setting Done', async (t) => {
  const { page, card, menuItem, task, commands } = await fixture(t);
  await card.click({ button: 'right' });
  await menuItem('Archive').click();
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.deepEqual(commands, [{ type: 'card.archive', key }]);
  await card.waitFor({ state: 'hidden' });
  assert.equal(task.status, 'doing');
  assert.ok(task.boardArchivedAt);
  await page.reload();
  await page.getByRole('button', { name: 'New card' }).waitFor();
  assert.equal(await card.count(), 0);
});
