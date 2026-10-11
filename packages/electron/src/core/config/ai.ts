import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';

import type { AiProviderId } from '../ai/types.js';
import { readSecretCached } from '../secrets/onePassword.js';
import { appConfigDir } from './platform.js';
import { getSecretCipher } from './secretCipher.js';
import { decryptSecret, encryptSecret } from './secretField.js';

/**
 * `ai.toml`: which AI provider the terminal's AI helper uses and how it signs in — per
 * provider, an API key kept here (encrypted the same way as host passwords) or a
 * 1Password reference read when needed; the reference wins when both are set.
 */

export const DEFAULT_MODELS: Record<AiProviderId, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.5'
};

export interface AiProviderSettings {
  apiKey?: string;
  apiKeyRef?: string;
  /** Empty means `DEFAULT_MODELS[provider]`. */
  model?: string;
}

export interface AiSettings {
  provider: AiProviderId;
  /** After a proposed command ran, send its output to the model straight away. */
  replyToResult: boolean;
  /** Per command: longer output keeps its first and last lines. */
  maxOutputLines: number;
  anthropic: AiProviderSettings;
  openai: AiProviderSettings;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'anthropic',
  replyToResult: true,
  maxOutputLines: 200,
  anthropic: {},
  openai: {}
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
    model: typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined
  };
}

function providerTo(s: AiProviderSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.apiKey) out.apiKey = encryptSecret(s.apiKey, getSecretCipher());
  if (s.apiKeyRef) out.apiKeyRef = s.apiKeyRef;
  if (s.model) out.model = s.model;
  return out;
}

export function isAiProvider(value: unknown): value is AiProviderId {
  return value === 'anthropic' || value === 'openai';
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
    openai: providerFrom(raw.openai)
  };
}

export async function saveAiSettings(settings: AiSettings): Promise<void> {
  await mkdir(appConfigDir(), { recursive: true });
  const out = {
    provider: settings.provider,
    replyToResult: settings.replyToResult,
    maxOutputLines: settings.maxOutputLines,
    anthropic: providerTo(settings.anthropic),
    openai: providerTo(settings.openai)
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

const PROVIDER_NAMES: Record<AiProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/** The provider's API key, from 1Password or as stored. */
export async function resolveAiKey(settings: AiSettings, provider: AiProviderId = settings.provider): Promise<string> {
  const s = settings[provider];
  if (s.apiKeyRef) return readSecretCached(s.apiKeyRef);
  if (s.apiKey) return s.apiKey;
  throw new Error(`no ${PROVIDER_NAMES[provider]} API key yet — add one in Settings → AI`);
}
