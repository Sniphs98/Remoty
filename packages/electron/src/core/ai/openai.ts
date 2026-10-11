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

export function openaiInput(req: Pick<TurnRequest, 'entries' | 'commands'>): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];
  const answered = answeredBy(req.entries);
  for (const e of req.entries) {
    if (e.kind === 'user') {
      input.push({ role: 'user', content: userText(e) });
    } else if (e.kind === 'assistant') {
      if (isNative(e, 'openai')) input.push(...(e.payload as ResponseInputItem[]));
      else {
        const text = foreignAssistantText(e, req.commands);
        if (text) input.push({ role: 'assistant', content: text });
      }
    } else if (isNative(answered.get(e.id), 'openai')) {
      for (const r of e.results) input.push({ type: 'function_call_output', call_id: r.callId, output: outcomeText(r) });
    } else {
      const text = foreignResultsText(e, req.commands);
      if (text) input.push({ role: 'user', content: text });
    }
  }
  return input;
}

export const openaiBackend: AiBackend = {
  id: 'openai',

  async turn(req: TurnRequest): Promise<TurnResult> {
    const client = new OpenAI({ apiKey: req.apiKey });
    const stream = client.responses.stream(
      {
        model: req.model,
        instructions: req.system,
        input: openaiInput(req),
        tools: [TOOL],
        store: false,
        include: ['reasoning.encrypted_content']
      },
      { signal: req.signal }
    );
    stream.on('response.output_text.delta', (event) => req.onText(event.delta));
    const response = await stream.finalResponse();

    const calls: ProposedCall[] = [];
    for (const item of response.output) {
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
    const kept = notice ? response.output.filter((item) => item.type !== 'function_call') : response.output;
    return {
      payload: replayable(kept),
      text: response.output_text ?? '',
      calls: notice ? [] : calls,
      notice,
      usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 }
    };
  },

  async check(apiKey: string, model: string): Promise<void> {
    await new OpenAI({ apiKey }).models.retrieve(model);
  }
};
