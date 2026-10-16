# VNC test target

A Debian desktop (XFCE) with a VNC server, for trying Remoty's VNC connections — in a
tab and in an external viewer — against a real server. It is
[consol/debian-xfce-vnc](https://github.com/ConSol/docker-headless-vnc-container):
small, starts in seconds, and keeps nothing between runs.

## Start it

From the repo root:

```bash
docker compose -f docker/vnc-test-target/compose.yml up -d
```

The first start downloads the image (about 1 GB). Stop it with
`docker compose -f docker/vnc-test-target/compose.yml down`.

## Add it in Remoty

Remote Desktop → New connection, protocol **VNC**:

| Field | Value |
|---|---|
| Hostname / IP | `127.0.0.1` |
| Port | `15901` |
| Password | `remoty` |

Not port 5900 or 5901: those may be this machine's own VNC server. There's no user name
— VNC password sign-in has none — and only the first 8 characters of a VNC password count.

To compare with a viewer that's known to work, the image has its own in the browser:
<http://127.0.0.1:16901/vnc.html?password=remoty>.

### Through an SSH tunnel

To try "Connect: Through SSH host", start the SSH test target too (`docker compose up -d`
at the repo root) and add it as an SSH host (see `docker/ssh-test-target/README.md`).
Then make the VNC connection with

| Field | Value |
|---|---|
| Connect | Through SSH host *(the test target)* |
| Hostname / IP | `host.docker.internal` |
| Port | `15901` |

— the address as the SSH container sees it: Docker's name for this machine, where this
container's port is published.

## Never expose it

The ports are bound to `127.0.0.1` only, and the password is fixed and public. Keep it
that way.
