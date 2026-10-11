import type { AiProviderId, Command, Entry } from './types.js';

/** One request to a provider: the stored transcript in, one answer out. Each backend
 *  replays its own earlier output verbatim and renders the rest as text (`history.ts`). */
export interface TurnRequest {
  /** Empty for the CLI providers. */
  apiKey: string;
  /** Empty means the provider's default (the CLIs' own choice). */
  model: string;
  system: string;
  entries: Entry[];
  commands: Command[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** CLI providers: the configured path to the program, if any. */
  cliPath?: string;
  /** CLI providers: the CLI's own conversation for this problem, which already holds
   *  every entry up to `lastSeq`. */
  session?: CliSession;
}

export interface CliSession {
  id: string;
  lastSeq: number;
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
  /** CLI providers: the conversation the answer is part of now. */
  sessionId?: string;
  /** The model that answered, when the provider says (the CLIs pick one by default). */
  model?: string;
}

export interface AiBackend {
  id: AiProviderId;
  turn(req: TurnRequest): Promise<TurnResult>;
  /** Cheap check that the key works and the model exists (for a CLI: that it is
   *  installed and signed in). */
  check(apiKey: string, model: string, cliPath?: string): Promise<void>;
}
