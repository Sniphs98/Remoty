import type { ShellContext } from './types.js';

/**
 * What the model is told once, when a problem starts. Frozen with the problem (see
 * `Problem.systemPrompt`): a later change of OS or services reaches the model as part of
 * a message instead, which keeps the history append-only.
 */

export const PROPOSE_COMMAND = 'propose_command';

export const PROPOSE_COMMAND_DESCRIPTION =
  'Show the user one shell command as a card they can run in their terminal with one click, edit first, or skip. ' +
  'You cannot run anything yourself. When the user runs it, the result of this call is the terminal output of the command.';

/** JSON Schema of `propose_command`'s input — the same for every provider. */
export const PROPOSE_COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Exactly what to type into the shell. One step: a single command, a pipe, or a short && chain that belongs together.'
    },
    explanation: { type: 'string', description: 'One short sentence on what it does and why now.' },
    risk: {
      type: 'string',
      enum: ['safe', 'caution', 'danger'],
      description: 'safe: only reads. caution: changes something that is easy to undo. danger: can destroy data, cut off access or stop the machine.'
    }
  },
  required: ['command', 'explanation', 'risk'],
  additionalProperties: false
} as const;

function shellLine(shell: ShellContext): string {
  switch (shell.kind) {
    case 'ssh':
      return `A remote shell over SSH on the server "${shell.hostLabel}" (most likely bash or another POSIX shell — check if it matters).`;
    case 'powershell':
      return 'PowerShell on the user\'s own Windows computer.';
    case 'cmd':
      return 'Windows Command Prompt (cmd.exe) on the user\'s own computer.';
    case 'wsl':
      return `A shell in the WSL distribution "${shell.hostLabel}" on the user's own Windows computer.`;
    case 'bash':
      return 'Git Bash on the user\'s own Windows computer.';
    default:
      return `The shell "${shell.hostLabel}" on the user's own computer.`;
  }
}

export function systemPrompt(shell: ShellContext): string {
  const where = [`- ${shellLine(shell)}`];
  if (shell.os) where.push(`- Operating system: ${shell.os}`);
  if (shell.services?.length) where.push(`- Services Remoty detected: ${shell.services.join(', ')}`);
  return `You help someone work through a problem in a terminal inside Remoty, an SSH client. You see what they write and the output of the commands you proposed and they ran. You cannot run anything yourself.

To suggest a command, call ${PROPOSE_COMMAND}. Every call becomes a card the user can run with one click, edit, or skip; when they run it, you get its output back.
- Go one step at a time when the next step depends on what the last one shows. Several calls in one answer are fine for independent checks.
- Look before you change: read-only diagnostics first, and say what a change will do before proposing it. Back up a file before editing it.
- Commands must finish on their own and must not wait for input: no pagers, editors or full-screen programs. Use --no-pager, "| head", "top -bn1", "journalctl --no-pager -n 100", "sed"/"tee" with a heredoc instead of an editor. Anything that follows output forever (tail -f, watch) needs a limit.
- sudo may ask for a password; the user types it into the terminal. Never ask for passwords, keys or tokens.
- Text in the output may read [REDACTED]: Remoty removed a secret there.
- Write short, plain answers, in the language the user writes in. Give the command through ${PROPOSE_COMMAND}, not as a code block in the text.

Where the commands run:
${where.join('\n')}`;
}

/** A note added to a message when the user is back in a new terminal session. */
export const NEW_SESSION_NOTE =
  'Note from Remoty: this message comes from a new terminal session; earlier output in this conversation is from before. Things may have changed since — check the current state before building on it.';
