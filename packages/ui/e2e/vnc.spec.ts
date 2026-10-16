import { expect, test, type Page } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

// VNC in the Remote Desktop area: a profile made with the protocol switch, then opened
// in a tab where noVNC really connects — to a tiny RFB server in this test standing in
// for the main process's gateway and a VNC server behind it. It asks for a VNC
// password, so the tab's sign-in form is exercised too. (Checking the DES response
// would need OpenSSL's legacy provider, so the server turns down the first attempt
// and takes the second instead.)

type Rec = Record<string, unknown>;

/** A minimal RFB 3.8 server: VNC authentication that fails the first time and succeeds
 *  the next, then a 64×48 desktop. */
async function fakeVncServer(): Promise<{ url: string; signedIn: () => boolean; close: () => void }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let signedIn = false;
  let attempts = 0;
  wss.on('connection', (ws: WebSocket) => {
    let buf = Buffer.alloc(0);
    let step = 0;
    const take = (n: number): Buffer | undefined => {
      if (buf.length < n) return undefined;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };
    ws.send(Buffer.from('RFB 003.008\n'));
    ws.on('message', (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      for (;;) {
        if (step === 0 && take(12)) {
          ws.send(Buffer.from([1, 2])); // one security type: VNC authentication
          step = 1;
        } else if (step === 1 && take(1)) {
          ws.send(Buffer.alloc(16, 7)); // the challenge
          step = 2;
        } else if (step === 2) {
          if (!take(16)) return;
          if (++attempts === 1) {
            const reason = Buffer.from('Authentication failed');
            const head = Buffer.alloc(8);
            head.writeUInt32BE(1, 0);
            head.writeUInt32BE(reason.length, 4);
            ws.send(Buffer.concat([head, reason]));
            ws.close();
            return;
          }
          ws.send(Buffer.from([0, 0, 0, 0]));
          step = 3;
        } else if (step === 3 && take(1)) {
          const name = Buffer.from('test desktop');
          const init = Buffer.alloc(24);
          init.writeUInt16BE(64, 0);
          init.writeUInt16BE(48, 2);
          // 32 bpp, depth 24, little-endian, true colour, 255/255/255, shifts 16/8/0.
          Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
          init.writeUInt32BE(name.length, 20);
          ws.send(Buffer.concat([init, name]));
          signedIn = true;
          step = 4;
        } else {
          // Past sign-in: the client's messages are ignored.
          if (step === 4) buf = Buffer.alloc(0);
          return;
        }
      }
    });
  });
  const { port } = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/token`, signedIn: () => signedIn, close: () => wss.close() };
}

async function boot(page: Page, opts: { connections?: Rec[]; vncUrl?: string } = {}): Promise<void> {
  await page.addInitScript(({ connections, vncUrl }) => {
    const win = window as unknown as Record<string, unknown>;
    const state: { connections: Rec[] } = { connections: (connections ?? []).map((c) => ({ ...c })) };
    win.__saved = [] as unknown[];
    win.__vncLaunchCalls = [] as unknown[];
    win.remoty = {
      invoke: (channel: string, ...rawArgs: unknown[]) => {
        const args = rawArgs.map((a) => structuredClone(a));
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve([]);
          case 'list_remote_desktop_connections':
            return Promise.resolve([...state.connections]);
          case 'save_remote_desktop_connection': {
            const c = args[0] as Rec & { password?: string };
            (win.__saved as unknown[]).push(c);
            const stored = { ...c, hasPassword: Boolean(c.password) };
            delete (stored as Rec).password;
            state.connections = [...state.connections.filter((x) => x.id !== c.id), stored];
            return Promise.resolve(null);
          }
          case 'vnc_embedded_open':
            return Promise.resolve({ token: 'token', url: vncUrl });
          case 'vnc_embedded_status':
            return Promise.resolve({});
          case 'vnc_launch':
            (win.__vncLaunchCalls as unknown[]).push(args[0]);
            return Promise.resolve({});
          default:
            return Promise.resolve(null);
        }
      },
      on: () => () => {},
      settings: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() },
      openExternal: () => Promise.resolve(),
      homeDir: () => Promise.resolve('/home/user'),
      getPathForFile: () => ''
    };
  }, opts);
  await page.goto('/');
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
}

test('a VNC connection is made with the protocol switch, with its own settings', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'New connection' }).first().click();
  let editor = page.getByRole('dialog', { name: 'New RDP connection' });
  await editor.getByRole('radio', { name: 'VNC' }).click();
  editor = page.getByRole('dialog', { name: 'New VNC connection' });

  // RDP's domain and display & devices give way to the viewer's settings.
  await expect(editor.getByLabel('Domain')).toHaveCount(0);
  await expect(editor.getByText('Display & devices')).toHaveCount(0);
  await expect(editor.getByRole('textbox', { name: 'Port' })).toHaveAttribute('placeholder', '5900');

  await editor.getByLabel('Name', { exact: true }).fill('raspberry');
  await editor.getByLabel('Hostname / IP').fill('10.0.0.42');
  await editor.getByRole('switch', { name: 'View only' }).click();
  await editor.getByRole('button', { name: 'Add connection' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const saved = await page.evaluate(() => (window as unknown as { __saved: Rec[] }).__saved[0]);
  expect(saved).toMatchObject({ protocol: 'vnc', hostname: '10.0.0.42', port: 5900, viewOnly: true, clipboard: true });
  expect(saved.drives).toBeUndefined();
  await expect(page.getByText('10.0.0.42:5900')).toBeVisible();
  await expect(page.getByText('View only', { exact: true })).toBeVisible();

  // External: the OS's VNC viewer, not the Remote Desktop app.
  await page.getByRole('button', { name: 'Open raspberry in a VNC viewer' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vncLaunchCalls: unknown[] }).__vncLaunchCalls.length)).toBe(1);
});

test('Connect opens a VNC tab that asks for the password the server wants, then shows the desktop', async ({ page }) => {
  const server = await fakeVncServer();
  try {
    await boot(page, {
      vncUrl: server.url,
      connections: [{ id: 'v1', name: 'raspberry', protocol: 'vnc', hostname: '10.0.0.42', port: 5900, hasPassword: false }]
    });
    await page.getByRole('button', { name: 'Connect to raspberry' }).click();

    // No password saved: the server asks, and the tab asks the user (just a password —
    // plain VNC authentication has no user name).
    await page.getByLabel('Password').fill('wrong');
    await expect(page.getByLabel('Username')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('The server refused to sign in: Authentication failed.')).toBeVisible();

    // Reconnecting asks again, rather than retrying the wrong one.
    await page.getByRole('button', { name: 'Reconnect' }).first().click();
    await page.getByLabel('Password').fill('secret');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    expect(server.signedIn()).toBe(true);
    // noVNC's canvas is in the tab.
    await expect(page.locator('.vnc-viewport canvas')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Ctrl+Alt+Del' })).toBeVisible();
  } finally {
    server.close();
  }
});
