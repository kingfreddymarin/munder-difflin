'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');
const { hirePresetFromAgent, saveExistingAgentPreset } = loadTs('ui/src/features/team/agent-preset.ts');
const { validateHireManifest } = loadTs('src/shared/hire.ts');
const { saveParamountHirePreset } = loadTs('src/main/paramountHirePreset.ts');

const agent = { name: 'Review Worker', provider: 'claude', model: 'claude-sonnet-4-6', accent: 'violet', tokenCapMillions: 1.5 };

test('existing-agent export contains only portable fields accepted by the hire importer', () => {
  const preset = hirePresetFromAgent(agent);
  assert.deepEqual(preset, { spec: 'munder-difflin/hire@1', name: 'Review Worker', provider: 'claude',
    model: 'claude-sonnet-4-6', accent: 'violet', tokenCap: 1_500_000 });
  assert.equal(validateHireManifest(preset).ok, true);
  assert.throws(() => hirePresetFromAgent({ ...agent, provider: 'custom-binary' }), /cannot be saved/);
});

test('existing-agent UI save callback receives the selected agent definition', async () => {
  let seen;
  const result = await saveExistingAgentPreset(agent, async (preset) => {
    seen = preset;
    return { canceled: false, path: '/fixture/review-worker.json' };
  });
  assert.deepEqual(seen, hirePresetFromAgent(agent));
  assert.deepEqual(result, { canceled: false, path: '/fixture/review-worker.json' });
});

test('save handler reports dialog cancellation and does not write', async () => {
  let writes = 0;
  const result = await saveParamountHirePreset(hirePresetFromAgent(agent), {
    validate: validateHireManifest,
    showSaveDialog: async () => ({ canceled: true }),
    writeFile: async () => { writes++; },
  });
  assert.deepEqual(result, { canceled: true });
  assert.equal(writes, 0);
});

test('save handler writes a portable file that round-trips through the importer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paramount-agent-preset-'));
  try {
    const path = join(dir, 'review-worker.json');
    const result = await saveParamountHirePreset(hirePresetFromAgent(agent), {
      validate: validateHireManifest,
      showSaveDialog: async (defaultName) => {
        assert.equal(defaultName, 'Review-Worker.json');
        return { canceled: false, filePath: path };
      },
      writeFile: async (file, text) => {
        const fs = require('node:fs/promises');
        await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
      },
    });
    assert.deepEqual(result, { canceled: false, path });
    const imported = validateHireManifest(JSON.parse(await readFile(path, 'utf8')));
    assert.equal(imported.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(imported.manifest)), hirePresetFromAgent(agent));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('save handler returns safe errors for picker and file failures without leaking the path', async () => {
  const picker = await saveParamountHirePreset(hirePresetFromAgent(agent), {
    validate: validateHireManifest,
    showSaveDialog: async () => { throw new Error('/private/user/path'); },
    writeFile: async () => assert.fail('must not write after picker failure'),
  });
  assert.deepEqual(picker, { canceled: false, error: 'Could not open the save dialog. Try again.' });

  const failedWrite = await saveParamountHirePreset(hirePresetFromAgent(agent), {
    validate: validateHireManifest,
    showSaveDialog: async () => ({ canceled: false, filePath: '/private/user/path/secret.json' }),
    writeFile: async () => { throw new Error('/private/user/path'); },
  });
  assert.deepEqual(failedWrite, { canceled: false,
    error: 'Could not save the agent preset. Choose another file name or location and try again.' });
  assert.equal(JSON.stringify(failedWrite).includes('/private/user/path'), false);
});

test('invalid definitions stop before showing the picker', async () => {
  let opened = false;
  const result = await saveParamountHirePreset({ spec: 'wrong', name: 'bad' }, {
    validate: validateHireManifest,
    showSaveDialog: async () => { opened = true; return { canceled: true }; },
    writeFile: async () => assert.fail('invalid definitions must not write'),
  });
  assert.equal(result.canceled, false);
  assert.match(result.error, /unsupported spec/);
  assert.equal(opened, false);
});
