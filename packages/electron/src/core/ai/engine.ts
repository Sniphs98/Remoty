import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { type AiSettings, modelFor } from '../config/ai.js';
import type { AiBackend } from './backend.js';
import { shortenOutput } from './history.js';
import { maskSecrets } from './mask.js';
import { NEW_SESSION_NOTE, systemPrompt } from './prompt.js';
import { isRisk, localRisk, maxRisk } from './risk.js';
import type { AiStore } from './store.js';
import type { AiProviderId, Command, CommandOutcome, CommandReport, Entry, Problem, ShellContext } from './types.js';

/**
 * Runs the AI helper's conversations: stores what the user writes, asks the provider,
 * turns each `propose_command` call into a command card, and — once the user ran or
 * skipped every card of an answer — hands the outcomes back to the model. Nothing waits
 * in memory for a click: a pending card is a row in `ai.sqlite`, so a problem can sit
 * between steps for days, across restarts.
 */

export type EntryView = Exclude<Entry, { kind: 'assistant' }> | Omit<Extract<Entry, { kind: 'assistant' }>, 'payload'>;
export type ProblemView = Omit<Problem, 'systemPrompt'>;

export type EngineEvent =
  | { type: 'turnStart'; problemId: string }
  | { type: 'text'; problemId: string; delta: string }
  | { type: 'entry'; problemId: string; entry: EntryView; commands: Command[] }
  | { type: 'command'; problemId: string; command: Command }
  | { type: 'problem'; problem: ProblemView }
  | { type: 'turnEnd'; problemId: string }
  | { type: 'error'; problemId: string; message: string };

export interface EngineDeps {
  store: AiStore;
  settings(): Promise<AiSettings>;
  apiKey(settings: AiSettings, provider: AiProviderId): Promise<string>;
  backends: Record<AiProviderId, AiBackend>;
  /** Exact values to take out of anything sent for this host (its stored password). */
  secretsFor(hostKey: string): string[];
  emit(event: EngineEvent): void;
}

export const NEW_PROBLEM_TITLE = 'New problem';
const MAX_COMMAND_LENGTH = 4000;

export function entryView(entry: Entry): EntryView {
  if (entry.kind !== 'assistant') return entry;
  const { payload: _payload, ...rest } = entry;
  return rest;
}

export function problemView(problem: Problem): ProblemView {
  const { systemPrompt: _system, ...rest } = problem;
  return rest;
}

/** A title from the first message: its first line, cut at a word near 60 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].trim();
  if (line.length <= 60) return line || NEW_PROBLEM_TITLE;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${space > 30 ? cut.slice(0, space) : cut}…`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) {
    return 'The API key was not accepted — check it in Settings → AI.';
  }
  if (err instanceof Anthropic.PermissionDeniedError || err instanceof OpenAI.PermissionDeniedError) {
    return 'This API key may not use that model.';
  }
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError) {
    return 'The provider does not know that model — check the model name in Settings → AI.';
  }
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) {
    return 'The provider is rate limiting this key. Try again in a moment.';
  }
  if (err instanceof Anthropic.APIConnectionError || err instanceof OpenAI.APIConnectionError) {
    return 'Could not reach the provider. Check the internet connection.';
  }
  return err instanceof Error ? err.message : String(err);
}

export class AiEngine {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: EngineDeps) {}

  isRunning(problemId: string): boolean {
    return this.running.has(problemId);
  }

  createProblem(hostKey: string, shell: ShellContext): Problem {
    const problem = this.deps.store.createProblem({
      hostKey,
      hostLabel: shell.hostLabel,
      title: NEW_PROBLEM_TITLE,
      systemPrompt: systemPrompt(shell)
    });
    this.deps.emit({ type: 'problem', problem: problemView(problem) });
    return problem;
  }

  /** Stores the user's message and starts the model's answer (not awaited). */
  send(problemId: string, input: { text: string; context?: string; sessionKey?: string }): void {
    const { store } = this.deps;
    const problem = this.requireProblem(problemId);
    if (this.running.has(problemId)) throw new Error('The AI is still answering — wait for it or stop it first.');
    const text = input.text.trim();
    if (!text) throw new Error('Write something first.');

    this.skipPending(problemId, 'The user wrote a new message instead of running it.');
    const secrets = this.deps.secretsFor(problem.hostKey);
    const context: string[] = [];
    const hasHistory = store.entries(problemId).length > 0;
    if (hasHistory && input.sessionKey && problem.lastSessionKey && input.sessionKey !== problem.lastSessionKey) {
      context.push(NEW_SESSION_NOTE);
    }
    if (input.context?.trim()) context.push(maskSecrets(input.context, secrets));
    const entry = store.appendEntry(problemId, {
      kind: 'user',
      text: maskSecrets(text, secrets),
      ...(context.length ? { context: context.join('\n\n') } : {})
    });
    store.updateProblem(problemId, {
      ...(input.sessionKey ? { lastSessionKey: input.sessionKey } : {}),
      ...(problem.title === NEW_PROBLEM_TITLE && !hasHistory ? { title: titleFrom(text) } : {})
    });
    this.emitEntry(entry);
    this.emitProblem(problemId);
    void this.runTurn(problemId);
  }

  /** The user ran or skipped a proposed command. */
  async report(problemId: string, commandId: string, report: CommandReport): Promise<void> {
    const { store } = this.deps;
    const problem = this.requireProblem(problemId);
    const command = store.command(commandId);
    if (!command || command.problemId !== problemId || command.state !== 'proposed') return;
    const settings = await this.deps.settings();
    // Reported twice while the settings loaded: the first one counts.
    if (store.command(commandId)?.state !== 'proposed') return;
    if (report.state === 'ran') {
      const shortened = shortenOutput(maskSecrets(report.output ?? '', this.deps.secretsFor(problem.hostKey)), settings.maxOutputLines);
      store.updateCommand(commandId, { state: 'ran', ...shortened, note: report.note, ranAt: Date.now() });
    } else {
      store.updateCommand(commandId, { state: 'skipped', note: report.note });
    }
    this.deps.emit({ type: 'command', problemId, command: store.command(commandId)! });
    if (this.closeAnswer(problemId, command.entryId)) {
      if (settings.replyToResult && !this.running.has(problemId)) void this.runTurn(problemId);
    }
  }

  /** Asks the model to go on from where the problem stands (after results it was not
   *  sent automatically, or after a failed request). */
  continue(problemId: string): void {
    this.requireProblem(problemId);
    if (this.running.has(problemId)) return;
    const entries = this.deps.store.entries(problemId);
    const last = entries[entries.length - 1];
    if (!last || last.kind === 'assistant') throw new Error('Nothing new for the AI to answer yet.');
    void this.runTurn(problemId);
  }

  cancel(problemId: string): void {
    this.running.get(problemId)?.abort();
  }

  cancelAll(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  private requireProblem(problemId: string): Problem {
    const problem = this.deps.store.problem(problemId);
    if (!problem) throw new Error('That problem no longer exists.');
    return problem;
  }

  /** Marks every still-proposed command skipped, so the model gets an answer for each
   *  of its calls before the next message. */
  private skipPending(problemId: string, note: string): void {
    const { store } = this.deps;
    const pending = store.commands(problemId).filter((c) => c.state === 'proposed');
    for (const c of pending) {
      store.updateCommand(c.id, { state: 'skipped', note });
      this.deps.emit({ type: 'command', problemId, command: store.command(c.id)! });
    }
    for (const entryId of new Set(pending.map((c) => c.entryId))) this.closeAnswer(problemId, entryId);
  }

  /** Once no command of an answer is pending any more, stores their outcomes as the
   *  answer's results. Returns whether it did. */
  private closeAnswer(problemId: string, entryId: string): boolean {
    const { store } = this.deps;
    const commands = store.commands(problemId).filter((c) => c.entryId === entryId);
    if (commands.length === 0 || commands.some((c) => c.state === 'proposed')) return false;
    const results: CommandOutcome[] = commands.map((c) => ({
      commandId: c.id,
      callId: c.callId,
      state: c.state === 'ran' ? 'ran' : c.state === 'invalid' ? 'invalid' : 'skipped',
      ...(c.output !== undefined ? { output: c.output } : {}),
      ...(c.omittedLines ? { omittedLines: c.omittedLines } : {}),
      ...(c.note ? { note: c.note } : {})
    }));
    this.emitEntry(store.appendEntry(problemId, { kind: 'results', results }));
    return true;
  }

  private async runTurn(problemId: string): Promise<void> {
    const { store } = this.deps;
    const controller = new AbortController();
    this.running.set(problemId, controller);
    this.deps.emit({ type: 'turnStart', problemId });
    try {
      const settings = await this.deps.settings();
      const provider = settings.provider;
      const model = modelFor(settings, provider);
      const apiKey = await this.deps.apiKey(settings, provider);
      const problem = this.requireProblem(problemId);
      const result = await this.deps.backends[provider].turn({
        apiKey,
        model,
        system: problem.systemPrompt,
        entries: store.entries(problemId),
        commands: store.commands(problemId),
        signal: controller.signal,
        onText: (delta) => this.deps.emit({ type: 'text', problemId, delta })
      });
      store.addUsage(problemId, result.usage.input, result.usage.output);
      const entry = store.appendEntry(problemId, {
        kind: 'assistant',
        text: result.text,
        provider,
        model,
        payload: result.payload,
        ...(result.notice ? { notice: result.notice } : {})
      });
      for (const call of result.calls) {
        const input = call.input as { command?: unknown; explanation?: unknown; risk?: unknown } | undefined;
        const command = typeof input?.command === 'string' ? input.command.trim() : '';
        const valid = command.length > 0 && command.length <= MAX_COMMAND_LENGTH;
        store.addCommand({
          problemId,
          entryId: entry.id,
          callId: call.callId,
          command,
          explanation: typeof input?.explanation === 'string' ? input.explanation : '',
          risk: maxRisk(isRisk(input?.risk) ? input.risk : 'caution', localRisk(command)),
          state: valid ? 'proposed' : 'invalid',
          ...(valid ? {} : { note: 'The call had no usable command.' })
        });
      }
      this.emitEntry(entry);
      this.emitProblem(problemId);
      // Every call invalid: answer them right away, so the history stays complete.
      this.closeAnswer(problemId, entry.id);
    } catch (err) {
      if (!controller.signal.aborted) this.deps.emit({ type: 'error', problemId, message: errorMessage(err) });
    } finally {
      this.running.delete(problemId);
      this.deps.emit({ type: 'turnEnd', problemId });
    }
  }

  private emitEntry(entry: Entry): void {
    const commands = entry.kind === 'assistant' ? this.deps.store.commands(entry.problemId).filter((c) => c.entryId === entry.id) : [];
    this.deps.emit({ type: 'entry', problemId: entry.problemId, entry: entryView(entry), commands });
  }

  private emitProblem(problemId: string): void {
    const problem = this.deps.store.problem(problemId);
    if (problem) this.deps.emit({ type: 'problem', problem: problemView(problem) });
  }
}
