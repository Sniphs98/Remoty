import { describe, expect, it } from 'vitest';
import {
  commandInFolder,
  fillFilePlaceholder,
  snippetSections,
  snippetCategories,
  sftpMenuGroups,
  sftpMenuProblem,
  SFTP_MENU_CATEGORY,
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

  it('leaves out snippets with any other placeholder, which the browser cannot fill', () => {
    const withParams = [
      { name: 'copy', command: 'scp {{file}} {{params.target}}' },
      { name: 'deploy', command: 'deploy {{params.env}}' },
      { name: 'after', command: 'echo {{nodes.build.output}}' }
    ];
    expect(snippetsForTarget(withParams, 'entry')).toEqual([]);
    expect(snippetsForTarget(withParams, 'folder')).toEqual([]);
  });
});

describe('snippetSections', () => {
  it('one section per category: the SFTP menu first, the others by name, uncategorized last', () => {
    const snippets = [
      { name: 'df', command: 'df -h' },
      { name: 'deploy', command: 'deploy {{params.env}}', category: 'Deploy' },
      { name: 'unzip', command: 'unzip {{file}}', category: SFTP_MENU_CATEGORY },
      { name: 'logs', command: 'docker logs app', category: 'Docker' }
    ];
    expect(snippetSections(snippets).map((s) => [s.title, s.snippets.map((x) => x.name)])).toEqual([
      ['SFTP menu', ['unzip']],
      ['Deploy', ['deploy']],
      ['Docker', ['logs']],
      ['Uncategorized', ['df']]
    ]);
    expect(snippetCategories([{ category: 'Docker' }, {}])).toEqual(['SFTP menu', 'Docker']);
  });
});

describe('sftpMenuGroups', () => {
  const snippets = [
    { name: 'tail', command: 'tail -n 100 {{file}}', category: SFTP_MENU_CATEGORY, submenu: 'Logs' },
    { name: 'unzip', command: 'unzip {{file}}', category: SFTP_MENU_CATEGORY },
    { name: 'cat', command: 'cat {{file}}', category: SFTP_MENU_CATEGORY, submenu: 'Logs' },
    { name: 'prune', command: 'docker system prune -f', category: SFTP_MENU_CATEGORY, submenu: 'Docker' },
    { name: 'deploy', command: 'deploy {{file}} {{params.env}}', category: SFTP_MENU_CATEGORY },
    { name: 'less', command: 'less {{file}}', category: 'Tools' }
  ];

  it('only the SFTP menu category, fitting what was clicked, grouped by submenu and sorted', () => {
    expect(sftpMenuGroups(snippets, 'entry').map((g) => [g.title, g.snippets.map((s) => s.name)])).toEqual([
      ['Logs', ['cat', 'tail']],
      ['Snippets', ['unzip']]
    ]);
    expect(sftpMenuGroups(snippets, 'folder').map((g) => [g.title, g.snippets.map((s) => s.name)])).toEqual([['Docker', ['prune']]]);
  });

  it('says why a snippet in the SFTP menu would not show there', () => {
    expect(sftpMenuProblem('deploy {{file}} {{params.env}}')).toContain('{{params.env}}');
    expect(sftpMenuProblem('unzip {{file}}')).toBeUndefined();
  });
});
