import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * The local end of an embedded VNC session: a WebSocket server on 127.0.0.1 that
 * noVNC (in the renderer) connects to, relaying the plain RFB stream to the VNC
 * server — directly or through an SSH channel. Like websockify, but only for
 * sessions registered here: the client connects to `/<token>`, a random one-time
 * token, and the destination is the one registered with it.
 *
 * Unlike RDP there is no TLS to do here: RFB brings its own security types (VNC
 * password, VeNCrypt, …), which noVNC handles itself.
 */

export interface VncGatewayTarget {
  /** Opens the byte stream to the VNC server (a TCP socket or an SSH channel). */
  open(): Promise<Duplex>;
  host: string;
  port: number;
  /** Told as the connection moves on: reaching the server, then signing in (once
   *  the server has answered like a VNC server). */
  onStage?(stage: VncGatewayStage): void;
}

export type VncGatewayStage = 'reach' | 'signin';

/** An RFB server's first words: `RFB 003.008\n`. */
export function isRfbGreeting(chunk: Buffer): boolean {
  return chunk.subarray(0, 4).toString('latin1') === 'RFB ';
}

export class VncGateway {
  private server: WebSocketServer | undefined;
  private port = 0;
  private readonly targets = new Map<string, VncGatewayTarget>();
  /** Why a session failed to connect, for the UI — noVNC only sees the socket close. */
  private readonly failures = new Map<string, string>();

  /** Starts listening, if not yet, and returns the WebSocket URL for `token`. */
  async url(token: string): Promise<string> {
    if (!this.server) {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024 });
      await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve());
        server.once('error', reject);
      });
      server.on('connection', (ws, request) => void this.handle(ws, request));
      this.server = server;
      this.port = (server.address() as { port: number }).port;
    }
    return `ws://127.0.0.1:${this.port}/${token}`;
  }

  /** Registers a session and returns its one-time token. */
  register(target: VncGatewayTarget): string {
    const token = randomBytes(24).toString('base64url');
    this.targets.set(token, target);
    return token;
  }

  revoke(token: string): void {
    this.targets.delete(token);
    this.failures.delete(token);
  }

  failure(token: string): string | undefined {
    return this.failures.get(token);
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.targets.clear();
  }

  private async handle(ws: WebSocket, request: IncomingMessage): Promise<void> {
    ws.binaryType = 'nodebuffer';
    const token = (request.url ?? '').replace(/^\/+/, '').split(/[?#]/)[0];
    const target = token ? this.targets.get(token) : undefined;
    if (!target) {
      ws.close(1008, 'unknown session');
      return;
    }
    // One connection per token: a replayed token gets nothing.
    this.targets.delete(token);

    // What the client sends before the server is reached (nothing, in RFB — the
    // server speaks first) is kept, not lost.
    const early: Buffer[] = [];
    const onEarly = (chunk: Buffer): void => void early.push(chunk);
    ws.on('message', onEarly);

    target.onStage?.('reach');
    let stream: Duplex;
    try {
      stream = await target.open();
    } catch (err) {
      this.failures.set(token, `could not reach ${target.host}:${target.port}: ${(err as Error).message}`);
      ws.close(1011, 'unreachable');
      return;
    }
    ws.off('message', onEarly);
    if (ws.readyState !== ws.OPEN) {
      stream.destroy();
      return;
    }

    const closeBoth = (): void => {
      stream.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    };
    let greeted = false;
    stream.on('data', (chunk: Buffer) => {
      if (!greeted) {
        greeted = true;
        if (!isRfbGreeting(chunk)) {
          this.failures.set(token, `${target.host}:${target.port} did not answer like a VNC server`);
          closeBoth();
          return;
        }
        target.onStage?.('signin');
      }
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    for (const chunk of early) stream.write(chunk);
    ws.on('message', (chunk: Buffer) => {
      if (!stream.destroyed) stream.write(chunk);
    });
    stream.once('end', () => {
      if (!greeted) this.failures.set(token, `${target.host}:${target.port} closed the connection`);
      closeBoth();
    });
    stream.once('close', closeBoth);
    stream.once('error', (err) => {
      if (!this.failures.has(token)) this.failures.set(token, `the connection to ${target.host}:${target.port} failed: ${err.message}`);
      closeBoth();
    });
    ws.once('close', closeBoth);
    ws.once('error', closeBoth);
  }
}
