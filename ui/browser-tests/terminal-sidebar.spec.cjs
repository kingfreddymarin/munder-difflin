const { expect, test } = require('@playwright/test');

const baseURL = process.env.TERMINAL_TEST_URL ?? 'http://127.0.0.1:4349/';
test.use({ viewport: { width: 1440, height: 900 } });

test('collapses, expands from the terminal keyboard and remembers the preference', async ({ page }) => {
  await page.goto(`${baseURL}#/terminal?a=cl`);
  const terminal = page.getByRole('main').getByRole('textbox', { name: 'Terminal input' });
  const panel = page.getByRole('complementary', { name: 'compute-lead context' });
  const collapse = page.getByRole('button', { name: 'Collapse terminal sidebar' });
  const expand = page.getByRole('button', { name: 'Expand terminal sidebar' });
  await expect(panel).toBeVisible();
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  const openWidth = (await terminal.boundingBox()).width;

  await collapse.click();
  await expect(panel).toBeHidden();
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  expect((await terminal.boundingBox()).width).toBeGreaterThan(openWidth + 300);

  await page.reload();
  await expect(expand).toBeVisible();
  await terminal.focus();
  await page.keyboard.press('Control+Shift+Period');
  await expect(panel).toBeVisible();
  await expect(terminal).toBeFocused();
  await expect(terminal).toBeEmpty();

  await page.keyboard.press('Meta+Shift+Period');
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(panel).toBeVisible();
  await page.reload();
  await expect(collapse).toBeVisible();
});

test('saves the selected agent profile in Terminal and reads it back after reload and in Team', async ({ page }) => {
  await page.goto(`${baseURL}#/terminal?a=cl`);
  const panel = page.getByRole('complementary', { name: / context$/ });
  const profileTab = panel.getByRole('tab', { name: 'Profile' });
  const displayName = panel.getByLabel('Display name');
  await profileTab.click();
  await expect(displayName).toHaveValue('compute-lead');
  await displayName.fill('Compute lead updated');
  await panel.getByRole('button', { name: /Save · logged/ }).click();
  await expect(page.getByRole('main').getByText('Compute lead updated', { exact: true })).toBeVisible();

  await page.reload();
  await profileTab.click();
  await expect(displayName).toHaveValue('Compute lead updated');
  await page.goto(`${baseURL}#/team?agent=cl&tab=profile`);
  await expect(page.getByRole('dialog').getByLabel('Display name')).toHaveValue('Compute lead updated');
});

test('renders without a duplicate list and opens and switches sessions from the main sidebar', async ({ page }) => {
  await page.goto(`${baseURL}#/terminal`);
  const main = page.getByRole('main');
  await expect(main.getByRole('button', { name: 'Collapse terminal sidebar' })).toBeVisible();
  await expect(main.getByRole('navigation', { name: 'Sessions' })).toHaveCount(0);
  await expect(main.getByText('Live sessions', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: /compute-lead/ }).click();
  await expect(page).toHaveURL(/#\/terminal\?a=cl$/);
  await expect(main.getByText('Read packaging/macos/sign.sh', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /pipeline-worker/ }).click();
  await expect(page).toHaveURL(/#\/terminal\?a=pw$/);
  await expect(main.getByText('Read pipelines/def-435.yml', { exact: false })).toBeVisible();
  await main.getByRole('tab', { name: 'Profile' }).click();
  await expect(main.getByLabel('Display name')).toHaveValue('pipeline-worker');

  await page.getByRole('button', { name: /dms-lead/ }).click();
  await expect(main.getByText(/dms-lead has no live terminal/)).toBeVisible();
  await expect(main.getByLabel('Display name')).toHaveValue('dms-lead');
});
