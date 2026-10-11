import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stand-in for the `claude` or `codex` program: a Node script that logs how it was
 * called (arguments, stdin, working directory) to `FAKE_CLI_LOG` and prints the next reply the
 * `FAKE_CLI_REPLY` file holds for its first two arguments (`auth status`) or for `*`, with the exit code from `FAKE_CLI_EXIT`. On Windows it
 * comes with a `.cmd` wrapper, the way npm installs CLIs there.
 */
export function fakeCli(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, `${name}-fake.cjs`);
  writeFileSync(
    script,
    `const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ args, stdin, cwd: process.cwd() }) + '\\n');
  const file = process.env.FAKE_CLI_REPLY;
  const replies = file ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  const own = args.slice(0, 2).join(' ');
  const key = replies[own]?.length ? own : '*';
  const reply = (replies[key] ?? []).shift();
  if (file) fs.writeFileSync(file, JSON.stringify(replies));
  if (reply?.stdout) process.stdout.write(reply.stdout);
  if (reply?.stderr) process.stderr.write(reply.stderr);
  process.exitCode = reply?.exit ?? 0;
});
`
  );
  if (process.platform === 'win32') {
    const cmd = join(dir, `${name}.cmd`);
    writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "%~dp0${name}-fake.cjs" %*\r\n`);
    return cmd;
  }
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export interface FakeReply {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

/** Sets what the fake prints, in order: per first two arguments, or `*` for any. */
export function setReplies(file: string, replies: Record<string, FakeReply[]>): void {
  writeFileSync(file, JSON.stringify(replies));
}
