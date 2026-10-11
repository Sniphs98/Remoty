/**
 * The AI helper's data model (docs/concepts/ai-integration.md). A *problem* is one chat
 * about one thing on one host (or local shell profile), kept in `ai.sqlite` so it can be
 * picked up again on another day. Its transcript is a list of entries, appended in order
 * and never edited: what the user wrote, what the model answered, and what came of the
 * commands the model proposed. Nothing here talks to a provider; see `engine.ts`.
 */

/** `anthropic`/`openai` use an API key; `claude-cli`/`codex-cli` run the Claude Code or
 *  Codex CLI the user installed and signed in to with their subscription. */
export type AiProviderId = 'anthropic' | 'openai' | 'claude-cli' | 'codex-cli';

export type CliProviderId = Extract<AiProviderId, 'claude-cli' | 'codex-cli'>;

export function isCliProvider(id: AiProviderId): id is CliProviderId {
  return id === 'claude-cli' || id === 'codex-cli';
}

/** How careful the user should be with a proposed command. The model gives one, the
 *  local rules in `risk.ts` give one, and the card shows the higher of the two. */
export type Risk = 'safe' | 'caution' | 'danger';

export type ProblemStatus = 'open' | 'solved';

export interface Problem {
  id: string;
  /** The host's name, or `local:<profile id>` for a shell on this computer. */
  hostKey: string;
  /** What the panel calls the host (the profile's label for a local shell). */
  hostLabel: string;
  title: string;
  status: ProblemStatus;
  /** Frozen when the problem is created — rebuilding it later would cost the prompt
   *  cache and the model's earlier reasoning (append-only history). */
  systemPrompt: string;
  /** The terminal session the last message came from; a different one means the user
   *  is back in a new session and the model should check the state again. */
  lastSessionKey?: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: number;
  updatedAt: number;
}

/** One proposed command's answer, as it went back to the model. */
export interface CommandOutcome {
  commandId: string;
  /** The provider's id for the tool call this answers. */
  callId: string;
  state: 'ran' | 'skipped' | 'invalid';
  output?: string;
  /** Lines left out of the middle of a long output. */
  omittedLines?: number;
  note?: string;
}

export type EntryBody =
  | {
      kind: 'user';
      text: string;
      /** Context Remoty added (a new-session notice, a terminal excerpt). */
      context?: string;
    }
  | {
      kind: 'assistant';
      text: string;
      provider: AiProviderId;
      model: string;
      /** The provider's own output, replayed verbatim on the next request to the same
       *  provider — thinking blocks and tool calls included. */
      payload: unknown;
      /** Why the turn ended early, when it did (a refusal, the output limit). */
      notice?: string;
    }
  | { kind: 'results'; results: CommandOutcome[] };

export type Entry = EntryBody & { id: string; problemId: string; seq: number; createdAt: number };

export type CommandState = 'proposed' | 'ran' | 'skipped' | 'invalid';

export interface Command {
  id: string;
  problemId: string;
  /** The assistant entry that proposed it. */
  entryId: string;
  callId: string;
  command: string;
  explanation: string;
  risk: Risk;
  state: CommandState;
  /** The output as the model got it (masked, shortened). */
  output?: string;
  omittedLines?: number;
  note?: string;
  ranAt?: number;
}

/** What the renderer reports after running (or not running) a proposed command. */
export interface CommandReport {
  state: 'ran' | 'skipped';
  /** The captured terminal output, raw; the engine masks and shortens it. */
  output?: string;
  /** Something about the capture the model should know ("still running", …). */
  note?: string;
}

/** What the backends are told about where the commands run. */
export interface ShellContext {
  /** `ssh` for a remote host; otherwise the local profile's kind (powershell, wsl, …). */
  kind: string;
  hostLabel: string;
  os?: string;
  services?: string[];
}
