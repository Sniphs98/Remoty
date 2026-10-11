import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';

import type { SecretCipher } from '../config/secretCipher.js';
import type { Command, Entry, EntryBody, Problem } from './types.js';

/**
 * `ai.sqlite`: the AI helper's problems, their transcripts and the commands proposed in
 * them. SQLite through sql.js (WebAssembly), so there is no native module to rebuild
 * for Electron: the database lives in memory and is written back to disk shortly after
 * every change, whole, the way the config files are. With an OS keystore available
 * (`secretCipher`) the file is encrypted as a whole, like host passwords are — it holds
 * terminal output, which can say more about a server than its config does.
 */

const ENCRYPTED_HEADER = Buffer.from('REMOTY-AI-ENC1\n');
const SAVE_DELAY_MS = 300;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS problems (
  id TEXT PRIMARY KEY,
  host_key TEXT NOT NULL,
  host_label TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  last_session_key TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS problems_by_host ON problems(host_key, updated_at);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_by_problem ON entries(problem_id, seq);
CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  command TEXT NOT NULL,
  explanation TEXT NOT NULL,
  risk TEXT NOT NULL,
  state TEXT NOT NULL,
  output TEXT,
  omitted_lines INTEGER,
  note TEXT,
  ran_at INTEGER
);
CREATE INDEX IF NOT EXISTS commands_by_entry ON commands(entry_id);
`;

type Row = Record<string, SqlValue>;

function str(v: SqlValue): string {
  return v == null ? '' : String(v);
}
function optStr(v: SqlValue): string | undefined {
  return v == null ? undefined : String(v);
}
function optNum(v: SqlValue): number | undefined {
  return v == null ? undefined : Number(v);
}

function toProblem(r: Row): Problem {
  return {
    id: str(r.id),
    hostKey: str(r.host_key),
    hostLabel: str(r.host_label),
    title: str(r.title),
    status: r.status === 'solved' ? 'solved' : 'open',
    systemPrompt: str(r.system_prompt),
    lastSessionKey: optStr(r.last_session_key),
    inputTokens: Number(r.input_tokens ?? 0),
    outputTokens: Number(r.output_tokens ?? 0),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
}

function toEntry(r: Row): Entry {
  const body = JSON.parse(str(r.body)) as EntryBody;
  return { ...body, id: str(r.id), problemId: str(r.problem_id), seq: Number(r.seq), createdAt: Number(r.created_at) };
}

function toCommand(r: Row): Command {
  return {
    id: str(r.id),
    problemId: str(r.problem_id),
    entryId: str(r.entry_id),
    callId: str(r.call_id),
    command: str(r.command),
    explanation: str(r.explanation),
    risk: r.risk === 'danger' ? 'danger' : r.risk === 'caution' ? 'caution' : 'safe',
    state: (['proposed', 'ran', 'skipped', 'invalid'] as const).find((s) => s === r.state) ?? 'invalid',
    output: optStr(r.output),
    omittedLines: optNum(r.omitted_lines),
    note: optStr(r.note),
    ranAt: optNum(r.ran_at)
  };
}

function wasmBinary(): ArrayBuffer {
  const bytes = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class AiStore {
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  private constructor(
    private readonly db: Database,
    private readonly file: string,
    private readonly cipher: SecretCipher
  ) {}

  /** Opens (or starts) the database at `file`. A file this machine can't decrypt any
   *  more (copied from another user, OS key reset) is set aside, not deleted, and a
   *  fresh database starts in its place — the app keeps working either way. */
  static async open(file: string, cipher: SecretCipher): Promise<AiStore> {
    const SQL = await initSqlJs({ wasmBinary: wasmBinary() });
    let bytes: Uint8Array | undefined;
    if (existsSync(file)) {
      try {
        bytes = AiStore.decode(readFileSync(file), cipher);
      } catch {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      }
    }
    const db = new SQL.Database(bytes);
    db.run('PRAGMA foreign_keys = ON;');
    db.run(SCHEMA);
    return new AiStore(db, file, cipher);
  }

  private static decode(raw: Buffer, cipher: SecretCipher): Uint8Array {
    if (raw.subarray(0, ENCRYPTED_HEADER.length).equals(ENCRYPTED_HEADER)) {
      return Buffer.from(cipher.decrypt(raw.subarray(ENCRYPTED_HEADER.length)), 'base64');
    }
    return raw;
  }

  private encode(bytes: Uint8Array): Buffer {
    if (!this.cipher.available) return Buffer.from(bytes);
    return Buffer.concat([ENCRYPTED_HEADER, this.cipher.encrypt(Buffer.from(bytes).toString('base64'))]);
  }

  private all(sql: string, params: SqlValue[] = []): Row[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows: Row[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Row);
      return rows;
    } finally {
      stmt.free();
    }
  }

  private run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  /** Writes pending changes now (also called on quit). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, this.encode(this.db.export()));
    try {
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.file, 0o600);
      } catch {
        // Best effort, like the config files.
      }
    }
  }

  close(): void {
    this.flush();
    this.db.close();
  }

  // ── problems ────────────────────────────────────────────────────────────────

  createProblem(p: Pick<Problem, 'hostKey' | 'hostLabel' | 'title' | 'systemPrompt'>): Problem {
    const now = Date.now();
    const id = randomUUID();
    this.run(
      `INSERT INTO problems (id, host_key, host_label, title, status, system_prompt, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      [id, p.hostKey, p.hostLabel, p.title, p.systemPrompt, now, now]
    );
    return this.problem(id)!;
  }

  problem(id: string): Problem | undefined {
    const [row] = this.all('SELECT * FROM problems WHERE id = ?', [id]);
    return row ? toProblem(row) : undefined;
  }

  /** Most recently active first; all hosts when `hostKey` is omitted. */
  problems(hostKey?: string): Problem[] {
    const rows =
      hostKey === undefined
        ? this.all('SELECT * FROM problems ORDER BY updated_at DESC')
        : this.all('SELECT * FROM problems WHERE host_key = ? ORDER BY updated_at DESC', [hostKey]);
    return rows.map(toProblem);
  }

  updateProblem(id: string, patch: Partial<Pick<Problem, 'title' | 'status' | 'lastSessionKey'>>): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      params.push(patch.title);
    }
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.lastSessionKey !== undefined) {
      sets.push('last_session_key = ?');
      params.push(patch.lastSessionKey);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(Date.now(), id);
    this.run(`UPDATE problems SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  addUsage(id: string, inputTokens: number, outputTokens: number): void {
    this.run('UPDATE problems SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?', [
      inputTokens,
      outputTokens,
      id
    ]);
  }

  deleteProblem(id: string): void {
    this.run('DELETE FROM problems WHERE id = ?', [id]);
  }

  // ── transcript ──────────────────────────────────────────────────────────────

  appendEntry(problemId: string, body: EntryBody): Entry {
    const [{ next }] = this.all('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM entries WHERE problem_id = ?', [problemId]);
    const id = randomUUID();
    const now = Date.now();
    this.run('INSERT INTO entries (id, problem_id, seq, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      problemId,
      Number(next),
      body.kind,
      JSON.stringify(body),
      now
    ]);
    this.run('UPDATE problems SET updated_at = ? WHERE id = ?', [now, problemId]);
    return { ...body, id, problemId, seq: Number(next), createdAt: now };
  }

  entries(problemId: string): Entry[] {
    return this.all('SELECT * FROM entries WHERE problem_id = ? ORDER BY seq', [problemId]).map(toEntry);
  }

  // ── commands ────────────────────────────────────────────────────────────────

  addCommand(c: Omit<Command, 'id'>): Command {
    const id = randomUUID();
    this.run(
      `INSERT INTO commands (id, problem_id, entry_id, call_id, command, explanation, risk, state, output, omitted_lines, note, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        c.problemId,
        c.entryId,
        c.callId,
        c.command,
        c.explanation,
        c.risk,
        c.state,
        c.output ?? null,
        c.omittedLines ?? null,
        c.note ?? null,
        c.ranAt ?? null
      ]
    );
    return { ...c, id };
  }

  command(id: string): Command | undefined {
    const [row] = this.all('SELECT * FROM commands WHERE id = ?', [id]);
    return row ? toCommand(row) : undefined;
  }

  /** In the order they were proposed. */
  commands(problemId: string): Command[] {
    return this.all(
      `SELECT c.* FROM commands c JOIN entries e ON e.id = c.entry_id WHERE c.problem_id = ? ORDER BY e.seq, c.rowid`,
      [problemId]
    ).map(toCommand);
  }

  updateCommand(id: string, patch: Pick<Command, 'state'> & Partial<Pick<Command, 'output' | 'omittedLines' | 'note' | 'ranAt'>>): void {
    this.run('UPDATE commands SET state = ?, output = ?, omitted_lines = ?, note = ?, ran_at = ? WHERE id = ?', [
      patch.state,
      patch.output ?? null,
      patch.omittedLines ?? null,
      patch.note ?? null,
      patch.ranAt ?? null,
      id
    ]);
  }
}
