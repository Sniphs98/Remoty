import { describe, expect, it } from 'vitest';
import { toHex } from './monacoTheme';

describe('toHex', () => {
  it('turns the token formats app.css uses into what Monaco accepts', () => {
    expect(toHex(' #1B212B ')).toBe('#1b212b');
    expect(toHex('#fff')).toBe('#ffffff');
    expect(toHex('rgba(255, 255, 255, 0.15)')).toBe('#ffffff26');
    expect(toHex('rgb(27 33 43)')).toBe('#1b212b');
    expect(toHex('var(--x)')).toBeUndefined();
  });
});
