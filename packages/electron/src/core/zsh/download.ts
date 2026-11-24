import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type Fetch = typeof fetch;

export interface CachedFile {
  path: string;
  fromCache: boolean;
}

async function isGzip(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

export async function fetchToCache(
  url: string,
  dest: string,
  opts: { refresh: boolean; label: string },
  fetchImpl: Fetch = fetch
): Promise<CachedFile> {
  const cached = existsSync(dest) && (await isGzip(dest));
  if (cached && !opts.refresh) return { path: dest, fromCache: true };

  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'Remoty' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('the download is not a .tar.gz file');
    await mkdir(dirname(dest), { recursive: true });
    const partial = `${dest}.part`;
    await writeFile(partial, bytes);
    await rename(partial, dest);
    return { path: dest, fromCache: false };
  } catch (err) {
    await rm(`${dest}.part`, { force: true });
    if (cached) return { path: dest, fromCache: true };
    throw new Error(`could not download ${opts.label} (${(err as Error).message}) — this computer needs internet once, after that the copy it keeps is used`);
  }
}
