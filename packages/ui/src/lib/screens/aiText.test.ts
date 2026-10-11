import { describe, expect, it } from 'vitest';
import { aiTextParts, lineCount, relativeDay } from './aiText';

describe('aiTextParts', () => {
  it('splits code blocks and inline code from text', () => {
    expect(aiTextParts('Run `nginx -t` first:\n```bash\nsudo nginx -t\n```\nThen **look**.')).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'nginx -t' },
      { kind: 'text', text: ' first:\n' },
      { kind: 'block', text: 'sudo nginx -t' },
      { kind: 'text', text: 'Then look.' }
    ]);
  });

  it('keeps markup-looking text as text', () => {
    expect(aiTextParts('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});

describe('lineCount', () => {
  it('counts lines', () => {
    expect(lineCount('a\nb')).toBe('2 lines');
    expect(lineCount('a')).toBe('1 line');
    expect(lineCount(undefined)).toBe('0 lines');
  });
});

describe('relativeDay', () => {
  it('says yesterday for the day before', () => {
    const now = new Date(2026, 9, 11, 12).getTime();
    expect(relativeDay(new Date(2026, 9, 10, 9).getTime(), now)).toBe('yesterday');
    expect(relativeDay(now, now)).toMatch(/^today, /);
  });
});
