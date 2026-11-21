// Run the UI in browser mock mode. Install Playwright/Chromium outside this repo if needed.
// PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-team-graph-browser.mjs [base-url] [screenshot-dir]
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:48235/';
const screenshots = process.argv[3];
if (screenshots) await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE,
  args: process.env.CHROMIUM_SINGLE_PROCESS ? ['--single-process', '--no-zygote', '--disable-gpu'] : [],
});
const teamUrl = new URL('#/team', baseUrl).href;

async function drag(page, node, dx, dy, finish = true) {
  const { x, y, width, height } = await node.boundingBox();
  const centre = { x: x + width / 2, y: y + height / 2 };
  const scale = await node.evaluate((element) => element.getScreenCTM().a);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + dx * scale, centre.y + dy * scale, { steps: 12 });
  if (finish) await page.mouse.up();
}

async function assertLayout(graph) {
  const collisions = await graph.evaluate((svg) => {
    const nodes = [...svg.querySelectorAll('[data-graph-node]')].map((el) => ({ id: el.dataset.graphNode, ...el.querySelector('rect').getBoundingClientRect().toJSON() }));
    return nodes.flatMap((a, i) => nodes.slice(i + 1).filter((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top).map((b) => [a.id, b.id]));
  });
  assert.deepEqual(collisions, []);
}

async function assertTiles(page) {
  const boxes = await page.locator('[id^="team-panel-"]').evaluateAll((tiles) => tiles.map((t) => ({ id: t.id, ...t.getBoundingClientRect().toJSON() })));
  assert.equal(boxes.length, 5);
  for (const [i, a] of boxes.entries()) {
    assert.ok(a.height > 0 && a.width > 0, `${a.id} must be visible`);
    for (const b of boxes.slice(i + 1)) {
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${a.id} and ${b.id} overlap`);
    }
  }
}

try {
  const page = await browser.newPage({ colorScheme: 'dark', hasTouch: true });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const viewport of [{ width: 1200, height: 886 }, { width: 1680, height: 1050 }]) {
    await page.setViewportSize(viewport);
    await page.goto(teamUrl);
    const graph = page.getByRole('group', { name: 'Team graph' });
    const agents = graph.locator('[data-graph-node^="agent:"]');
    const agent = agents.first();
    const automation = graph.locator('[data-graph-node^="automation:"]').first();
    const tasks = graph.locator('[data-task-node]');
    const jump = page.getByRole('button', { name: 'Tasks', exact: true });
    const top = page.getByRole('button', { name: 'Top', exact: true });
    const reset = page.getByRole('button', { name: 'Reset layout' });
    await agent.waitFor();
    await assertTiles(page);
    await assertLayout(graph);
    if (screenshots) await page.screenshot({ path: join(screenshots, `team-${viewport.width}.png`) });
    const before = await agent.getAttribute('transform');
    const autoBefore = await automation.getAttribute('transform');
    const edgesBefore = await graph.locator('[data-edge]').evaluateAll((edges) => edges.map((e) => [e.getAttribute('x1'), e.getAttribute('y1'), e.getAttribute('x2'), e.getAttribute('y2')]));
    await drag(page, agent, -65, 0);
    const after = await agent.getAttribute('transform');
    assert.notEqual(after, before, 'pointer moves the agent');
    assert.match(page.url(), /#\/team$/, 'drag leaves the Team route open');
    assert.notDeepEqual(await graph.locator('[data-edge]').evaluateAll((edges) => edges.map((e) => [e.getAttribute('x1'), e.getAttribute('y1'), e.getAttribute('x2'), e.getAttribute('y2')])), edgesBefore, 'connected edges follow the node');
    await drag(page, agent, 0, 18, false);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await agent.getAttribute('transform'), after, 'Escape cancels the preview');
    await automation.press('ArrowRight');
    const autoAfter = await automation.getAttribute('transform');
    assert.notEqual(autoAfter, autoBefore, 'keyboard moves the automation');
    await jump.click();
    const task = graph.locator('[data-task-node]:focus');
    assert.equal(await task.count(), 1, 'jump focuses a task');
    const taskKey = await task.getAttribute('data-task-node');
    const selectedTask = graph.getByRole('button', { name: new RegExp(`^Card ${taskKey}:`) });
    const taskBefore = await selectedTask.getAttribute('transform');
    await drag(page, selectedTask, 0, 8);
    const taskAfter = await selectedTask.getAttribute('transform');
    assert.notEqual(taskAfter, taskBefore, 'pointer moves a task card');
    assert.match(page.url(), /#\/team$/);
    await assertLayout(graph);
    for (const node of await tasks.all()) {
      await node.scrollIntoViewIfNeeded();
      assert.ok(await node.evaluate((el) => {
        const r = el.querySelector('rect').getBoundingClientRect();
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-task-node]') === el;
      }), `task ${await node.getAttribute('data-task-node')} can be reached by pointer`);
    }
    await jump.click();
    if (screenshots) await page.screenshot({ path: join(screenshots, `tasks-${viewport.width}.png`) });
    await page.reload();
    assert.equal(await agent.getAttribute('transform'), after);
    assert.equal(await automation.getAttribute('transform'), autoAfter);
    assert.equal(await selectedTask.getAttribute('transform'), taskAfter);
    await reset.click();
    assert.equal(await agent.getAttribute('transform'), before);
    assert.equal(await automation.getAttribute('transform'), autoBefore);
    assert.equal(await selectedTask.getAttribute('transform'), taskBefore);
    await page.reload();
    assert.equal(await agent.getAttribute('transform'), before);
    const scroll = page.locator('[data-graph-scroll]');
    await jump.click();
    assert.ok(await scroll.evaluate((el) => el.scrollTop) > 0, 'Tasks scrolls inside the graph');
    await top.click();
    assert.equal(await scroll.evaluate((el) => el.scrollTop), 0);
    await agent.press('Shift+F10');
    await page.getByRole('menu', { name: /^Actions for / }).waitFor();
    await page.getByRole('menuitem', { name: 'Rename' }).press('Escape');
    await agent.click();
    await page.waitForURL((url) => url.hash.startsWith('#/terminal?') && new URLSearchParams(url.hash.split('?')[1]).has('a'));
    await page.goto(teamUrl);
    for (const activation of ['click', 'Enter', 'Space']) {
      await jump.click();
      const card = graph.locator('[data-task-node]:focus');
      const key = await card.getAttribute('data-task-node');
      if (activation === 'click') await card.click();
      else await card.press(activation);
      await page.waitForURL((url) => url.hash.startsWith('#/board?') && new URLSearchParams(url.hash.split('?')[1]).get('card') === key);
      await page.getByRole('dialog').waitFor();
      await page.goto(teamUrl);
    }
    const touch = await page.context().newCDPSession(page);
    await top.click();
    const target = await agent.boundingBox();
    const x = target.x + target.width / 2;
    const y = target.y + target.height / 2;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const dx of [7, 12, 18, 24, 36]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - dx, y }] });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.notEqual(await agent.getAttribute('transform'), before, 'touch moves the agent');
    assert.match(page.url(), /#\/team$/);
    await assertLayout(graph);
    await reset.click();
    await touch.detach();
    console.log(`${viewport.width}×${viewport.height}: mouse and touch drag, Escape, keyboard, connections, reload, reset, opening and five-tile hit testing passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
