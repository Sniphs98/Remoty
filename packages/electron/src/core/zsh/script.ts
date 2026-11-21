import { shellQuote } from '../ssh/sftp.js';

export const ZSH_BIN_RELEASE = 'v6.1.1';
export const ZSH_BIN_VERSION = '5.8';

const ZSH_BIN_TARGETS: Record<string, Record<string, string>> = {
  linux: {
    x86_64: 'x86_64',
    amd64: 'x86_64',
    aarch64: 'aarch64',
    arm64: 'aarch64',
    armv7l: 'armv7l',
    armv6l: 'armv6l',
    i386: 'i686',
    i486: 'i686',
    i586: 'i686',
    i686: 'i686'
  },
  darwin: { x86_64: 'x86_64', arm64: 'arm64' },
  freebsd: { amd64: 'amd64', x86_64: 'amd64' }
};

export function zshBinAsset(os: string, arch: string): string {
  const target = ZSH_BIN_TARGETS[os.trim().toLowerCase()];
  const cpu = target?.[arch.trim().toLowerCase()];
  if (!target || !cpu) {
    throw new Error(`there is no ready-made zsh for ${os} ${arch} — install zsh on the server once, then run this again`);
  }
  return `zsh-${ZSH_BIN_VERSION}-${os.trim().toLowerCase()}-${cpu}.tar.gz`;
}

export function zshBinUrl(asset: string): string {
  return `https://github.com/romkatv/zsh-bin/releases/download/${ZSH_BIN_RELEASE}/${asset}`;
}

export interface ServerFacts {
  os: string;
  arch: string;
  home: string;
  zsh: string | null;
  hasTar: boolean;
  hasGzip: boolean;
}

export const PROBE_SCRIPT = [
  'printf "os=%s\\n" "$(uname -s)"',
  'printf "arch=%s\\n" "$(uname -m)"',
  'printf "home=%s\\n" "$HOME"',
  'printf "zsh=%s\\n" "$(command -v zsh 2>/dev/null)"',
  'command -v tar >/dev/null 2>&1 && echo tar=1',
  'command -v gzip >/dev/null 2>&1 && echo gzip=1',
  'true'
].join('; ');

export function parseProbe(output: string): ServerFacts {
  const values = new Map<string, string>();
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const home = values.get('home') ?? '';
  if (!home.startsWith('/')) throw new Error('could not read the home directory on the server');
  const zsh = values.get('zsh') ?? '';
  return {
    os: values.get('os') ?? '',
    arch: values.get('arch') ?? '',
    home,
    zsh: zsh.startsWith('/') ? zsh : null,
    hasTar: values.get('tar') === '1',
    hasGzip: values.get('gzip') === '1'
  };
}

export function stagingDir(home: string): string {
  return `${home.replace(/\/+$/, '')}/.remoty-zsh-staging`;
}

export interface InstallScriptOptions {
  staging: string;
  bundledZsh: boolean;
  setDefaultShell: boolean;
  homeFiles: string[];
}

export function isSafeHomePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const MARK_START = '# >>> remoty zsh >>>';
const MARK_END = '# <<< remoty zsh <<<';

export function installScript(opts: InstallScriptOptions): string {
  const q = shellQuote;
  const home = opts.homeFiles.filter(isSafeHomePath);
  const homeLines = home.map((f) => `put_home ${q(f)}`).join('\n');

  return `set -eu
S=${q(opts.staging)}
Z="$HOME/.zsh"
STAMP=$(date +%Y%m%d-%H%M%S)
trap 'rm -rf "$S"' EXIT

say() { printf '%s\\n' "$*"; }

backup() {
  if [ -f "$1" ] && ! cmp -s "$1" "$2" 2>/dev/null; then
    cp -p "$1" "$1.remoty-backup-$STAMP"
    say "REMOTY_BACKUP=$1.remoty-backup-$STAMP"
  fi
}

mkdir -p "$Z"

${
  opts.bundledZsh
    ? `rm -rf "$Z/zsh-bin.new"
mkdir -p "$Z/zsh-bin.new"
tar -xzf "$S/zsh.tar.gz" -C "$Z/zsh-bin.new"
rm -rf "$Z/zsh-bin"
mv "$Z/zsh-bin.new" "$Z/zsh-bin"
sh "$Z/zsh-bin/share/zsh/${ZSH_BIN_VERSION}/scripts/relocate"
ZSH_PATH="$Z/zsh-bin/bin/zsh"`
    : `ZSH_PATH=$(command -v zsh)`
}
"$ZSH_PATH" -fc true

rm -rf "$Z/plugins.new"
mkdir -p "$Z/plugins.new"
for f in "$S"/plugins/*.tar.gz; do
  [ -e "$f" ] || continue
  n=$(basename "$f" .tar.gz)
  t="$Z/plugins.new/.unpack"
  rm -rf "$t"
  mkdir -p "$t"
  tar -xzf "$f" -C "$t"
  moved=
  for d in "$t"/*/; do
    [ -d "$d" ] || continue
    mv "\${d%/}" "$Z/plugins.new/$n"
    moved=1
    break
  done
  rm -rf "$t"
  if [ -z "$moved" ]; then
    say "plugin $n has no files" >&2
    exit 1
  fi
  say "REMOTY_PLUGIN=$n"
done
rm -rf "$Z/plugins"
mv "$Z/plugins.new" "$Z/plugins"
cp "$S/plugins.zsh" "$Z/plugins.zsh"

backup "$HOME/.zshrc" "$S/zshrc"
cp "$S/zshrc" "$HOME/.zshrc"

put_home() {
  mkdir -p "$(dirname "$HOME/$1")"
  backup "$HOME/$1" "$S/home/$1"
  cp "$S/home/$1" "$HOME/$1"
  say "REMOTY_HOME_FILE=$1"
}
${homeLines}

SHELL_RESULT=unchanged
${opts.setDefaultShell ? defaultShellBlock() : ''}

say "REMOTY_ZSH_PATH=$ZSH_PATH"
say "REMOTY_ZSH_VERSION=$("$ZSH_PATH" -fc 'echo $ZSH_VERSION')"
say "REMOTY_SHELL=$SHELL_RESULT"
`;
}

function defaultShellBlock(): string {
  return `ME=$(id -un)
CUR=$(getent passwd "$ME" 2>/dev/null | cut -d: -f7 || true)
if [ -z "$CUR" ]; then
  CUR=$(awk -F: -v u="$ME" '$1 == u { print $7 }' /etc/passwd 2>/dev/null || true)
fi
if [ "$CUR" = "$ZSH_PATH" ]; then
  SHELL_RESULT=already
else
  if [ "$(id -u)" = 0 ]; then
    SUDO=
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO="sudo -n"
  else
    SUDO=none
  fi
  if [ "$SUDO" != none ]; then
    if ! grep -qxF "$ZSH_PATH" /etc/shells 2>/dev/null; then
      printf '%s\\n' "$ZSH_PATH" | $SUDO tee -a /etc/shells >/dev/null 2>&1 || true
    fi
    if $SUDO chsh -s "$ZSH_PATH" "$ME" >/dev/null 2>&1 || $SUDO usermod -s "$ZSH_PATH" "$ME" >/dev/null 2>&1; then
      SHELL_RESULT=changed
    fi
  fi
  if [ "$SHELL_RESULT" = unchanged ]; then
    for P in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      [ -f "$P" ] && break
    done
    if ! grep -qF '${MARK_START}' "$P" 2>/dev/null; then
      {
        printf '\\n%s\\n' '${MARK_START}'
        printf 'if [ -z "\${ZSH_VERSION:-}" ] && [ -z "\${REMOTY_NO_ZSH:-}" ] && [ -t 0 ] && [ -x "%s" ]; then\\n' "$ZSH_PATH"
        printf '  case $- in *i*) SHELL="%s"; export SHELL; exec "$SHELL" -l ;; esac\\n' "$ZSH_PATH"
        printf 'fi\\n%s\\n' '${MARK_END}'
      } >> "$P"
    fi
    say "REMOTY_PROFILE=$P"
    SHELL_RESULT=profile
  fi
fi`;
}

export interface InstallOutcome {
  zshPath: string;
  zshVersion: string;
  shell: 'unchanged' | 'already' | 'changed' | 'profile';
  plugins: string[];
  homeFiles: string[];
  backups: string[];
  profileFile: string | null;
}

export function parseInstallOutput(output: string): InstallOutcome {
  const out: InstallOutcome = {
    zshPath: '',
    zshVersion: '',
    shell: 'unchanged',
    plugins: [],
    homeFiles: [],
    backups: [],
    profileFile: null
  };
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^REMOTY_([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'ZSH_PATH') out.zshPath = value;
    else if (key === 'ZSH_VERSION') out.zshVersion = value;
    else if (key === 'SHELL' && ['unchanged', 'already', 'changed', 'profile'].includes(value)) out.shell = value as InstallOutcome['shell'];
    else if (key === 'PLUGIN') out.plugins.push(value);
    else if (key === 'HOME_FILE') out.homeFiles.push(value);
    else if (key === 'BACKUP') out.backups.push(value);
    else if (key === 'PROFILE') out.profileFile = value;
  }
  if (!out.zshPath) throw new Error('the install script did not finish');
  return out;
}
