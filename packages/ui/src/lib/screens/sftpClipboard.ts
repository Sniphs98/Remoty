// Cut, copy and paste in an SFTP tab: what pasting the clipboard into a pane does. Kept
// free of Svelte so it's unit-testable; SftpView.svelte keeps the clipboard (per tab, so
// files never land on another server by mistake) and runs the plan.
//
// Both panes can be on the server (the left one then shows the same host), or the left
// one is this computer. On the server a paste is a move (SFTP rename, any size, at once)
// or a copy (`cp` on the host); between this computer and the server it's an upload or a
// download — of files, as dragging between them is.

export type PaneSide = 'local' | 'remote';

export interface FileClip {
  mode: 'copy' | 'cut';
  /** Whether the entries are on the server (the right pane, or the left one showing the host). */
  onServer: boolean;
  entries: Array<{ path: string; name: string; isDir: boolean }>;
}

export type PastePlan =
  | { kind: 'relocate'; mode: 'move' | 'copy' }
  | { kind: 'upload' }
  | { kind: 'download' }
  | { kind: 'none'; reason: string };

/** What pasting `clip` into a pane on the server (`targetOnServer`) or on this computer does. */
export function pastePlan(clip: FileClip | null, targetOnServer: boolean): PastePlan {
  if (!clip || clip.entries.length === 0) return { kind: 'none', reason: 'Nothing cut or copied yet' };
  if (clip.onServer && targetOnServer) return { kind: 'relocate', mode: clip.mode === 'cut' ? 'move' : 'copy' };
  if (!clip.onServer && !targetOnServer) return { kind: 'none', reason: 'Both are on this computer' };
  if (clip.entries.every((e) => e.isDir)) return { kind: 'none', reason: 'Only files go between this computer and the server, not folders' };
  if (clip.onServer) {
    // Moving off the server would delete there after a download — not done behind a paste.
    if (clip.mode === 'cut') return { kind: 'none', reason: 'Cut files can only be moved on the server — copy them to bring them here' };
    return { kind: 'download' };
  }
  return { kind: 'upload' };
}

/** The menu label for pasting with `plan` (into `into`, a folder right-clicked, if any). */
export function pasteLabel(clip: FileClip | null, plan: PastePlan, into?: string): string {
  const n = clip?.entries.length ?? 0;
  const what = n > 1 ? `${n} items` : '';
  const where = into ? ` into ${into}` : '';
  if (plan.kind === 'none') return `Paste${where}`;
  return `Paste${what ? ` ${what}` : ''}${where}`;
}

/** Whether a cut can start in this pane: only on the server (see `pastePlan`). */
export function canCut(onServer: boolean): boolean {
  return onServer;
}
