import type { Risk } from './types.js';

/**
 * Local rules for how dangerous a proposed command is, applied whatever the model says
 * about it: a model can be wrong, or talked into calling something harmless. A `danger`
 * command needs a second click to run.
 */

const DANGER: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+-?[a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*\s+-?[a-zA-Z]*[rR]|-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*|--recursive\b.*--force\b|--force\b.*--recursive\b)/i,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^|;&]*\bof=\/dev\//,
  /\b(wipefs|shred|fdisk|sfdisk|parted|gdisk)\b/,
  />\s*\/dev\/(sd|nvme|vd|hd|xvd)\w*/,
  /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(0?777|a\+rwx)\s+\/(\s|$)/,
  /\bch(own|mod)\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+\/(\s|$)/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\b(shutdown|poweroff|halt|reboot)\b/,
  /\binit\s+[06]\b/,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bRemove-Item\b.*-Recurse\b.*-Force\b|\bRemove-Item\b.*-Force\b.*-Recurse\b/i,
  /\bFormat-Volume\b|\bClear-Disk\b/i,
  /\bgit\s+push\b.*\s(--force|-f)\b/,
  /\bdocker\s+(system|volume|image|container)\s+prune\b.*(-a|--all|--volumes)\b/,
  /\biptables\s+(-F|--flush)\b/,
  /\buserdel\b|\bpasswd\s+-d\b/
];

const CAUTION: RegExp[] = [
  /\bsudo\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bsed\s+(-[a-zA-Z]*i|--in-place)/,
  /(^|[^>&0-9])>\s*[^\s&|]/,
  /\btee\b/,
  /\bsystemctl\s+(stop|restart|disable|mask|kill)\b/,
  /\bservice\s+\S+\s+(stop|restart)\b/,
  /\bkill(all)?\b|\bpkill\b/,
  /\b(apt|apt-get|yum|dnf|zypper|pacman|apk|brew|snap)\s+(install|remove|purge|upgrade|dist-upgrade|update|-S|-R|del|add)\b/,
  /\bdocker\s+(rm|rmi|stop|kill|compose\s+down)\b/,
  /\bchmod\b|\bchown\b/,
  /\bcrontab\s+-[er]\b/,
  /\bgit\s+(reset|clean|checkout\s+--)\b/,
  /\bStop-Service\b|\bRestart-Service\b|\bSet-ItemProperty\b|\bRemove-Item\b/i
];

const ORDER: Record<Risk, number> = { safe: 0, caution: 1, danger: 2 };

export function maxRisk(a: Risk, b: Risk): Risk {
  return ORDER[a] >= ORDER[b] ? a : b;
}

export function localRisk(command: string): Risk {
  if (DANGER.some((p) => p.test(command))) return 'danger';
  if (CAUTION.some((p) => p.test(command))) return 'caution';
  return 'safe';
}

export function isRisk(value: unknown): value is Risk {
  return value === 'safe' || value === 'caution' || value === 'danger';
}
