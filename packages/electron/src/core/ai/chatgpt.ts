import OpenAI from 'openai';

import type { AiBackend, TurnRequest, TurnResult } from './backend.js';
import { CHATGPT_CODEX_BASE_URL, ChatgptSignedOutError, type ChatgptCredentials } from './chatgptAuth.js';
import { openaiTurn } from './openai.js';

/**
 * OpenAI models paid by a ChatGPT plan, signed in directly (experimental): the same
 * Responses API turn as with an API key, sent to the endpoint the Codex CLI uses with
 * the ChatGPT sign-in's token. OpenAI does not document this for other apps; when it
 * stops working, the Codex CLI provider is the supported way to the same plan.
 */

async function client(credentials: ChatgptCredentials, baseURL: string): Promise<OpenAI> {
  const { accessToken, accountId } = await credentials.get();
  return new OpenAI({
    apiKey: accessToken,
    baseURL,
    defaultHeaders: { 'chatgpt-account-id': accountId, 'OpenAI-Beta': 'responses=experimental' }
  });
}

function friendly(err: unknown): unknown {
  if (err instanceof OpenAI.RateLimitError) return new Error('The ChatGPT plan\'s usage limit is reached for now — try again later.');
  if (err instanceof OpenAI.NotFoundError || err instanceof OpenAI.BadRequestError) {
    return new Error(`ChatGPT did not take the request: ${err.message} — check the model in Settings → AI, or use the Codex CLI.`);
  }
  return err;
}

/** `baseURL` is for tests. */
export function chatgptBackend(credentials: ChatgptCredentials, baseURL = CHATGPT_CODEX_BASE_URL): AiBackend {
  return {
    id: 'chatgpt',

    async turn(req: TurnRequest): Promise<TurnResult> {
      try {
        return await openaiTurn(await client(credentials, baseURL), req, 'chatgpt');
      } catch (err) {
        if (!(err instanceof OpenAI.AuthenticationError)) throw friendly(err);
      }
      // The token was turned down before it ran out (signed out elsewhere): refresh once.
      credentials.invalidate();
      try {
        return await openaiTurn(await client(credentials, baseURL), req, 'chatgpt');
      } catch (err) {
        if (err instanceof OpenAI.AuthenticationError) {
          throw new ChatgptSignedOutError('ChatGPT turned the sign-in down — sign in again under Settings → AI.');
        }
        throw friendly(err);
      }
    },

    async check(): Promise<void> {
      await credentials.get();
    }
  };
}
