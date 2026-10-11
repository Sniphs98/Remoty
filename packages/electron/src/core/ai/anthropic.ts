import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

import type { AiBackend, ProposedCall, TurnRequest, TurnResult } from './backend.js';
import { answeredBy, foreignAssistantText, foreignResultsText, isNative, outcomeText, userText } from './history.js';
import { PROPOSE_COMMAND, PROPOSE_COMMAND_DESCRIPTION, PROPOSE_COMMAND_SCHEMA } from './prompt.js';

/**
 * Claude through the Anthropic API (Messages, streamed). The history is append-only and
 * earlier assistant turns go back exactly as they came — thinking blocks included — so
 * the prompt cache and the model's earlier reasoning stay valid across a problem.
 */

const TOOL: BetaTool = {
  name: PROPOSE_COMMAND,
  description: PROPOSE_COMMAND_DESCRIPTION,
  // No eager input streaming: a command is a line or two, and without it the API checks
  // the input against the schema before the turn ends.
  input_schema: PROPOSE_COMMAND_SCHEMA as unknown as BetaTool['input_schema']
};

/** Models that take adaptive thinking, `effort`, and the server-side fallback on a
 *  policy decline. Older ones get the plain request. */
const CURRENT = /^claude-(opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6|haiku-5|fable-5|mythos-5)/;
const SERVER_FALLBACK = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;

export function anthropicMessages(req: Pick<TurnRequest, 'entries' | 'commands'>): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [];
  const push = (role: 'user' | 'assistant', content: BetaContentBlockParam[]): void => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === role && Array.isArray(last.content)) last.content.push(...content);
    else messages.push({ role, content: [...content] });
  };
  const answered = answeredBy(req.entries);
  for (const e of req.entries) {
    if (e.kind === 'user') {
      push('user', [{ type: 'text', text: userText(e) }]);
    } else if (e.kind === 'assistant') {
      if (isNative(e, 'anthropic')) push('assistant', e.payload as BetaContentBlockParam[]);
      else {
        const text = foreignAssistantText(e, req.commands);
        if (text) push('assistant', [{ type: 'text', text }]);
      }
    } else if (isNative(answered.get(e.id), 'anthropic')) {
      push(
        'user',
        e.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.callId,
          content: outcomeText(r),
          ...(r.state === 'invalid' ? { is_error: true } : {})
        }))
      );
    } else {
      const text = foreignResultsText(e, req.commands);
      if (text) push('user', [{ type: 'text', text }]);
    }
  }
  return messages;
}

/** After a mid-answer fallback to another model, the blocks before the switch that the
 *  new model can't continue from are left out of what is kept and replayed. */
function afterFallback(content: BetaContentBlock[]): BetaContentBlock[] {
  let boundary = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') boundary = i;
  });
  if (boundary < 0) return content;
  const dropBefore = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);
  return content.filter((b, i) => i >= boundary || !dropBefore.has(b.type));
}

export const anthropicBackend: AiBackend = {
  id: 'anthropic',

  async turn(req: TurnRequest): Promise<TurnResult> {
    const client = new Anthropic({ apiKey: req.apiKey });
    const current = CURRENT.test(req.model);
    const betas: string[] = [];
    if (current) betas.push('thinking-binding-controls-2026-08-01');
    if (SERVER_FALLBACK.test(req.model)) betas.push('server-side-fallback-2026-07-01');

    const stream = client.beta.messages.stream(
      {
        model: req.model,
        max_tokens: 64000,
        system: req.system,
        tools: [TOOL],
        messages: anthropicMessages(req),
        cache_control: { type: 'ephemeral' },
        ...(current
          ? {
              // A history that no longer matches a thinking block (another model took a
              // turn, say) drops that block instead of failing the request.
              thinking: { type: 'adaptive' as const, block_binding: { prefix_mismatch_behavior: 'drop_block' as const } },
              output_config: { effort: 'medium' as const }
            }
          : {}),
        ...(SERVER_FALLBACK.test(req.model) ? { fallbacks: 'default' as const } : {}),
        ...(betas.length ? { betas } : {})
      },
      { signal: req.signal }
    );
    stream.on('text', (delta) => req.onText(delta));
    const message = await stream.finalMessage();

    let content = afterFallback(message.content);
    let notice: string | undefined;
    if (message.stop_reason === 'refusal') notice = 'The model declined to answer this.';
    else if (message.stop_reason === 'max_tokens') notice = 'The answer was cut off at the output limit.';
    // A turn that ended any other way than finishing or calling a tool may have cut a
    // call off mid-input: none of its calls are shown.
    if (message.stop_reason !== 'tool_use' && message.stop_reason !== 'end_turn') {
      content = content.filter((b) => b.type !== 'tool_use');
    }

    const calls: ProposedCall[] = content
      .filter((b): b is Extract<BetaContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ callId: b.id, input: b.name === PROPOSE_COMMAND ? b.input : undefined }));
    const text = content
      .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const u = message.usage;
    return {
      payload: content,
      text,
      calls,
      notice,
      usage: {
        input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        output: u.output_tokens ?? 0
      }
    };
  },

  async check(apiKey: string, model: string): Promise<void> {
    await new Anthropic({ apiKey }).models.retrieve(model);
  }
};
