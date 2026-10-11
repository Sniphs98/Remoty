import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';

import type { ChatgptLogin } from '../ai/chatgptAuth.js';
import type { AiProviderId } from '../ai/types.js';
import { readSecretCached } from '../secrets/onePassword.js';
import { appConfigDir } from './platform.js';
import { getSecretCipher } from './secretCipher.js';
import { decryptSecret, encryptSecret } from './secretField.js';

/**
 * `ai.toml`: which AI provider the terminal's AI helper uses and how it signs in — per
 * API provider, an API key kept here (encrypted the same way as host passwords) or a
 * 1Password reference read when needed; the reference wins when both are set. The CLI
 * providers sign in on their own (`claude auth login`, `codex login`); here they only
 * have an optional path to the program.
 */

export const AI_PROVIDERS: readonly AiProviderId[] = ['anthropic', 'openai', 'claude-cli', 'codex-cli', 'chatgpt'];

/** Empty: the CLI's own default, which follows the user's plan. */
export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.5',
  'claude-cli': '',
  'codex-cli': '',
  chatgpt: 'gpt-5.5'
};

export interface AiProviderSettings {
  apiKey?: string;
  apiKeyRef?: string;
  /** Empty means `DEFAULT_MODELS[provider]`. */
  model?: string;
  /** CLI providers: where the program is, when it is not on PATH. */
  path?: string;
  /** `chatgpt`: the sign-in (its refresh token kept encrypted). */
  login?: ChatgptLogin;
}

export interface AiSettings {
  provider: AiProviderId;
  /** After a proposed command ran, send its output to the model straight away. */
  replyToResult: boolean;
  /** Per command: longer output keeps its first and last lines. */
  maxOutputLines: number;
  anthropic: AiProviderSettings;
  openai: AiProviderSettings;
  'claude-cli': AiProviderSettings;
  'codex-cli': AiProviderSettings;
  chatgpt: AiProviderSettings;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'anthropic',
  replyToResult: true,
  maxOutputLines: 200,
  anthropic: {},
  openai: {},
  'claude-cli': {},
  'codex-cli': {},
  chatgpt: {}
};

function path(): string {
  return join(appConfigDir(), 'ai.toml');
}

function providerFrom(raw: unknown): AiProviderSettings {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const cipher = getSecretCipher();
  return {
    apiKey: typeof r.apiKey === 'string' ? decryptSecret(r.apiKey, cipher) : undefined,
    apiKeyRef: typeof r.apiKeyRef === 'string' && r.apiKeyRef.trim() ? r.apiKeyRef : undefined,
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined,
    path: typeof r.path === 'string' && r.path.trim() ? r.path.trim() : undefined,
    login: loginFrom(r.login)
  };
}

function loginFrom(raw: unknown): ChatgptLogin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const refreshToken = typeof r.refreshToken === 'string' ? decryptSecret(r.refreshToken, getSecretCipher()) : undefined;
  if (!refreshToken || typeof r.accountId !== 'string' || !r.accountId) return undefined;
  return {
    refreshToken,
    accountId: r.accountId,
    ...(typeof r.email === 'string' ? { email: r.email } : {}),
    ...(typeof r.plan === 'string' ? { plan: r.plan } : {})
  };
}

function providerTo(s: AiProviderSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.apiKey) out.apiKey = encryptSecret(s.apiKey, getSecretCipher());
  if (s.apiKeyRef) out.apiKeyRef = s.apiKeyRef;
  if (s.model) out.model = s.model;
  if (s.path) out.path = s.path;
  if (s.login) {
    out.login = {
      refreshToken: encryptSecret(s.login.refreshToken, getSecretCipher()),
      accountId: s.login.accountId,
      ...(s.login.email ? { email: s.login.email } : {}),
      ...(s.login.plan ? { plan: s.login.plan } : {})
    };
  }
  return out;
}

export function isAiProvider(value: unknown): value is AiProviderId {
  return AI_PROVIDERS.includes(value as AiProviderId);
}

export async function loadAiSettings(): Promise<AiSettings> {
  if (!existsSync(path())) return structuredClone(DEFAULT_AI_SETTINGS);
  const raw = parse(await readFile(path(), 'utf-8')) as Record<string, unknown>;
  const lines = Number(raw.maxOutputLines);
  return {
    provider: isAiProvider(raw.provider) ? raw.provider : DEFAULT_AI_SETTINGS.provider,
    replyToResult: typeof raw.replyToResult === 'boolean' ? raw.replyToResult : DEFAULT_AI_SETTINGS.replyToResult,
    maxOutputLines: Number.isFinite(lines) && lines >= 20 ? Math.floor(lines) : DEFAULT_AI_SETTINGS.maxOutputLines,
    anthropic: providerFrom(raw.anthropic),
    openai: providerFrom(raw.openai),
    'claude-cli': providerFrom(raw['claude-cli']),
    'codex-cli': providerFrom(raw['codex-cli']),
    chatgpt: providerFrom(raw.chatgpt)
  };
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await mkdir(appConfigDir(), { recursive: true });
  const out = {
    provider: settings.provider,
    replyToResult: settings.replyToResult,
    maxOutputLines: settings.maxOutputLines,
    anthropic: providerTo(settings.anthropic),
    openai: providerTo(settings.openai),
    'claude-cli': providerTo(settings['claude-cli']),
    'codex-cli': providerTo(settings['codex-cli']),
    chatgpt: providerTo(settings.chatgpt)
  };
  const tmp = `${path()}.tmp`;
  await writeFile(tmp, stringify(out), 'utf-8');
  try {
    await rename(tmp, path());
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') await chmod(path(), 0o600).catch(() => {});
}

export function modelFor(settings: AiSettings, provider: AiProviderId = settings.provider): string {
  return settings[provider].model || DEFAULT_MODELS[provider];
}

const PROVIDER_NAMES: Record<AiProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
  chatgpt: 'ChatGPT'
};

/** The provider's API key, from 1Password or as stored. */
export async function resolveAiKey(settings: AiSettings, provider: AiProviderId = settings.provider): Promise<string> {
  const s = settings[provider];
  if (s.apiKeyRef) return readSecretCached(s.apiKeyRef);
  if (s.apiKey) return s.apiKey;
  throw new Error(`no ${PROVIDER_NAMES[provider]} API key yet — add one in Settings → AI`);
}
