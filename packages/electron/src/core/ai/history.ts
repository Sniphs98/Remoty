import type { AiProviderId, Command, CommandOutcome, Entry } from './types.js';

/**
 * Shared pieces for turning a stored transcript into a provider request. Entries the
 * same provider produced are replayed verbatim by the backend; these helpers render the
 * rest as plain text, so a problem can move between providers.
 */

export type UserEntry = Extract<Entry, { kind: 'user' }>;
export type AssistantEntry = Extract<Entry, { kind: 'assistant' }>;
export type ResultsEntry = Extract<Entry, { kind: 'results' }>;

export function userText(e: UserEntry): string {
  return e.context ? `${e.text}\n\n${e.context}` : e.text;
}

/** What the model gets back for one proposed command. */
export function outcomeText(r: CommandOutcome): string {
  const note = r.note ? `\n(${r.note})` : '';
  switch (r.state) {
    case 'ran': {
      const out = r.output?.trim() ? r.output : '(no output)';
      const omitted = r.omittedLines ? `\n(${r.omittedLines} lines in the middle left out)` : '';
      return `Terminal output:\n${out}${omitted}${note}`;
    }
    case 'skipped':
      return `The user did not run this command.${note}`;
    case 'invalid':
      return `This call could not be shown to the user.${note}`;
  }
}

/** An assistant entry from another provider, as plain text. */
export function foreignAssistantText(e: AssistantEntry, commands: Command[]): string {
  const proposals = commands
    .filter((c) => c.entryId === e.id && c.state !== 'invalid')
    .map((c) => `[proposed command: ${c.command}]`);
  return [e.text.trim(), ...proposals].filter(Boolean).join('\n');
}

/** Results for commands from another provider's entry, as plain text. */
export function foreignResultsText(e: ResultsEntry, commands: Command[]): string {
  return e.results
    .filter((r) => r.state !== 'invalid')
    .map((r) => {
      const command = commands.find((c) => c.id === r.commandId)?.command ?? '(command)';
      return `Result of \`${command}\`:\n${outcomeText(r)}`;
    })
    .join('\n\n');
}

/** For each results entry, the assistant entry whose calls it answers (the nearest one
 *  before it). */
export function answeredBy(entries: Entry[]): Map<string, AssistantEntry> {
  const map = new Map<string, AssistantEntry>();
  let last: AssistantEntry | undefined;
  for (const e of entries) {
    if (e.kind === 'assistant') last = e;
    else if (e.kind === 'results' && last) map.set(e.id, last);
  }
  return map;
}

export function isNative(e: AssistantEntry | undefined, provider: AiProviderId): boolean {
  return e?.provider === provider;
}

/** `text` with its middle lines left out when it has more than `maxLines`. */
export function shortenOutput(text: string, maxLines: number): { output: string; omittedLines?: number } {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length <= maxLines) return { output: lines.join('\n') };
  const head = Math.floor(maxLines / 4);
  const tail = maxLines - head;
  const omitted = lines.length - head - tail;
  return {
    output: [...lines.slice(0, head), `… ${omitted} lines left out …`, ...lines.slice(lines.length - tail)].join('\n'),
    omittedLines: omitted
  };
}
