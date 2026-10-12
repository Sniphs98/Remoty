import { describe, expect, it } from 'vitest';

import { leakedCalls } from './openai';

describe('leakedCalls', () => {
  it('takes propose_command arguments out of the text', () => {
    const text = 'Erst schauen:\n```json\n{"command":"echo \\"}{\\"","explanation":"x","risk":"safe"}\n```\nDann weiter.';
    expect(leakedCalls(text)).toEqual({ text: 'Erst schauen:\n\nDann weiter.', inputs: [{ command: 'echo "}{"', explanation: 'x', risk: 'safe' }] });
  });

  it('finds several and leaves other JSON alone', () => {
    const text = '{"command":"a","explanation":"","risk":"safe"} {"command":"b","explanation":"","risk":"caution"} {"other":1}';
    const out = leakedCalls(text);
    expect(out.inputs.map((i) => i.command)).toEqual(['a', 'b']);
    expect(out.text).toBe('{"other":1}');
  });

  it('keeps text without commands as it is', () => {
    expect(leakedCalls('Use {"command": 5} or { broken')).toEqual({ text: 'Use {"command": 5} or { broken', inputs: [] });
  });
});
