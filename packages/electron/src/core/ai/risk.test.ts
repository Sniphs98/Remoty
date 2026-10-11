import { describe, expect, it } from 'vitest';

import { localRisk, maxRisk } from './risk';

describe('localRisk', () => {
  it.each([
    'rm -rf /var/lib/docker',
    'sudo rm -fr ./build',
    'rm -r -f /tmp/x',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda bs=1M',
    'curl -fsSL https://example.com/install.sh | sudo bash',
    'sudo reboot',
    'psql -c "DROP TABLE users"',
    'Remove-Item C:\\temp -Recurse -Force',
    'git push origin main --force',
    'docker system prune -a'
  ])('flags %s as dangerous', (cmd) => {
    expect(localRisk(cmd)).toBe('danger');
  });

  it.each([
    'sudo systemctl restart nginx',
    "sudo sed -i 's/http2//' /etc/nginx/sites-enabled/app.conf",
    'echo 1 > /proc/sys/vm/drop_caches',
    'apt install htop',
    'kill 1234',
    'rm old.log'
  ])('asks for care with %s', (cmd) => {
    expect(localRisk(cmd)).toBe('caution');
  });

  it.each([
    'systemctl status nginx',
    'journalctl -u nginx --no-pager -n 100',
    'df -h',
    'du -ah /var/log 2>/dev/null | sort -rh | head -10',
    'ls -la 2>&1',
    'nginx -t'
  ])('lets %s through', (cmd) => {
    expect(localRisk(cmd)).toBe('safe');
  });
});

describe('maxRisk', () => {
  it('keeps the more careful rating', () => {
    expect(maxRisk('safe', 'danger')).toBe('danger');
    expect(maxRisk('caution', 'safe')).toBe('caution');
  });
});
