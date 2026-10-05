import { describe, expect, it } from 'vitest';
import { normalizeShellCommand } from './shellCommand.js';

describe('normalizeShellCommand', () => {
  it('turns Windows (and old Mac) line ends into plain line breaks', () => {
    expect(normalizeShellCommand('echo "hello"\r\necho "world"\r\nexit 0\r\n')).toBe('echo "hello"\necho "world"\nexit 0\n');
    expect(normalizeShellCommand('a\rb\r\nc\nd')).toBe('a\nb\nc\nd');
  });

  it('leaves a command that has none as it is', () => {
    expect(normalizeShellCommand('test -f "$HOME/a b.tar.gz" || exit 1')).toBe('test -f "$HOME/a b.tar.gz" || exit 1');
    expect(normalizeShellCommand('echo one\necho two\n')).toBe('echo one\necho two\n');
    expect(normalizeShellCommand('')).toBe('');
  });
});
