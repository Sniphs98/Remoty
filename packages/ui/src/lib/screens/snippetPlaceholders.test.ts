import { describe, expect, it } from 'vitest';
import {
  commandForFile,
  commandInFolder,
  fillFilePlaceholder,
  snippetsForTarget,
  usesFilePlaceholder,
  FILE_PLACEHOLDER
} from './snippetPlaceholders';

describe('fillFilePlaceholder', () => {
  it('substitutes the path, shell-quoted', () => {
    expect(fillFilePlaceholder('unzip {{file}}', '/srv/app.zip')).toBe("unzip '/srv/app.zip'");
  });

  it('replaces every occurrence, not just the first', () => {
    expect(fillFilePlaceholder('cp {{file}} {{file}}.bak', '/srv/a')).toBe("cp '/srv/a' '/srv/a'.bak");
  });

  it('quotes a path with spaces so it stays one argument', () => {
    expect(fillFilePlaceholder('cat {{file}}', '/srv/my file.txt')).toBe("cat '/srv/my file.txt'");
  });

  it("escapes an embedded single quote rather than ending the argument early", () => {
    expect(fillFilePlaceholder('cat {{file}}', "/srv/it's.txt")).toBe("cat '/srv/it'\\''s.txt'");
  });

  it('leaves a command that never mentions the placeholder alone', () => {
    expect(fillFilePlaceholder('docker ps', '/srv/a')).toBe('docker ps');
  });
});

describe('usesFilePlaceholder', () => {
  it('is true only when the placeholder is present', () => {
    expect(usesFilePlaceholder(`tar -xf ${FILE_PLACEHOLDER}`)).toBe(true);
    expect(usesFilePlaceholder('tar -xf archive.tar')).toBe(false);
  });
});

describe('commandInFolder', () => {
  it('runs the command in the folder being browsed, quoted', () => {
    expect(commandInFolder('docker system prune -f', '/srv/my app')).toBe("cd '/srv/my app' && docker system prune -f");
  });

  it('runs it as it is without a folder', () => {
    expect(commandInFolder('uptime', '')).toBe('uptime');
  });
});

describe('snippetsForTarget', () => {
  const snippets = [
    { name: 'unzip', command: 'unzip {{file}}' },
    { name: 'prune', command: 'docker system prune -f' },
    { name: 'tail', command: 'tail -f {{file}}' },
    { name: 'pull', command: 'git pull' }
  ];

  it('offers only {{file}} snippets for a right-clicked entry', () => {
    expect(snippetsForTarget(snippets, 'entry').map((s) => s.name)).toEqual(['unzip', 'tail']);
  });

  it('offers only file-less snippets for empty space', () => {
    expect(snippetsForTarget(snippets, 'folder').map((s) => s.name)).toEqual(['prune', 'pull']);
  });

  it('goes by the snippet type when one is set', () => {
    const typed = [
      { name: 'less', command: 'less', type: 'file' as const },
      { name: 'uptime', command: 'uptime', type: 'general' as const }
    ];
    expect(snippetsForTarget(typed, 'entry').map((s) => s.name)).toEqual(['less']);
    expect(snippetsForTarget(typed, 'folder').map((s) => s.name)).toEqual(['uptime']);
  });
});

describe('commandForFile', () => {
  it('fills {{file}}', () => {
    expect(commandForFile('unzip {{file}} -d out', '/srv/a.zip')).toBe("unzip '/srv/a.zip' -d out");
  });

  it('appends the path to a command without {{file}}', () => {
    expect(commandForFile('tail -f', '/var/log/my app.log')).toBe("tail -f '/var/log/my app.log'");
  });
});
