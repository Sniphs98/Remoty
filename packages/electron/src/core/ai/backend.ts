import type { AiProviderId, Command, Entry } from './types.js';

/** One request to a provider: the stored transcript in, one answer out. Each backend
 *  replays its own earlier output verbatim and renders the rest as text (`history.ts`). */
export interface TurnRequest {
  apiKey: string;
  model: string;
  system: string;
  entries: Entry[];
  commands: Command[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export interface ProposedCall {
  callId: string;
  /** As the model sent it; validated by the engine. */
  input: unknown;
}

export interface TurnResult {
  /** The provider's output, stored and replayed as is. */
  payload: unknown;
  text: string;
  calls: ProposedCall[];
  /** Why the turn ended early, said to the user. */
  notice?: string;
  usage: { input: number; output: number };
}

export interface AiBackend {
  id: AiProviderId;
  turn(req: TurnRequest): Promise<TurnResult>;
  /** Cheap check that the key works and the model exists. */
  check(apiKey: string, model: string): Promise<void>;
}
