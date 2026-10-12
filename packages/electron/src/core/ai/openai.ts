import { randomUUID } from 'node:crypto';

import OpenAI from 'openai';
import type { FunctionTool, ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses';

import type { AiBackend, ProposedCall, TurnRequest, TurnResult } from './backend.js';
import { answeredBy, foreignAssistantText, foreignResultsText, isNative, outcomeText, userText } from './history.js';
import { PROPOSE_COMMAND, PROPOSE_COMMAND_DESCRIPTION, PROPOSE_COMMAND_SCHEMA } from './prompt.js';

/**
 * OpenAI models through the Responses API, streamed and stateless (`store: false`): the
 * whole problem goes with every request, earlier output items as they came back —
 * reasoning included, encrypted — so nothing about the problem is kept at OpenAI.
 */

const TOOL: FunctionTool = {
  type: 'function',
  name: PROPOSE_COMMAND,
  description: PROPOSE_COMMAND_DESCRIPTION,
  parameters: PROPOSE_COMMAND_SCHEMA as unknown as Record<string, unknown>,
  strict: true
};

/** Output items as the API takes them back as input: unchanged in substance, minus the
 *  parsed fields the SDK adds to what it returns. A reasoning item stays followed by the
 *  item it led to, as the API expects. */
function replayable(items: ResponseOutputItem[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const item of items) {
    if (item.type === 'reasoning') {
      out.push({ type: 'reasoning', id: item.id, summary: item.summary, encrypted_content: item.encrypted_content ?? null });
    } else if (item.type === 'function_call') {
      out.push({ type: 'function_call', ...(item.id ? { id: item.id } : {}), call_id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === 'message') {
      out.push({
        type: 'message',
        id: item.id,
        role: 'assistant',
        status: 'completed',
        content: item.content.map((c) =>
          c.type === 'output_text' ? { type: 'output_text' as const, text: c.text, annotations: [] } : { type: 'refusal' as const, refusal: c.refusal }
        )
      });
    }
  }
  return out;
}

/** The end of the JSON object that starts at `start` (a `{`), or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Commands the model wrote into its text as `propose_command` arguments instead of
 * calling the tool — GPT models through ChatGPT's endpoint sometimes do. Returns the
 * text without them (and without a code fence left empty around one) and their inputs.
 */
export function leakedCalls(text: string): { text: string; inputs: Record<string, unknown>[] } {
  const inputs: Record<string, unknown>[] = [];
  let rest = '';
  let i = 0;
  for (const match of text.matchAll(/\{\s*"command"\s*:/g)) {
    if (match.index < i) continue;
    const end = objectEnd(text, match.index);
    if (end < 0) break;
    let input: unknown;
    try {
      input = JSON.parse(text.slice(match.index, end));
    } catch {
      continue;
    }
    if (typeof (input as { command?: unknown }).command !== 'string') continue;
    inputs.push(input as Record<string, unknown>);
    rest += text.slice(i, match.index);
    i = end;
  }
  if (inputs.length === 0) return { text, inputs };
  rest += text.slice(i);
  return { text: rest.replace(/```[a-z]*\s*```/g, '').replace(/\n{3,}/g, '\n\n').trim(), inputs };
}

/** Moves commands leaked into message text (`leakedCalls`) into function calls of
 *  their own, so they become cards and their results have a call to answer. */
function recoverLeakedCalls(output: ResponseOutputItem[]): ResponseOutputItem[] {
  if (output.some((item) => item.type === 'function_call')) return output;
  const recovered: ResponseOutputItem[] = [];
  const calls: ResponseOutputItem[] = [];
  for (const item of output) {
    if (item.type !== 'message') {
      recovered.push(item);
      continue;
    }
    const content = item.content.map((c) => {
      if (c.type !== 'output_text') return c;
      const leaked = leakedCalls(c.text);
      for (const input of leaked.inputs) {
        calls.push({
          type: 'function_call',
          call_id: `call_${randomUUID().replace(/-/g, '')}`,
          name: PROPOSE_COMMAND,
          arguments: JSON.stringify(input),
          status: 'completed'
        });
      }
      return leaked.inputs.length ? { ...c, text: leaked.text } : c;
    });
    if (content.some((c) => c.type !== 'output_text' || c.text)) recovered.push({ ...item, content });
  }
  return [...recovered, ...calls];
}

function outputText(output: ResponseOutputItem[]): string {
  return output
    .flatMap((item) => (item.type === 'message' ? item.content : []))
    .map((c) => (c.type === 'output_text' ? c.text : ''))
    .join('');
}

/** The problem as Responses API input. `native` is the provider whose earlier output is
 *  replayed as is (reasoning included); another provider's turns become text. */
export function openaiInput(req: Pick<TurnRequest, 'entries' | 'commands'>, native: 'openai' | 'chatgpt' = 'openai'): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  const answered = answeredBy(req.entries);
  for (const e of req.entries) {
    if (e.kind === 'user') {
      input.push({ role: 'user', content: userText(e) });
    } else if (e.kind === 'assistant') {
      if (isNative(e, native)) input.push(...(e.payload as ResponseInputItem[]));
      else {
        const text = foreignAssistantText(e, req.commands);
        if (text) input.push({ role: 'assistant', content: text });
      }
    } else if (isNative(answered.get(e.id), native)) {
      for (const r of e.results) input.push({ type: 'function_call_output', call_id: r.callId, output: outcomeText(r) });
    } else {
      const text = foreignResultsText(e, req.commands);
      if (text) input.push({ role: 'user', content: text });
    }
  }
  return input;
}

/** One streamed, stateless Responses API turn with `client` — an API key's, or the
 *  ChatGPT sign-in's (`chatgpt.ts`). */
export async function openaiTurn(client: OpenAI, req: TurnRequest, native: 'openai' | 'chatgpt' = 'openai'): Promise<TurnResult> {
  const stream = client.responses.stream(
    {
      model: req.model,
      instructions: req.system,
      input: openaiInput(req, native),
      tools: [TOOL],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false,
      include: ['reasoning.encrypted_content']
    },
    { signal: req.signal }
  );
  stream.on('response.output_text.delta', (event) => req.onText(event.delta));
  const response = await stream.finalResponse();
  const output = response.status === 'incomplete' ? response.output : recoverLeakedCalls(response.output);

  const calls: ProposedCall[] = [];
  for (const item of output) {
    if (item.type !== 'function_call') continue;
    let input: unknown;
    try {
      input = item.name === PROPOSE_COMMAND ? JSON.parse(item.arguments) : undefined;
    } catch {
      input = undefined;
    }
    calls.push({ callId: item.call_id, input });
  }
  const reason = response.incomplete_details?.reason;
  const notice =
    response.status === 'incomplete'
      ? reason === 'content_filter'
        ? 'The model declined to answer this.'
        : 'The answer was cut off at the output limit.'
      : undefined;
  // An answer cut off midway may have cut a call off too: none are shown or kept then,
  // since each kept call needs an answer on the next request.
  const kept = notice ? output.filter((item) => item.type !== 'function_call') : output;
  return {
    payload: replayable(kept),
    text: outputText(output),
    calls: notice ? [] : calls,
    notice,
    usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
  };
}

export const openaiBackend: AiBackend = {
  id: 'openai',

  turn: (req: TurnRequest): Promise<TurnResult> => openaiTurn(new OpenAI({ apiKey: req.apiKey }), req),

  async check(apiKey: string, model: string): Promise<void> {
    await new OpenAI({ apiKey }).models.retrieve(model);
  }
};
