import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { shell, type IpcMain } from 'electron';

import { loadRemoteDesktopConnections, type RemoteDesktopConnection } from '../core/config/remoteDesktop.js';
import { resolveConnection } from '../core/rdp/password.js';
import { openTunnel, type RdpTunnel } from '../core/rdp/tunnel.js';
import { SshSession } from '../core/ssh/session.js';
import { VncGateway } from '../core/vnc/gateway.js';
import {
  toCommandError,
  type RdpConnectProgressDto,
  type RdpConnectStageDto,
  type VncEmbeddedSessionDto,
  type VncEmbeddedStatusDto,
  type VncLaunchResultDto
} from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * VNC, inside the app and outside it. In a tab the renderer runs noVNC, which
 * connects through `VncGateway` on 127.0.0.1 (`vnc_embedded_open` registers the
 * session); `vnc_launch` hands a `vnc://` address to whatever viewer the OS has for
 * it (Screen Sharing on macOS, TigerVNC/RealVNC/Remmina elsewhere). Either way a
 * profile with `viaHost` goes through an SSH tunnel.
 */

const gateway = new VncGateway();

const open = new Map<string, { ssh?: SshSession }>();
/** Tunnels of external viewers still open, for `before-quit`. */
const openTunnels = new Set<RdpTunnel>();

function openTcp(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setNoDelay(true);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function vncConnection(connectionId: string): Promise<RemoteDesktopConnection> {
  const saved = (await loadRemoteDesktopConnections()).find((c) => c.id === connectionId);
  if (!saved) throw new Error(`unknown remote desktop connection '${connectionId}'`);
  if (saved.protocol !== 'vnc') throw new Error(`connection '${saved.name}' is not a VNC connection`);
  return saved;
}

async function sshFor(state: GuiState, viaHost: string): Promise<SshSession> {
  const host = state.hostByName(viaHost);
  if (!host) throw new Error(`SSH host '${viaHost}' to tunnel through no longer exists`);
  try {
    return await SshSession.connect(host);
  } catch (err) {
    throw new Error(`Could not connect to SSH host '${host.name}' for the tunnel: ${(err as Error).message}`);
  }
}

/** The `vnc://` address an external viewer opens. The password never goes in it: the
 *  viewer asks for it. */
export function vncUrl(c: { hostname: string; port: number; username?: string }): string {
  const host = c.hostname.includes(':') ? `[${c.hostname}]` : c.hostname;
  const user = c.username ? `${encodeURIComponent(c.username)}@` : '';
  return `vnc://${user}${host}:${c.port}`;
}

export function registerVncIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle(
    'vnc_embedded_open',
    async (_event, connectionId: string, progressKey?: string): Promise<VncEmbeddedSessionDto> => {
      const progress = (stage: RdpConnectStageDto): void => {
        if (progressKey) state.emit('rdp-connect-progress', { key: progressKey, stage } satisfies RdpConnectProgressDto);
      };
      try {
        const saved = await vncConnection(connectionId);
        progress('onePassword');
        const connection = await resolveConnection(saved);

        let ssh: SshSession | undefined;
        if (connection.viaHost) {
          progress('tunnel');
          ssh = await sshFor(state, connection.viaHost);
        }
        const token = gateway.register({
          host: connection.hostname,
          port: connection.port,
          onStage: progress,
          open: () => (ssh ? ssh.forward(connection.hostname, connection.port) : openTcp(connection.hostname, connection.port))
        });
        open.set(token, { ssh });
        return {
          token,
          url: await gateway.url(token),
          // Handed to noVNC up front so it signs in by itself; without them it asks.
          username: connection.username,
          password: connection.password
        };
      } catch (err) {
        throw toCommandError(err);
      }
    }
  );

  ipcMain.handle('vnc_embedded_status', (_event, token: string): VncEmbeddedStatusDto => ({ failure: gateway.failure(token) }));

  ipcMain.handle('vnc_embedded_close', (_event, token: string) => {
    closeSession(token);
  });

  ipcMain.handle('vnc_launch', async (_event, connectionId: string): Promise<VncLaunchResultDto> => {
    try {
      const connection = await resolveConnection(await vncConnection(connectionId));
      let target = { hostname: connection.hostname, port: connection.port, username: connection.username };
      let tunnel: RdpTunnel | undefined;
      if (connection.viaHost) {
        // 127.0.0.1 everywhere: unlike mstsc, VNC viewers file nothing by address.
        tunnel = await openTunnel(await sshFor(state, connection.viaHost), { host: connection.hostname, port: connection.port }, '127.0.0.1');
        openTunnels.add(tunnel);
        void tunnel.closed.then(() => openTunnels.delete(tunnel!));
        target = { ...target, hostname: tunnel.address, port: tunnel.port };
      }
      try {
        await shell.openExternal(vncUrl(target));
      } catch (err) {
        tunnel?.close();
        throw new Error(`No VNC viewer could open ${connection.name} (${(err as Error).message}). Install one, such as TigerVNC or RealVNC Viewer.`);
      }
      return {
        notice: connection.password ? 'The VNC viewer asks for the password itself — it is not handed over.' : undefined
      };
    } catch (err) {
      throw toCommandError(err);
    }
  });
}

function closeSession(token: string): void {
  gateway.revoke(token);
  open.get(token)?.ssh?.disconnect();
  open.delete(token);
}

/** For `before-quit`. */
export function closeVnc(): void {
  for (const token of [...open.keys()]) closeSession(token);
  for (const tunnel of openTunnels) tunnel.close();
  gateway.close();
}
