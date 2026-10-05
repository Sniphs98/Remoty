/**
 * A command typed into the snippet or If editor, ready for a POSIX shell (bash in WSL,
 * the host's shell over SSH, `sh` on a Linux or macOS machine).
 *
 * Windows line ends become plain line breaks: the command editor (Monaco) ends lines
 * with `\r\n` on Windows, and so may a hand-edited `automations.toml` or an imported
 * bundle. Bash reads the `\r` as part of each line — `$'\r': command not found`,
 * `exit 1\r` a "numeric argument required" — so a multi-line command failed where the
 * same command on one line worked. A lone `\r` (old Mac line ends) is a line break too.
 *
 * Done where a command is handed to the shell, after templates are filled in, so a
 * parameter value pasted with a Windows line end is covered as well: `runWslCommand`,
 * every command run on a host (`SshSession`'s exec channel — automations, key setup,
 * monitoring), and `runLocalCommand` off Windows. Text typed into an interactive
 * terminal (a snippet run from the file browser, a host's startup command) gets the
 * same treatment in the UI — see `typedCommandLine` in ui/src/lib/screens/terminalInput.ts.
 */
export function normalizeShellCommand(command: string): string {
  return command.replace(/\r\n?/g, '\n');
}
