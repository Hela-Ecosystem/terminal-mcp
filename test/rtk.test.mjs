import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getManagedRtkPath, getRtkBinary, resetRtkCacheForTests } from '../build/rtk.js';

const environmentKeys = ['PATH', 'RTK_BIN', 'RTK_AUTO_INSTALL', 'RTK_INSTALL_DIR'];

async function withRtkEnvironment(values, callback) {
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  resetRtkCacheForTests();
  try {
    return await callback();
  } finally {
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetRtkCacheForTests();
  }
}

test('managed RTK path is user-local and supports an explicit directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hela-rtk-path-'));
  try {
    await withRtkEnvironment({ RTK_INSTALL_DIR: directory }, async () => {
      assert.equal(getManagedRtkPath(), path.join(directory, process.platform === 'win32' ? 'rtk.exe' : 'rtk'));
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('missing RTK keeps raw-command fallback when auto-install is disabled', async () => {
  await withRtkEnvironment({ PATH: '/usr/bin:/bin', RTK_BIN: '/definitely-missing/rtk', RTK_AUTO_INSTALL: 'false' }, async () => {
    assert.equal(await getRtkBinary(), null);
  });
});

test('an explicitly configured RTK executable is preferred', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hela-rtk-bin-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'rtk.cmd' : 'rtk');
  try {
    const contents = process.platform === 'win32' ? '@echo off\r\necho rtk test\r\n' : '#!/bin/sh\nprintf "rtk test\\n"\n';
    await fs.writeFile(executable, contents, { mode: 0o700 });
    await withRtkEnvironment({ PATH: '/usr/bin:/bin', RTK_BIN: executable, RTK_AUTO_INSTALL: 'false' }, async () => {
      assert.equal(await getRtkBinary(), executable);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
