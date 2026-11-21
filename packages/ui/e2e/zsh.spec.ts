import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './settingsWindow';

const HOSTS = [{ name: 'web-1', hostname: 'web.example.com', user: 'root', port: 22, tags: [], source: 'manual', hasKey: true }];

const PROFILE = {
  zshrc: 'PROMPT="> "\nsource ~/.zsh/plugins.zsh\n',
  plugins: 'zsh-users/zsh-autosuggestions\nzsh-users/zsh-syntax-highlighting\n',
  theme: '',
  folder: '/home/user/.config/remoty/zsh',
  homeFolder: '/home/user/.config/remoty/zsh/home',
  homeFiles: ['.config/htop/htoprc', '.p10k.zsh'],
  defaults: { zshrc: 'DEFAULT\n', plugins: 'zsh-users/zsh-autosuggestions\n', theme: '' }
};

async function boot(page: Page): Promise<void> {
  await page.context().addInitScript(
    ({ hosts, profile }) => {
      const win = window as unknown as Record<string, unknown>;
      const listeners: Record<string, Array<(payload: unknown) => void>> = {};
      const fire = (channel: string, payload: unknown): void => {
        for (const cb of listeners[channel] ?? []) cb(payload);
      };
      win.remoty = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve(hosts);
            case 'reload_hosts':
              setTimeout(() => fire('hosts-loaded', hosts), 0);
              return Promise.resolve(null);
            case 'open_settings_window':
              window.open('/?window=settings', 'remoty-settings');
              return Promise.resolve(null);
            case 'zsh_profile_load':
              return Promise.resolve(profile);
            case 'zsh_profile_save': {
              const p = args[0] as { plugins: string };
              if (p.plugins.includes('broken')) return Promise.reject({ message: '"broken" is not a GitHub plugin' });
              localStorage.setItem('e2e-zsh-saved', JSON.stringify(p));
              return Promise.resolve(null);
            }
            case 'start_zsh_install': {
              const [name, setDefault] = args as [string, boolean];
              win.__zshDefault = setDefault;
              const step = (index: number, description: string) =>
                fire('zsh-install-progress', { hostName: name, step: { index, total: 4, description } });
              setTimeout(() => step(2, 'Preparing zsh-autosuggestions'), 40);
              setTimeout(() => step(4, 'Installing'), 120);
              setTimeout(
                () =>
                  fire('zsh-install-complete', {
                    hostName: name,
                    result: {
                      zshPath: '/root/.zsh/zsh-bin/bin/zsh',
                      zshVersion: '5.8',
                      shell: setDefault ? 'changed' : 'unchanged',
                      plugins: ['zsh-autosuggestions', 'zsh-syntax-highlighting'],
                      homeFiles: ['.p10k.zsh'],
                      backups: ['/root/.zshrc.remoty-backup-20261121-201500'],
                      profileFile: null,
                      bundledZsh: true,
                      offlineCopies: []
                    }
                  }),
                400
              );
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
        appVersion: () => Promise.resolve('0.0.0'),
        getPathForFile: () => ''
      };
    },
    { hosts: HOSTS, profile: PROFILE }
  );
  await page.goto('/');
  await expect(page.getByText('web-1', { exact: true })).toBeVisible();
}

test('installs zsh on a host and reports what it did', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Install zsh on web-1' }).click();
  const confirm = page.getByRole('dialog', { name: 'Install zsh' });
  const toggle = confirm.getByRole('switch', { name: 'Make zsh the login shell' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await confirm.getByRole('button', { name: 'Install zsh' }).click();

  const dialog = page.getByRole('dialog', { name: 'Install zsh' });
  await expect(dialog.getByText('Installing')).toBeVisible();
  await expect(dialog.getByText('zsh 5.8 is set up')).toBeVisible();
  await expect(dialog.getByText(/brought along, no root needed/)).toBeVisible();
  await expect(dialog.getByText('Plugins: zsh-autosuggestions, zsh-syntax-highlighting')).toBeVisible();
  await expect(dialog.getByText(/remoty-backup/)).toBeVisible();
  await expect(dialog.getByText(/now the login shell/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__zshDefault)).toBe(true);

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('edits the zsh profile in Settings', async ({ page }) => {
  await boot(page);
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: 'zsh' }).click();

  const plugins = settings.getByLabel('Plugins');
  await expect(plugins).toHaveValue(PROFILE.plugins);
  await expect(settings.getByText('.config/htop/htoprc, .p10k.zsh', { exact: true })).toBeVisible();

  await plugins.fill('broken');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText(/is not a GitHub plugin/)).toBeVisible();

  await plugins.fill('zsh-users/zsh-autosuggestions\n');
  await settings.getByLabel('Theme (optional)').fill('romkatv/powerlevel10k');
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings.getByText(/Saved/)).toBeVisible();
  const saved = JSON.parse((await settings.evaluate(() => localStorage.getItem('e2e-zsh-saved'))) ?? '{}');
  expect(saved).toEqual({ zshrc: PROFILE.zshrc, plugins: 'zsh-users/zsh-autosuggestions\n', theme: 'romkatv/powerlevel10k' });

  await settings.getByRole('button', { name: 'Back to the defaults' }).click();
  await expect(plugins).toHaveValue(PROFILE.defaults.plugins);
});
