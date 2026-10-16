<script lang="ts">
  // A VNC desktop inside the app, as a tab next to the RDP ones: noVNC's RFB client
  // talking to the VNC server through the main process's local gateway
  // (core/vnc/gateway.ts). Kept mounted while other tabs are shown, so the session keeps
  // running. The OS's own VNC viewer stays one click away.
  import { onDestroy, onMount } from 'svelte';
  import { sessions, type Session } from '$lib/stores/sessions';
  import { closeSession } from '$lib/stores/navigation';
  import { remoteDesktopConnections } from '$lib/stores/remoteDesktop';
  import { lastError } from '$lib/stores/notifications';
  import { vncEmbeddedClose, vncEmbeddedOpen, vncEmbeddedStatus, vncLaunch } from '$lib/ipc/commands';
  import { Icon } from '$lib/theme';
  import { events } from '$lib/bindings';
  import { streamerMode, displayHostname } from '$lib/stores/streamer';
  import { credentialFields, explainVncEnd, loadNoVnc, type Rfb } from './vncEmbedded';
  import { fromOnePassword } from './remoteDesktopForm';
  import { isOnePasswordReference } from './onePasswordRef';
  import { advance, formatElapsed, rdpConnectSteps, stepStatus, type RdpConnectStage } from './rdpConnectSteps';

  let { session, active }: { session: Session; active: boolean } = $props();

  let viewport = $state<HTMLDivElement>();
  let phase = $state<'connecting' | 'credentials' | 'connected' | 'ended' | 'failed'>('connecting');
  // Asked for in the tab when the server wants what the profile doesn't store; kept only
  // for reconnects of this tab, never saved.
  let credentials = $state<{ username?: string; password: string } | null>(null);
  let form = $state({ username: '', password: '' });
  /** 1Password couldn't give the profile's sign-in: why, above the prompt that asks for it. */
  let signInProblem = $state<string | null>(null);
  let askUsername = $state(false);
  let passwordEl = $state<HTMLInputElement>();
  let problem = $state<string | null>(null);

  let rfb: Rfb | undefined;
  let token: string | undefined;
  let destroyed = false;
  // The last text that crossed the clipboard either way, so it isn't sent back.
  let lastClipboard = '';

  const connection = $derived($remoteDesktopConnections.find((c) => c.id === session.rdpConnectionId));
  const clipboardOn = $derived(connection?.clipboard !== false);

  let stage = $state<RdpConnectStage>('viewer');
  let stageSince = $state(Date.now());
  let now = $state(Date.now());
  let progressKey = '';
  let attempts = 0;
  let stopProgress: (() => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const steps = $derived(
    rdpConnectSteps({
      protocol: 'vnc',
      onePassword: connection ? fromOnePassword(connection) !== '' : false,
      viaHost: connection?.viaHost,
      server:
        connection && !isOnePasswordReference(connection.hostname)
          ? `${displayHostname(connection.hostname, $streamerMode)}:${connection.port}`
          : session.hostName
    })
  );
  const currentStep = $derived(steps.find((s) => s.stage === stage));

  function reach(next: RdpConnectStage): void {
    const to = advance(steps, stage, next);
    if (to === stage) return;
    stage = to;
    stageSince = Date.now();
  }

  function teardown(): void {
    const old = rfb;
    rfb = undefined;
    try {
      old?.disconnect();
    } catch {
      // already gone
    }
    if (token) void vncEmbeddedClose(token).catch(() => {});
    token = undefined;
  }

  async function connect(): Promise<void> {
    if (!viewport || !session.rdpConnectionId) return;
    teardown();
    phase = 'connecting';
    problem = null;
    progressKey = `${session.id}-${++attempts}`;
    stage = 'viewer';
    stageSince = Date.now();
    sessions.setStatus(session.id, 'connecting');
    try {
      const RFB = await loadNoVnc();
      if (destroyed) return;
      const dto = await vncEmbeddedOpen(session.rdpConnectionId, progressKey);
      signInProblem = dto.signInProblem ?? null;
      if (destroyed) {
        void vncEmbeddedClose(dto.token).catch(() => {});
        return;
      }
      token = dto.token;
      // What was typed in this tab wins over the profile's.
      const username = credentials?.username || dto.username || undefined;
      const password = credentials?.password || dto.password || undefined;
      const creds = { ...(username ? { username } : {}), ...(password ? { password } : {}) };

      reach('reach');
      const client = new RFB(viewport, dto.url, { credentials: creds, shared: true });
      rfb = client;
      client.viewOnly = connection?.viewOnly === true;
      client.scaleViewport = true;
      client.resizeSession = connection?.dynamicResolution === true;
      client.background = 'transparent';
      client.qualityLevel = 6;
      client.compressionLevel = 2;

      let connected = false;
      let securityFailure: { status?: number; reason?: string } | null = null;
      const current = (): boolean => !destroyed && rfb === client;

      client.addEventListener('connect', () => {
        if (!current()) return;
        connected = true;
        phase = 'connected';
        sessions.setStatus(session.id, 'connected');
        focus();
        void pushClipboard();
      });
      client.addEventListener('credentialsrequired', (e) => {
        if (!current()) return;
        const types = (e as CustomEvent<{ types?: string[] }>).detail?.types;
        askUsername = credentialFields(types).username;
        form = { username: credentials?.username ?? dto.username ?? '', password: '' };
        phase = 'credentials';
        sessions.setStatus(session.id, 'unknown');
        requestAnimationFrame(() => passwordEl?.focus());
      });
      client.addEventListener('securityfailure', (e) => {
        securityFailure = (e as CustomEvent<{ status?: number; reason?: string }>).detail ?? {};
      });
      client.addEventListener('clipboard', (e) => {
        if (!current() || !clipboardOn) return;
        const text = (e as CustomEvent<{ text: string }>).detail?.text ?? '';
        lastClipboard = text;
        void navigator.clipboard.writeText(text).catch(() => {});
      });
      client.addEventListener('disconnect', (e) => {
        if (!current()) return;
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean ?? false;
        void ended(clean, connected, securityFailure);
      });
    } catch (err) {
      if (destroyed) return;
      problem = err instanceof Error ? err.message : String(err);
      phase = 'failed';
      sessions.setStatus(session.id, 'failed');
      teardown();
    }
  }

  async function ended(clean: boolean, connected: boolean, securityFailure: { status?: number; reason?: string } | null): Promise<void> {
    const status = token ? await vncEmbeddedStatus(token).catch(() => undefined) : undefined;
    if (destroyed) return;
    teardown();
    problem = explainVncEnd({ gatewayFailure: status?.failure, securityFailure, clean, connected });
    // Wrong typed credentials: ask again rather than keep failing with them.
    if (securityFailure) credentials = null;
    phase = connected && !securityFailure && !status?.failure ? 'ended' : 'failed';
    sessions.setStatus(session.id, phase === 'ended' ? 'unknown' : 'failed');
  }

  function focus(): void {
    requestAnimationFrame(() => rfb?.focus({ preventScroll: true }));
  }

  /** Local clipboard → remote, when the tab gets the focus (noVNC can't watch it). */
  async function pushClipboard(): Promise<void> {
    if (!rfb || phase !== 'connected' || !clipboardOn || connection?.viewOnly) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text && text !== lastClipboard) {
        lastClipboard = text;
        rfb?.clipboardPasteFrom(text);
      }
    } catch {
      // No access to the clipboard right now: nothing to send.
    }
  }

  function signIn(event: SubmitEvent): void {
    event.preventDefault();
    if (!form.password || (askUsername && !form.username.trim())) return;
    credentials = { ...(askUsername ? { username: form.username.trim() } : {}), password: form.password };
    if (rfb) {
      // The server is still waiting on this connection: answer it.
      phase = 'connecting';
      reach('signin');
      sessions.setStatus(session.id, 'connecting');
      rfb.sendCredentials($state.snapshot(credentials));
    } else {
      void connect();
    }
  }

  async function openExternally(): Promise<void> {
    if (!session.rdpConnectionId) return;
    try {
      await vncLaunch(session.rdpConnectionId);
    } catch (e) {
      lastError.set(e instanceof Error ? e.message : String(e));
    }
  }

  function sendCtrlAltDel(): void {
    rfb?.sendCtrlAltDel();
    focus();
  }

  const onWindowFocus = (): void => {
    if (active) void pushClipboard();
  };

  onMount(() => {
    ticker = setInterval(() => (now = Date.now()), 500);
    events.rdpConnectProgress
      .listen((e) => {
        if (e.payload.key === progressKey) reach(e.payload.stage);
      })
      .then((off) => (destroyed ? off() : (stopProgress = off)))
      .catch(() => {
        // No Electron bridge (tests): the steps just don't advance on their own.
      });
    window.addEventListener('focus', onWindowFocus);
    void connect();
  });

  onDestroy(() => {
    destroyed = true;
    clearInterval(ticker);
    stopProgress?.();
    window.removeEventListener('focus', onWindowFocus);
    teardown();
  });

  $effect(() => {
    if (active && phase === 'connected') {
      focus();
      void pushClipboard();
    }
  });

  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
  const btn =
    'inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs font-medium text-muted ' +
    'transition hover:border-strong hover:bg-accent hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<div class="absolute inset-0 flex flex-col bg-surface {active ? '' : 'hidden'}" style="padding-top: var(--titlebar-h);">
  <div class="flex shrink-0 items-center gap-2 border-b border-default px-4 py-2 text-xs">
    <Icon name="monitor" size={14} />
    <span class="font-medium">{session.hostName}</span>
    <span class="rounded-full border border-default px-1.5 py-0.5 text-[10px] uppercase text-faint">vnc</span>
    <span class="text-faint">
      {phase === 'connecting'
        ? `Connecting · ${currentStep?.label ?? ''}`
        : phase === 'credentials'
          ? 'Sign in'
          : phase === 'connected'
            ? connection?.viewOnly
              ? 'Connected · view only'
              : 'Connected'
            : phase === 'ended'
              ? 'Session ended'
              : 'Failed'}
    </span>
    <div class="ml-auto flex items-center gap-1.5">
      {#if phase === 'connected'}
        {#if !connection?.viewOnly}
          <button type="button" class={btn} title="Send Ctrl+Alt+Del" onclick={sendCtrlAltDel}>Ctrl+Alt+Del</button>
        {/if}
      {:else if phase !== 'connecting' && phase !== 'credentials'}
        <button type="button" class={btn} onclick={() => connect()}>
          <Icon name="refresh" size={12} />
          Reconnect
        </button>
      {/if}
      <button type="button" class={btn} title="Open in the VNC viewer of this computer instead" onclick={openExternally}>
        <Icon name="upload" size={12} />
        Open externally
      </button>
      <button type="button" class={btn} title="Close this tab" onclick={() => closeSession(session.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  </div>

  <div class="relative min-h-0 flex-1 overflow-hidden bg-black">
    <!-- noVNC puts its canvas in here and scales it to fit. -->
    <div bind:this={viewport} class="vnc-viewport absolute inset-0" onfocusin={() => void pushClipboard()}></div>

    {#if phase !== 'connected'}
      <div class="absolute inset-0 grid place-items-center bg-surface p-6">
        <div class="max-w-md space-y-3 text-center">
          {#if phase === 'connecting'}
            <p class="font-medium">Connecting to {session.hostName}</p>
            <div class="connect-bar mx-auto h-1 w-56 overflow-hidden rounded-full bg-surface-inset" aria-hidden="true"></div>
            {@render stepList(false)}
          {:else if phase === 'credentials'}
            <form class="w-80 space-y-3 text-left" onsubmit={signIn}>
              <p class="text-center font-medium">Sign in to {session.hostName}</p>
              {#if signInProblem}
                <p class="rounded-lg bg-surface-inset px-3 py-2 text-xs text-status-warn" role="status">
                  Couldn't get the sign-in from 1Password ({signInProblem.replace(/^1Password:\s*/, '')}). Enter it here instead.
                </p>
              {/if}
              {#if askUsername}
                <label class="block space-y-1 text-xs font-medium text-muted">
                  <span>Username</span>
                  <input bind:value={form.username} class={field} autocomplete="off" />
                </label>
              {/if}
              <label class="block space-y-1 text-xs font-medium text-muted">
                <span>Password</span>
                <input bind:this={passwordEl} bind:value={form.password} type="password" class={field} autocomplete="off" />
              </label>
              <p class="text-xs text-faint">Used for this connection only, not saved.</p>
              <div class="flex justify-center gap-2 pt-1">
                <button type="submit" class={btn} disabled={!form.password || (askUsername && !form.username.trim())}>Connect</button>
                <button type="button" class={btn} onclick={openExternally}>Open in a VNC viewer</button>
              </div>
            </form>
          {:else}
            <p class="font-medium">{phase === 'ended' ? 'The session has ended' : 'Could not connect'}</p>
            {#if phase === 'failed'}{@render stepList(true)}{/if}
            {#if problem}<p class="text-sm text-muted">{problem}</p>{/if}
            <div class="flex flex-wrap justify-center gap-2 pt-1">
              <button type="button" class={btn} onclick={() => connect()}>
                <Icon name="refresh" size={12} />
                Reconnect
              </button>
              <button type="button" class={btn} onclick={openExternally}>Open in a VNC viewer</button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

{#snippet stepList(failed: boolean)}
  <ol class="mx-auto w-72 space-y-2 pt-2 text-left text-sm" aria-label="Connection steps">
    {#each steps as step, i (step.stage)}
      {@const status = stepStatus(steps, stage, i, failed)}
      <li class="flex items-center gap-2.5 {status === 'pending' ? 'text-faint' : status === 'done' ? 'text-muted' : 'text-fg'}" data-status={status}>
        <span class="grid h-4 w-4 shrink-0 place-items-center">
          {#if status === 'done'}
            <span class="step-in text-status-ok"><Icon name="check" size={14} /></span>
          {:else if status === 'active'}
            <span class="spinner h-3.5 w-3.5 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]"></span>
          {:else if status === 'failed'}
            <span class="step-in text-status-crit"><Icon name="close" size={14} /></span>
          {:else}
            <span class="h-1.5 w-1.5 rounded-full bg-[var(--border)]"></span>
          {/if}
        </span>
        <span class="min-w-0 flex-1 truncate">{step.label}</span>
        {#if status === 'active'}
          <span class="shrink-0 text-xs tabular-nums text-faint">{formatElapsed(now - stageSince)}</span>
        {/if}
      </li>
    {/each}
  </ol>
{/snippet}

<style>
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  .step-in {
    animation: pop 0.25s ease-out;
  }
  .connect-bar {
    position: relative;
  }
  .connect-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 40%;
    border-radius: 9999px;
    background: var(--accent);
    animation: sweep 1.4s ease-in-out infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes pop {
    from {
      transform: scale(0.4);
      opacity: 0;
    }
  }
  @keyframes sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner,
    .step-in,
    .connect-bar::after {
      animation: none;
    }
  }
</style>
