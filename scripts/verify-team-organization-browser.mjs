// Run against the Paramount renderer with Playwright installed outside this repo if needed.
// PLAYWRIGHT_MODULE=playwright node scripts/verify-team-organization-browser.mjs [base-url] [screenshot-dir]
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const loadTs = require('../test/load-ts.cjs');
const { dispatchParamount } = loadTs('src/main/paramount.ts');
const { readOrg } = loadTs('src/main/paramount-org.ts');
const { runHiveTeamCommand } = loadTs('src/main/hive-team-command.ts');
const root = await mkdtemp(join(tmpdir(), 'paramount-team-browser-'));
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:49248/';
const screenshots = process.argv[3];
const teamUrl = new URL('#/team', baseUrl).href;
const agents = {
  god: { name: 'Morgan', role: 'orchestrator', provider: 'claude' },
  lead: { name: 'Jules', role: 'lead', provider: 'codex' },
  worker: { name: 'Riley', role: 'worker', provider: 'codex' },
  reviewer: { name: 'Sam', role: 'worker', provider: 'claude' },
};
const commands = [];
const deps = {
  agents: () => agents, tasks: () => ({ tasks: [] }), team: { hiveRoot: () => root },
  appendEvent() {}, publish() {},
};
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: process.env.CHROMIUM_SINGLE_PROCESS ? ['--single-process', '--no-zygote', '--disable-gpu'] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('teamSnapshot', () => ({
    registry: { godId: 'god', agents }, ptys: [], messages: [], tasks: { tasks: [] },
    organization: readOrg(root, Object.keys(agents))
  }));
  await page.exposeFunction('teamDispatch', (command) => {
    commands.push(command);
    return dispatchParamount(command, deps);
  });
  await page.addInitScript(() => {
    window.paramount = {
      paramountSnapshot: window.teamSnapshot,
      paramountDispatch: window.teamDispatch,
      onParamountEvent: () => () => {},
    };
  });
  await page.goto(teamUrl);
  const graph = page.getByRole('group', { name: 'Team graph' });
  await graph.getByRole('button', { name: /^Jules,/ }).waitFor();

  const staleOrganization = readOrg(root, Object.keys(agents));
  const existing = runHiveTeamCommand(root, agents, { action: 'create', name: 'Release', objective: 'Ship a verified build', leadId: 'lead', memberIds: ['worker'] });
  runHiveTeamCommand(root, agents, { action: 'assign', teamId: existing.id, agentId: 'reviewer', parentId: 'worker' });
  const staleSave = dispatchParamount({ type: 'team.org.save', organization: staleOrganization, expected: staleOrganization }, deps);
  assert.equal(staleSave.code, 'CONFLICT');
  const release = graph.getByRole('button', { name: 'Team Release: Ship a verified build' });
  await release.waitFor();
  await release.press('Enter');
  let hud = page.getByRole('dialog', { name: 'Release' });
  await hud.getByText('Ship a verified build', { exact: true }).waitFor();
  await hud.getByText('Jules → Riley').waitFor();
  await hud.getByText('Riley → Sam').waitFor();
  assert.equal(await graph.locator('[data-edge="team-root"]').count(), 1);
  assert.equal(await graph.locator('[data-edge="team-member"]').count(), 2);
  assert.equal(page.url(), teamUrl);
  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, 'team-chain.png') });
  }
  await page.keyboard.press('Escape');
  await hud.waitFor({ state: 'hidden' });

  const openForm = async () => {
    await page.getByRole('button', { name: 'New team', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New team' });
    await form.getByLabel('Team name').waitFor();
    return form;
  };
  let form = await openForm();
  const submit = form.getByRole('button', { name: 'Create team', exact: true });
  assert.equal(await submit.isDisabled(), true);
  await form.getByLabel('Team name').fill(' release ');
  await form.getByLabel('Objective').fill('Validate the release notes');
  await form.getByLabel('Team lead').selectOption('god');
  await form.getByRole('checkbox', { name: 'Sam' }).check();
  await submit.click();
  await form.getByRole('alert').getByText(/already exists/).waitFor();
  assert.equal(await form.getByRole('checkbox', { name: 'Sam' }).isChecked(), true);
  await form.getByLabel('Team name').fill('Documentation');
  if (screenshots) await page.screenshot({ path: join(screenshots, 'new-team.png') });
  await submit.click();
  await form.waitFor({ state: 'hidden' });
  const expected = { type: 'team.org.create', name: 'Documentation', objective: 'Validate the release notes', leadId: 'god', memberIds: ['reviewer'] };
  assert.deepEqual(commands.filter((command) => command.type === 'team.org.create').at(-1), expected);
  const created = graph.getByRole('button', { name: 'Team Documentation: Validate the release notes' });
  await created.waitFor();
  await created.click();
  hud = page.getByRole('dialog', { name: 'Documentation' });
  await hud.getByText('Morgan → Sam').waitFor();
  await page.reload();
  await created.waitFor();
  await release.waitFor();
  assert.deepEqual(errors, []);
  console.log('Team creation, validation recovery, objective, nested work chain, live refresh, stale edit protection, HUD, and reload passed.');
} finally {
  await browser?.close();
  await rm(root, { recursive: true, force: true });
}
