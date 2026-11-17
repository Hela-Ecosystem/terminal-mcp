import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { 
  CommandExecutor, 
  SecurityError, 
  ValidationError,
  isPathWithin
} from '../build/executor.js';

test('CommandExecutor: local echo command execution', async () => {
  const executor = new CommandExecutor();
  const res = await executor.executeCommand('echo "test-hello-world"');
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.includes('test-hello-world'));
  await executor.disconnect();
});

test('CommandExecutor: non-zero exit code capture', async () => {
  const executor = new CommandExecutor();
  const res = await executor.executeCommand('sh -c "exit 42"');
  assert.equal(res.exitCode, 42);
  await executor.disconnect();
});

test('CommandExecutor: timeout handling returns exitCode 124', async () => {
  const executor = new CommandExecutor();
  const res = await executor.executeCommand('sleep 2', { timeout: 300 });
  assert.equal(res.exitCode, 124);
  assert.ok(res.stderr.includes('timed out'));
  await executor.disconnect();
});

test('CommandExecutor: large output (>1MB) does not crash exec maxBuffer', async () => {
  const executor = new CommandExecutor();
  // 1.5MB stdout
  const res = await executor.executeCommand('node -e "process.stdout.write(\'A\'.repeat(1500000))"');
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout.length >= 1500000);
  await executor.disconnect();
});

test('CommandExecutor: standalone cd and pwd session persistence', async () => {
  const executor = new CommandExecutor();
  const sessionName = 'cd-test-session';

  const cdRes = await executor.executeCommand('cd /tmp', { session: sessionName });
  assert.equal(cdRes.exitCode, 0);
  assert.equal(cdRes.workingDirectory, '/tmp');

  const pwdRes = await executor.executeCommand('pwd', { session: sessionName });
  assert.equal(pwdRes.exitCode, 0);
  assert.equal(pwdRes.stdout.trim(), '/tmp');
  assert.equal(pwdRes.workingDirectory, '/tmp');

  await executor.disconnect();
});

test('CommandExecutor: validation errors on empty or invalid inputs', () => {
  const executor = new CommandExecutor();
  assert.throws(() => executor.validateCommand(''), ValidationError);
  assert.throws(() => executor.validateSessionName(''), ValidationError);
  assert.throws(() => executor.validateSessionName('invalid name with spaces!'), ValidationError);
});

test('CommandExecutor: dangerous command blocking', () => {
  const executor = new CommandExecutor();

  // Root rm
  assert.throws(() => executor.validateCommand('rm -rf /'), SecurityError);
  assert.throws(() => executor.validateCommand('rm -rf /*'), SecurityError);
  assert.throws(() => executor.validateCommand('rm -rf / --no-preserve-root'), SecurityError);
  assert.throws(() => executor.validateCommand('rm -rf ~'), SecurityError);
  assert.throws(() => executor.validateCommand('rm -rf ~/'), SecurityError);
  assert.throws(() => executor.validateCommand('chmod 777 /'), SecurityError);
  assert.throws(() => executor.validateCommand('chmod -R 777 /'), SecurityError);
  assert.throws(() => executor.validateCommand('chown -R root /'), SecurityError);

  // Safe commands that must NOT be blocked
  assert.doesNotThrow(() => executor.validateCommand('rm -rf /tmp/my-safe-dir'));
  assert.doesNotThrow(() => executor.validateCommand('rm /tmp/foo.txt'));
  assert.doesNotThrow(() => executor.validateCommand('chmod 777 /tmp/script.sh'));
  assert.doesNotThrow(() => executor.validateCommand('chown azzar /home/azzar/test'));
});

test('CommandExecutor: path traversal detection vs safe double-dot filenames', async () => {
  const executor = new CommandExecutor();
  const tmpDir = os.tmpdir();
  const srcFile = path.join(tmpDir, `test-dot..file-${Date.now()}.txt`);
  const dstFile = path.join(tmpDir, `test-dot..file-copy-${Date.now()}.txt`);

  fs.writeFileSync(srcFile, 'hello double dot');

  try {
    // Path with .. as segment must be rejected
    await assert.rejects(
      async () => executor.copyFileLocal({ source: '../etc/passwd', destination: dstFile }),
      SecurityError
    );

    // Filename containing .. substring must succeed
    const copyRes = await executor.copyFileLocal({ source: srcFile, destination: dstFile });
    assert.equal(copyRes.success, true);
    assert.equal(fs.readFileSync(dstFile, 'utf8'), 'hello double dot');
  } finally {
    try { fs.unlinkSync(srcFile); } catch (_err) { /* ignore cleanup error */ }
    try { fs.unlinkSync(dstFile); } catch (_err) { /* ignore cleanup error */ }
    await executor.disconnect();
  }
});

test('CommandExecutor: listSessions and closeSession lifecycle management', async () => {
  const executor = new CommandExecutor();
  const sessionName = `session-life-${Date.now()}`;

  // Initially 0 sessions
  let list = await executor.listSessions();
  assert.equal(list.summary.totalSessions, 0);
  assert.equal(list.availableSlots, list.maxConcurrentSessions);

  // Create session by executing command
  await executor.executeCommand('echo "session init"', { session: sessionName });

  list = await executor.listSessions();
  assert.equal(list.summary.totalSessions, 1);
  assert.equal(list.summary.localSessions, 1);
  assert.equal(list.availableSlots, list.maxConcurrentSessions - 1);
  assert.ok(list.sessions.local.some((s) => s.sessionKey === `local-${sessionName}`));

  // Close session by name
  const closeRes = await executor.closeSession({ session: sessionName });
  assert.equal(closeRes.success, true);

  list = await executor.listSessions();
  assert.equal(list.summary.totalSessions, 0);
  assert.equal(list.availableSlots, list.maxConcurrentSessions);

  // Closing non-existent session returns success: false without throwing
  const falseClose = await executor.closeSession({ session: 'non-existent' });
  assert.equal(falseClose.success, false);

  // Close all sessions
  await executor.executeCommand('echo "s1"', { session: 's1' });
  await executor.executeCommand('echo "s2"', { session: 's2' });
  list = await executor.listSessions();
  assert.equal(list.summary.totalSessions, 2);

  const closeAllRes = await executor.closeSession({ session: 'all' });
  assert.equal(closeAllRes.success, true);
  list = await executor.listSessions();
  assert.equal(list.summary.totalSessions, 0);

  await executor.disconnect();
});

test('security: path boundary comparison rejects sibling prefixes', () => {
  assert.equal(isPathWithin('/srv/app', '/srv/app'), true, 'exact match');
  assert.equal(isPathWithin('/srv/app', '/srv/app/'), true, 'trailing separator on root');
  assert.equal(isPathWithin('/srv/app/sub', '/srv/app'), true, 'descendant');
  assert.equal(isPathWithin('/srv/application', '/srv/app'), false, 'sibling sharing a prefix');
  assert.equal(isPathWithin('/srv/app-other', '/srv/app'), false, 'sibling with dash suffix');
  assert.equal(isPathWithin('/srv/app/../application', '/srv/app'), false, 'dot-dot escape');
  assert.equal(isPathWithin('/etc', '/srv/app'), false, 'unrelated path');
});

test('security: validateWorkingDirectory blocks prefix siblings on real paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hela-allowed-'));
  const sibling = `${root}-sibling`;
  fs.mkdirSync(sibling);
  fs.mkdirSync(path.join(root, 'child'));
  const executor = new CommandExecutor({ allowedWorkingDirectories: [root] });
  await assert.doesNotReject(() => executor.validateWorkingDirectory(root));
  await assert.doesNotReject(() => executor.validateWorkingDirectory(path.join(root, 'child')));
  await assert.rejects(
    () => executor.validateWorkingDirectory(sibling),
    (error) => error instanceof SecurityError,
    'a sibling directory that shares the string prefix must be refused'
  );
  await assert.rejects(
    () => executor.validateWorkingDirectory(path.join(root, '..', path.basename(sibling))),
    (error) => error instanceof SecurityError,
    'traversal out of the allowed root must be refused'
  );
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
});
