import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeCli } from '../../testSupport/fakeCli';
import { answerCalls, answerText, childEnv, findExecutable, quoteForCmd, runProcess } from './cliProcess';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'remoty-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('findExecutable', () => {
  it('finds a program on PATH', () => {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'claude'), '');
    expect(findExecutable('claude', undefined, { PATH: join(dir, 'bin'), HOME: dir }, 'linux')).toBe(join(dir, 'bin', 'claude'));
  });

  it('looks in the usual install directories too', () => {
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true });
    writeFileSync(join(dir, '.local', 'bin', 'claude'), '');
    expect(findExecutable('claude', undefined, { PATH: '', HOME: dir }, 'linux')).toBe(join(dir, '.local', 'bin', 'claude'));
  });

  it('uses the configured path, and only that', () => {
    writeFileSync(join(dir, 'my-claude'), '');
    expect(findExecutable('claude', join(dir, 'my-claude'), { PATH: '' }, 'linux')).toBe(join(dir, 'my-claude'));
    expect(findExecutable('claude', join(dir, 'missing'), { PATH: '' }, 'linux')).toBeUndefined();
  });

  it('is undefined when the program is nowhere', () => {
    expect(findExecutable('codex', undefined, { PATH: dir, HOME: dir }, 'linux')).toBeUndefined();
  });
});

describe('childEnv', () => {
  it('adds the program\'s directory to PATH', () => {
    expect(childEnv('/opt/homebrew/bin/claude', { PATH: '/usr/bin' }, 'linux').PATH).toBe('/usr/bin:/opt/homebrew/bin');
    expect(childEnv('/usr/bin/claude', { PATH: '/usr/bin' }, 'linux').PATH).toBe('/usr/bin');
  });
});

describe('quoteForCmd', () => {
  it('quotes what cmd.exe would split or expand', () => {
    expect(quoteForCmd('')).toBe('""');
    expect(quoteForCmd('-p')).toBe('-p');
    expect(quoteForCmd('{"a":1}')).toBe('"{""a"":1}"');
  });
});

describe('answerCalls / answerText', () => {
  it('reads the structured answer', () => {
    const answer = { text: 'Look:', commands: [{ command: 'df -h', explanation: 'disk', risk: 'safe' }] };
    expect(answerText(answer)).toBe('Look:');
    const calls = answerCalls(answer);
    expect(calls).toEqual([{ callId: expect.stringMatching(/^cli-/), input: answer.commands[0] }]);
    expect(answerCalls({ text: 'x' })).toEqual([]);
    expect(answerText(undefined)).toBe('');
  });
});

describe('runProcess', () => {
  it('passes arguments and stdin through unchanged', async () => {
    const bin = fakeCli(dir, 'tool');
    const log = join(dir, 'log.jsonl');
    const args = ['-p', '', '{"mcpServers":{}}', 'two words', 'a&b|c'];
    await runProcess(bin, args, { stdin: 'hello\nworld', cwd: dir, env: { ...process.env, FAKE_CLI_LOG: log } });
    const call = JSON.parse(readFileSync(log, 'utf-8').trim());
    expect(call.args).toEqual(args);
    expect(call.stdin).toBe('hello\nworld');
  });

  it('stops the program when the signal aborts', async () => {
    const bin = join(dir, 'slow.cjs');
    writeFileSync(bin, 'setTimeout(() => {}, 60000);');
    const controller = new AbortController();
    const done = runProcess(process.execPath, [bin], { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(done).rejects.toThrow('stopped');
  });
});
