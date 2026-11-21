import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarizeWithRtk, resetRtkCacheForTests } from '../build/rtk.js';

const environmentKeys = ['PATH', 'RTK_BIN', 'RTK_AUTO_INSTALL', 'RTK_INSTALL_DIR', 'RTK_SUMMARY_MIN_CHARS', 'RTK_SUMMARY_MIN_RATIO'];

async function withFakeRtk(script, callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hela-rtk-summary-'));
  const binary = path.join(directory, 'rtk');
  await fs.writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  process.env.RTK_BIN = binary;
  process.env.RTK_AUTO_INSTALL = 'false';
  delete process.env.RTK_SUMMARY_MIN_CHARS;
  delete process.env.RTK_SUMMARY_MIN_RATIO;
  resetRtkCacheForTests();
  try {
    return await callback({ directory, binary });
  } finally {
    for (const key of environmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetRtkCacheForTests();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('below the minimum size RTK is never invoked', async () => {
  const marker = path.join(os.tmpdir(), `hela-rtk-invoked-${Date.now()}`);
  await withFakeRtk(`touch '${marker}'\nprintf 'summary'`, async () => {
    const text = 'x'.repeat(500);
    const result = await summarizeWithRtk(text, 'stdout');
    assert.equal(result.summarized, false);
    assert.equal(result.content, text);
    await assert.rejects(fs.access(marker), 'RTK ran below the minimum size');
  });
});

test('a degenerate summary is rejected and the full output returned', async () => {
  await withFakeRtk(`printf 'Data code (120 lines)'`, async () => {
    const text = 'prose '.repeat(4000); // 24,000 chars
    const result = await summarizeWithRtk(text, 'stdout');
    assert.equal(result.summarized, false, '99%+ loss must not be reported as a summary');
    assert.equal(result.content, text);
  });
});

test('an accepted summary names the retained full output', async () => {
  await withFakeRtk(`printf '%s' "$(head -c 3000 /dev/zero | tr '\\0' 'S')"`, async () => {
    const text = 'line of output\n'.repeat(2000); // 30,000 chars -> 10% summary
    const result = await summarizeWithRtk(text, 'stdout');
    assert.equal(result.summarized, true);
    const match = result.content.match(/full output: (\/\S+\.txt)/);
    assert.ok(match, `summary does not name the source file: ${result.content.slice(0, 120)}`);
    const stat = await fs.stat(match[1]);
    assert.ok(stat.size >= text.length, 'retained file should hold the original text');
    await fs.rm(path.dirname(match[1]), { recursive: true, force: true });
  });
});

test('log mode matches only at line start, not mid-sentence', async () => {
  await withFakeRtk(`printf '%s' "$1" > "$MODE_FILE"\nprintf '%s' "$(head -c 3000 /dev/zero | tr '\\0' 'S')"`, async ({ directory }) => {
    const modeFile = path.join(directory, 'mode');
    process.env.MODE_FILE = modeFile;
    try {
      const text = 'This document mentions a warning about caching.\n'.repeat(700);
      const result = await summarizeWithRtk(text, 'stdout');
      assert.equal(result.summarized, true);
      const mode = await fs.readFile(modeFile, 'utf8');
      assert.equal(mode, 'smart', 'a mid-sentence "warning" must not switch the summarizer to log mode');
    } finally {
      delete process.env.MODE_FILE;
    }
  });
});
