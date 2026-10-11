import { expect, test, type Page } from '@playwright/test';

// The AI helper beside a terminal (docs/concepts/ai-integration.md). The Electron bridge
// is stubbed: `ai_*` commands answer like the main process would, with `ai-event`s for
// the streamed answer, and the "remote shell" answers a command with output followed by
// its prompt — so the capture has something real to find the end of.
const HOSTS = [{ name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: [], source: 'manual', hasKey: true }];

type Win = Window & { __aiReports: unknown[]; __aiSends: unknown[] };

async function boot(page: Page, opts: { risk?: string } = {}): Promise<void> {
  await page.addInitScript(
    ({ hosts, risk }) => {
      const win = window as unknown as Record<string, unknown>;
      localStorage.setItem('remoty-terminal-gpu', 'false');
      const listeners: Record<string, Array<(payload: unknown) => void>> = {};
      const fire = (channel: string, payload: unknown): void => {
        for (const cb of listeners[channel] ?? []) cb(payload);
      };
      const toTerminal = (text: string): void => fire('terminal-output-1', new TextEncoder().encode(text).buffer);
      const aiReports: unknown[] = [];
      const aiSends: unknown[] = [];
      win.__aiReports = aiReports;
      win.__aiSends = aiSends;

      const now = Date.now();
      const problem = {
        id: 'p1',
        hostKey: 'web-1',
        hostLabel: 'web-1',
        title: 'nginx does not start',
        status: 'open',
        inputTokens: 1200,
        outputTokens: 80,
        createdAt: now,
        updatedAt: now
      };
      const command = {
        id: 'c1',
        problemId: 'p1',
        entryId: 'a1',
        callId: 't1',
        command: 'systemctl status nginx',
        explanation: 'See why the service stopped.',
        risk,
        state: 'proposed'
      };
      const ai = (e: unknown): void => fire('ai-event', e);
      let line = '';

      win.remoty = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve(hosts);
            case 'terminal_open':
              setTimeout(() => toTerminal('deploy@web-1:~$ '), 0);
              return Promise.resolve(1);
            case 'terminal_write': {
              const text = String.fromCharCode(...(args[1] as number[]));
              for (const ch of text) {
                if (ch === '\r' || ch === '\n') {
                  const typed = line;
                  line = '';
                  setTimeout(() => {
                    toTerminal('\r\n');
                    if (typed === 'systemctl status nginx') {
                      toTerminal('● nginx.service - A high performance web server\r\n   Active: failed (Result: exit-code)\r\n');
                    }
                    toTerminal('deploy@web-1:~$ ');
                  }, 50);
                } else {
                  line += ch;
                  toTerminal(ch);
                }
              }
              return Promise.resolve(null);
            }
            case 'ai_problems':
              return Promise.resolve([]);
            case 'ai_problem_create':
              setTimeout(() => ai({ type: 'problem', problem: { ...problem, title: 'New problem' } }), 0);
              return Promise.resolve({ ...problem, title: 'New problem' });
            case 'ai_send':
              aiSends.push(args);
              setTimeout(() => {
                ai({ type: 'entry', problemId: 'p1', entry: { id: 'u1', problemId: 'p1', seq: 1, createdAt: now, kind: 'user', text: 'nginx does not start' }, commands: [] });
                ai({ type: 'problem', problem });
                ai({ type: 'turnStart', problemId: 'p1' });
                ai({ type: 'text', problemId: 'p1', delta: 'Let us look at ' });
                ai({ type: 'text', problemId: 'p1', delta: 'the service first.' });
                ai({
                  type: 'entry',
                  problemId: 'p1',
                  entry: { id: 'a1', problemId: 'p1', seq: 2, createdAt: now, kind: 'assistant', text: 'Let us look at the service first.', provider: 'anthropic', model: 'm' },
                  commands: [command]
                });
                ai({ type: 'turnEnd', problemId: 'p1' });
              }, 20);
              return Promise.resolve(null);
            case 'ai_report': {
              aiReports.push(args);
              const report = args[2] as { state: string; output?: string };
              setTimeout(() => {
                ai({ type: 'command', problemId: 'p1', command: { ...command, state: report.state, output: report.output } });
                ai({ type: 'turnStart', problemId: 'p1' });
                ai({
                  type: 'entry',
                  problemId: 'p1',
                  entry: { id: 'a2', problemId: 'p1', seq: 4, createdAt: now, kind: 'assistant', text: 'nginx failed to start — check the config with `nginx -t`.', provider: 'anthropic', model: 'm' },
                  commands: []
                });
                ai({ type: 'turnEnd', problemId: 'p1' });
              }, 20);
              return Promise.resolve(null);
            }
            default:
              return Promise.resolve(null);
          }
        },
        on: (channel: string, cb: (payload: unknown) => void) => {
          (listeners[channel] ||= []).push(cb);
          return () => {
            listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== cb);
          };
        },
        settings: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() },
        openExternal: () => Promise.resolve(),
        homeDir: () => Promise.resolve('/home/user'),
        getPathForFile: () => ''
      };
    },
    { hosts: HOSTS, risk: opts.risk ?? 'safe' }
  );
  await page.goto('/');
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('deploy@web-1:~$');
}

test('ask the AI, run its command with one click, and its output goes back without copying', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Open the AI helper' }).click();
  const panel = page.getByTestId('ai-panel');
  await expect(panel).toContainText('What are you trying to fix on web-1?');

  await panel.getByPlaceholder('Describe the problem…').fill('nginx does not start');
  await page.keyboard.press('Enter');

  const card = panel.getByTestId('ai-command');
  await expect(card).toContainText('systemctl status nginx');
  await expect(card).toContainText('reads only');
  await expect(panel.getByRole('button', { name: 'nginx does not start' })).toBeVisible();

  await card.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.xterm-rows')).toContainText('Active: failed');
  await expect(card).toContainText('Ran · 2 lines');
  await expect(panel).toContainText('check the config with nginx -t');

  const reports = await page.evaluate(() => (window as unknown as Win).__aiReports);
  expect(reports).toEqual([
    ['p1', 'c1', { state: 'ran', output: '● nginx.service - A high performance web server\n   Active: failed (Result: exit-code)' }]
  ]);
});

test('a dangerous command needs a second click', async ({ page }) => {
  await boot(page, { risk: 'danger' });
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+A');
  const panel = page.getByTestId('ai-panel');
  await panel.getByPlaceholder('Describe the problem…').fill('nginx does not start');
  await page.keyboard.press('Enter');

  const card = panel.getByTestId('ai-command');
  await expect(card).toContainText('dangerous');
  await card.getByRole('button', { name: 'Run' }).click();
  await expect(card.getByRole('button', { name: 'Really run?' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Win).__aiReports)).toEqual([]);
  await card.getByRole('button', { name: 'Really run?' }).click();
  await expect(card).toContainText('Ran ·');
});

test('Ctrl+Shift+A opens and closes the panel', async ({ page }) => {
  await boot(page);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+Shift+A');
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  await page.getByTestId('ai-panel').getByPlaceholder('Describe the problem…').focus();
  await page.keyboard.press('Control+Shift+A');
  await expect(page.getByTestId('ai-panel')).toHaveCount(0);
});

test('Settings → AI: the key is saved and tested, never shown again', async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    const saved: unknown[] = [];
    win.__aiSaved = saved;
    let hasKey = false;
    win.remoty = {
      invoke: (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve([]);
          case 'ai_settings':
            return Promise.resolve({
              provider: 'anthropic',
              replyToResult: true,
              maxOutputLines: 200,
              anthropic: { hasKey, defaultModel: 'claude-opus-5-5' },
              openai: { hasKey: false, defaultModel: 'gpt-5.5' }
            });
          case 'ai_save_settings': {
            const input = args[0] as { anthropic?: { key?: string } };
            if (input.anthropic?.key) hasKey = true;
            saved.push(input);
            return Promise.resolve(null);
          }
          case 'ai_test':
            return hasKey ? Promise.resolve('claude-opus-5-5') : Promise.reject({ message: 'no Anthropic API key yet — add one in Settings → AI' });
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
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByRole('button', { name: 'Test the AI connection' }).click();
  await expect(page.getByText('no Anthropic API key yet — add one in Settings → AI')).toBeVisible();

  await page.getByLabel('Claude API key', { exact: true }).fill('sk-ant-secret');
  await page.getByRole('button', { name: 'Save AI settings and test' }).click();
  await expect(page.getByText('Connected — using claude-opus-5-5.')).toBeVisible();
  await expect(page.getByLabel('Claude API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Claude API key', { exact: true })).toHaveAttribute('placeholder', 'Saved — leave blank to keep it');
  expect(await page.evaluate(() => (window as unknown as { __aiSaved: unknown[] }).__aiSaved)).toEqual([
    {
      provider: 'anthropic',
      replyToResult: true,
      anthropic: { key: 'sk-ant-secret', keyRef: '', model: '' },
      openai: { keyRef: '', model: '' },
      'claude-cli': { model: '', path: '' },
      'codex-cli': { model: '', path: '' }
    }
  ]);
});

test('Settings → AI: a subscription through Claude Code shows whether it is signed in', async ({ page }) => {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    const saved: unknown[] = [];
    win.__aiSaved = saved;
    let checks = 0;
    const provider = (defaultModel: string) => ({ hasKey: false, defaultModel });
    win.remoty = {
      invoke: (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve([]);
          case 'ai_settings':
            return Promise.resolve({
              provider: 'anthropic',
              replyToResult: true,
              maxOutputLines: 200,
              anthropic: provider('claude-opus-5-5'),
              openai: provider('gpt-5.5'),
              'claude-cli': provider(''),
              'codex-cli': provider('')
            });
          case 'ai_cli_status':
            checks += 1;
            return Promise.resolve({
              installed: true,
              path: '/usr/local/bin/claude',
              version: '2.1.296 (Claude Code)',
              loggedIn: checks > 1,
              detail: checks > 1 ? 'signed in (claude.ai)' : 'not signed in'
            });
          case 'ai_save_settings':
            saved.push(args[0]);
            return Promise.resolve(null);
          case 'ai_test':
            return Promise.resolve('');
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
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();

  await page.getByRole('button', { name: 'Subscription' }).click();
  const status = page.getByTestId('ai-cli-status');
  await expect(status).toContainText('installed but not signed in');
  await expect(status).toContainText('claude auth login');
  await expect(page.getByLabel('Claude API key', { exact: true })).toHaveCount(0);

  await status.getByRole('button', { name: 'Check again' }).click();
  await expect(status).toContainText('2.1.296 (Claude Code) — signed in (claude.ai)');
  await expect(page.getByLabel('Program')).toHaveAttribute('placeholder', '/usr/local/bin/claude');

  await page.getByRole('button', { name: 'Save AI settings and test' }).click();
  await expect(page.getByText('Ready — Claude Code is signed in.')).toBeVisible();
  const [input] = (await page.evaluate(() => (window as unknown as { __aiSaved: unknown[] }).__aiSaved)) as { provider: string }[];
  expect(input.provider).toBe('claude-cli');

  // OpenAI with a subscription is the Codex CLI.
  await page.getByRole('button', { name: 'OpenAI' }).click();
  await expect(status).toContainText('ChatGPT plan through the Codex CLI');
});
