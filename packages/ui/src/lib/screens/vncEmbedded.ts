// Loading noVNC and making sense of how a VNC session ended, kept apart from
// VncView.svelte so the wording is unit-testable. noVNC is only fetched the first
// time a VNC connection is opened in the app.

type NoVncModule = typeof import('@novnc/novnc');
export type Rfb = InstanceType<NoVncModule['default']>;
export type RfbConstructor = NoVncModule['default'];

let loading: Promise<RfbConstructor> | undefined;

/** noVNC's RFB client class, loaded once. */
export function loadNoVnc(): Promise<RfbConstructor> {
  loading ??= import('@novnc/novnc').then((m) => m.default);
  loading.catch(() => (loading = undefined));
  return loading;
}

/** What a server's `credentialsrequired` asks for, as the sign-in form's fields. Plain
 *  VNC authentication only wants a password; VeNCrypt, Apple's and the like a user too. */
export function credentialFields(types: readonly string[] | undefined): { username: boolean } {
  return { username: Boolean(types?.includes('username')) };
}

/**
 * What to tell the user about a session that ended or never got going.
 * `gatewayFailure` is the main process's account (server unreachable, not a VNC
 * server…) and wins; then the server's reason for refusing to sign in
 * (`securityfailure`); then how the connection closed.
 */
export function explainVncEnd(c: {
  gatewayFailure?: string | null;
  securityFailure?: { status?: number; reason?: string } | null;
  clean: boolean;
  connected: boolean;
}): string | null {
  if (c.gatewayFailure) return c.gatewayFailure.charAt(0).toUpperCase() + c.gatewayFailure.slice(1) + '.';
  if (c.securityFailure) {
    const reason = c.securityFailure.reason?.trim();
    if (reason) return `The server refused to sign in: ${reason.replace(/\.?$/, '.')}`;
    // RFB's security result 1 is a failed check, which for VNC auth means the password.
    return 'The password was not accepted.';
  }
  if (c.connected) return c.clean ? null : 'The connection was lost.';
  return c.clean ? 'The server closed the connection.' : 'Could not connect to the server.';
}
