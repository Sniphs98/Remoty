import { createServer, connect, type Server, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { isRfbGreeting, VncGateway, type VncGatewayStage } from './gateway.js';

let gateway: VncGateway | undefined;
let server: Server | undefined;

afterEach(() => {
  gateway?.close();
  server?.close();
  gateway = undefined;
  server = undefined;
});

/** A stand-in VNC server: greets with `greeting`, then echoes what it gets. */
async function fakeServer(greeting: string): Promise<number> {
  server = createServer((socket) => {
    socket.write(greeting);
    socket.on('data', (d) => socket.write(d));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function target(port: number, stages: VncGatewayStage[] = []) {
  return {
    host: '127.0.0.1',
    port,
    onStage: (s: VncGatewayStage) => stages.push(s),
    open: () =>
      new Promise<import('node:stream').Duplex>((resolve, reject) => {
        const s = connect({ host: '127.0.0.1', port });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      })
  };
}

function messages(ws: WebSocket, count: number): Promise<string[]> {
  const got: string[] = [];
  return new Promise((resolve) => {
    ws.on('message', (d: Buffer) => {
      got.push(d.toString());
      if (got.length === count) resolve(got);
    });
  });
}

const closed = (ws: WebSocket): Promise<void> => new Promise((resolve) => ws.once('close', () => resolve()));

describe('isRfbGreeting', () => {
  it('knows an RFB version line', () => {
    expect(isRfbGreeting(Buffer.from('RFB 003.008\n'))).toBe(true);
    expect(isRfbGreeting(Buffer.from('SSH-2.0-OpenSSH'))).toBe(false);
  });
});

describe('VncGateway', () => {
  it('relays a registered session both ways', async () => {
    const port = await fakeServer('RFB 003.008\n');
    gateway = new VncGateway();
    const stages: VncGatewayStage[] = [];
    const token = gateway.register(target(port, stages));
    const ws = new WebSocket(await gateway.url(token));
    const got = messages(ws, 2);
    await new Promise((resolve) => ws.once('open', resolve));
    // After the greeting arrived, so the echo comes as a message of its own.
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(Buffer.from('RFB 003.008\n'));
    expect(await got).toEqual(['RFB 003.008\n', 'RFB 003.008\n']);
    expect(stages).toEqual(['reach', 'signin']);
    ws.close();
  });

  it('turns away an unknown token, and a token used twice', async () => {
    const port = await fakeServer('RFB 003.008\n');
    gateway = new VncGateway();
    const token = gateway.register(target(port));
    const url = await gateway.url(token);

    const first = new WebSocket(url);
    await new Promise((resolve) => first.once('open', resolve));
    const again = new WebSocket(url);
    await closed(again);
    const unknown = new WebSocket(url.replace(token, 'nope'));
    await closed(unknown);
    first.close();
  });

  it('says why when the server is not a VNC server', async () => {
    const port = await fakeServer('SSH-2.0-OpenSSH_9.6\r\n');
    gateway = new VncGateway();
    const token = gateway.register(target(port));
    const ws = new WebSocket(await gateway.url(token));
    await closed(ws);
    expect(gateway.failure(token)).toMatch(/did not answer like a VNC server/);
  });

  it('says why when the server cannot be reached', async () => {
    gateway = new VncGateway();
    const token = gateway.register({ ...target(1), open: () => Promise.reject(new Error('ECONNREFUSED')) });
    const ws = new WebSocket(await gateway.url(token));
    await closed(ws);
    expect(gateway.failure(token)).toMatch(/could not reach 127\.0\.0\.1:1: ECONNREFUSED/);
  });
});
