import { join } from 'node:path';
import type { IpcMain } from 'electron';

import { anthropicBackend } from '../core/ai/anthropic.js';
import { AiEngine, entryView, errorMessage, problemView, type EngineEvent, type EntryView, type ProblemView } from '../core/ai/engine.js';
import { openaiBackend } from '../core/ai/openai.js';
import { AiStore } from '../core/ai/store.js';
import type { AiProviderId, Command, CommandReport, ProblemStatus, ShellContext } from '../core/ai/types.js';
import {
  DEFAULT_MODELS,
  type AiSettings,
  isAiProvider,
  loadAiSettings,
  modelFor,
  resolveAiKey,
  saveAiSettings
} from '../core/config/ai.js';
import { appConfigDir } from '../core/config/platform.js';
import { getSecretCipher } from '../core/config/secretCipher.js';
import { isSecretReference, normalizeReference } from '../core/secrets/onePassword.js';
import { toCommandError } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * The terminal's AI helper (docs/concepts/ai-integration.md): settings, the problems
 * kept in `ai.sqlite`, and their conversations. Answers stream to the renderer as
 * `ai-event`s. API keys never go to the renderer — only whether one is stored.
 */

export interface AiProviderSettingsDto {
  hasKey: boolean;
  keyRef?: string;
  model?: string;
  defaultModel: string;
}

export interface AiSettingsDto {
  provider: AiProviderId;
  replyToResult: boolean;
  maxOutputLines: number;
  anthropic: AiProviderSettingsDto;
  openai: AiProviderSettingsDto;
}

export interface AiProviderSettingsInputDto {
  /** A new key; omitted keeps the stored one. */
  key?: string;
  clearKey?: boolean;
  /** A 1Password reference to read the key from; '' means none. */
  keyRef?: string;
  /** '' means the default model. */
  model?: string;
}

export interface AiSettingsInputDto {
  provider: AiProviderId;
  replyToResult: boolean;
  maxOutputLines?: number;
  anthropic?: AiProviderSettingsInputDto;
  openai?: AiProviderSettingsInputDto;
}

export interface AiProblemDetailDto {
  problem: ProblemView;
  entries: EntryView[];
  commands: Command[];
  running: boolean;
}

let storePromise: Promise<AiStore> | undefined;
let opened: AiStore | undefined;
let engine: AiEngine | undefined;

function store(): Promise<AiStore> {
  storePromise ??= AiStore.open(join(appConfigDir(), 'ai.sqlite'), getSecretCipher()).then((s) => (opened = s));
  return storePromise;
}

/** Stops running answers and writes the database out, synchronously. Called on quit. */
export function closeAi(): void {
  engine?.cancelAll();
  try {
    opened?.flush();
  } catch {
    // Quitting anyway; at most the last few changes are lost.
  }
}

function settingsDto(s: AiSettings): AiSettingsDto {
  const provider = (id: AiProviderId): AiProviderSettingsDto => ({
    hasKey: Boolean(s[id].apiKey),
    keyRef: s[id].apiKeyRef,
    model: s[id].model,
    defaultModel: DEFAULT_MODELS[id]
  });
  return {
    provider: s.provider,
    replyToResult: s.replyToResult,
    maxOutputLines: s.maxOutputLines,
    anthropic: provider('anthropic'),
    openai: provider('openai')
  };
}

function applyProvider(current: AiSettings[AiProviderId], input: AiProviderSettingsInputDto | undefined): AiSettings[AiProviderId] {
  if (!input) return current;
  const keyRef = input.keyRef === undefined ? current.apiKeyRef : normalizeReference(input.keyRef) || undefined;
  if (keyRef && !isSecretReference(keyRef)) throw new Error('1Password reference must look like op://vault/item/field');
  return {
    apiKey: input.clearKey ? undefined : input.key?.trim() || current.apiKey,
    apiKeyRef: keyRef,
    model: input.model === undefined ? current.model : input.model.trim() || undefined
  };
}

/** Wraps a handler so its errors reach the renderer as messages. */
function handle<A extends unknown[], R>(fn: (...args: A) => Promise<R> | R): (_e: unknown, ...args: A) => Promise<R> {
  return async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw toCommandError(err);
    }
  };
}

export function registerAiIpc(ipcMain: IpcMain, state: GuiState): void {
  async function aiEngine(): Promise<AiEngine> {
    if (engine) return engine;
    const s = await store();
    engine ??= new AiEngine({
      store: s,
      settings: loadAiSettings,
      apiKey: resolveAiKey,
      backends: { anthropic: anthropicBackend, openai: openaiBackend },
      secretsFor: (hostKey) => {
        const password = state.hostByName(hostKey)?.password;
        return password ? [password] : [];
      },
      emit: (event: EngineEvent) => state.emit('ai-event', event)
    });
    return engine;
  }

  ipcMain.handle('ai_settings', handle(async () => settingsDto(await loadAiSettings())));

  ipcMain.handle(
    'ai_save_settings',
    handle(async (input: AiSettingsInputDto) => {
      const current = await loadAiSettings();
      const lines = Number(input.maxOutputLines);
      await saveAiSettings({
        provider: isAiProvider(input.provider) ? input.provider : current.provider,
        replyToResult: Boolean(input.replyToResult),
        maxOutputLines: Number.isFinite(lines) && lines >= 20 ? Math.floor(lines) : current.maxOutputLines,
        anthropic: applyProvider(current.anthropic, input.anthropic),
        openai: applyProvider(current.openai, input.openai)
      });
    })
  );

  // Checks the key against the provider and that the model exists; returns the model.
  ipcMain.handle(
    'ai_test',
    handle(async (provider?: AiProviderId) => {
      const settings = await loadAiSettings();
      const id = isAiProvider(provider) ? provider : settings.provider;
      const model = modelFor(settings, id);
      const backend = id === 'anthropic' ? anthropicBackend : openaiBackend;
      try {
        await backend.check(await resolveAiKey(settings, id), model);
      } catch (err) {
        throw new Error(errorMessage(err));
      }
      return model;
    })
  );

  ipcMain.handle('ai_problems', handle(async (hostKey?: string) => (await store()).problems(hostKey).map(problemView)));

  ipcMain.handle(
    'ai_problem',
    handle(async (id: string): Promise<AiProblemDetailDto> => {
      const s = await store();
      const problem = s.problem(id);
      if (!problem) throw new Error('That problem no longer exists.');
      return {
        problem: problemView(problem),
        entries: s.entries(id).map(entryView),
        commands: s.commands(id),
        running: (await aiEngine()).isRunning(id)
      };
    })
  );

  ipcMain.handle(
    'ai_problem_create',
    handle(async (hostKey: string, shell: ShellContext) => problemView((await aiEngine()).createProblem(hostKey, shell)))
  );

  ipcMain.handle(
    'ai_problem_update',
    handle(async (id: string, patch: { title?: string; status?: ProblemStatus }) => {
      const s = await store();
      const title = patch.title?.trim();
      s.updateProblem(id, {
        ...(title ? { title } : {}),
        ...(patch.status === 'open' || patch.status === 'solved' ? { status: patch.status } : {})
      });
      const problem = s.problem(id);
      if (problem) state.emit('ai-event', { type: 'problem', problem: problemView(problem) } satisfies EngineEvent);
    })
  );

  ipcMain.handle(
    'ai_problem_delete',
    handle(async (id: string) => {
      (await aiEngine()).cancel(id);
      (await store()).deleteProblem(id);
    })
  );

  ipcMain.handle(
    'ai_send',
    handle(async (id: string, input: { text: string; context?: string; sessionKey?: string }) => (await aiEngine()).send(id, input))
  );

  ipcMain.handle(
    'ai_report',
    handle(async (id: string, commandId: string, report: CommandReport) =>
      (await aiEngine()).report(id, commandId, {
        state: report.state === 'ran' ? 'ran' : 'skipped',
        output: typeof report.output === 'string' ? report.output : undefined,
        note: typeof report.note === 'string' ? report.note : undefined
      })
    )
  );

  ipcMain.handle('ai_continue', handle(async (id: string) => (await aiEngine()).continue(id)));
  ipcMain.handle('ai_cancel', handle(async (id: string) => (await aiEngine()).cancel(id)));
}
