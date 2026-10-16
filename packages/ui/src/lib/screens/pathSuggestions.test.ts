import { describe, expect, it } from 'vitest';
import { ancestors, baseName, pathSuggestions, rememberPath, separatorOf } from './pathSuggestions';

describe('ancestors', () => {
  it('a server path: every folder above, outermost first', () => {
    expect(ancestors('/var/www/app')).toEqual(['/', '/var', '/var/www']);
    expect(ancestors('/')).toEqual([]);
  });

  it('a Windows path: from the drive down', () => {
    expect(ancestors('C:\\Users\\lukas\\Downloads')).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\lukas']);
    expect(separatorOf('C:\\Users')).toBe('\\');
    expect(separatorOf('/home/me')).toBe('/');
  });
});

describe('rememberPath and baseName', () => {
  it('keeps the newest first, once, up to a limit', () => {
    expect(rememberPath(['/a', '/b'], '/b')).toEqual(['/b', '/a']);
    expect(rememberPath(['/a', '/b'], '/c', 2)).toEqual(['/c', '/a']);
    expect(baseName('C:\\Users\\lukas')).toBe('lukas');
  });
});

describe('pathSuggestions', () => {
  const input = {
    path: '/var/www',
    typed: '/var/www',
    subfolders: ['/var/www/app', '/var/www/logs'],
    recent: ['/var/www', '/etc/nginx'],
    shortcuts: [{ name: 'Projects', path: '/srv/projects' }]
  };

  it('with the bar untouched: favorites, the folders in it, the ones above, recent ones', () => {
    expect(pathSuggestions(input).map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([
      ['Favorites', ['Projects']],
      ['In this folder', ['app', 'logs']],
      ['Up', ['/var', '/']],
      ['Recent', ['/etc/nginx']]
    ]);
  });

  it('filters by what is typed, by path or name, any case', () => {
    expect(pathSuggestions({ ...input, typed: 'LOG' }).map((g) => [g.title, g.items.map((i) => i.path)])).toEqual([
      ['In this folder', ['/var/www/logs']]
    ]);
    expect(pathSuggestions({ ...input, typed: 'proj' })[0].items[0].path).toBe('/srv/projects');
  });
});
