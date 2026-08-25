import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url);

async function readRepoFile(path) {
  return readFile(new URL(path, repoRoot), 'utf8');
}

function iniSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`[${sectionName}]`);
  assert.notEqual(start, -1, `missing [${sectionName}] section`);
  const endOffset = lines.slice(start + 1).findIndex(line => line.startsWith('['));
  const sectionLines = lines.slice(start + 1, endOffset === -1 ? undefined : start + 1 + endOffset);
  return Object.fromEntries(
    sectionLines
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const separator = line.indexOf('=');
        assert.notEqual(separator, -1, `invalid keyfile line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test('rover host keeps deterministic public DNS behind MagicDNS', async () => {
  const profile = await readRepoFile(
    'rover/host/files/etc/NetworkManager/system-connections/fsk-default.nmconnection',
  );
  const ipv4 = iniSection(profile, 'ipv4');

  assert.equal(ipv4.method, 'auto', 'address and routes must still come from DHCP');
  assert.equal(ipv4['ignore-auto-dns'], 'true');
  assert.deepEqual(ipv4.dns.split(';').filter(Boolean), ['1.1.1.1', '8.8.8.8']);
});

test('rover cold boot reaches time sync without DNS before Tailscale starts', async () => {
  const [containerfile, tailscaleOverride] = await Promise.all([
    readRepoFile('rover/host/Containerfile'),
    readRepoFile('rover/host/files/usr/lib/systemd/system/tailscaled.service.d/override.conf'),
  ]);

  assert.match(containerfile, /server 162\.159\.200\.123 iburst/);
  assert.match(containerfile, /server 216\.239\.35\.0 iburst/);
  assert.match(containerfile, /chrony-wait\.service/);
  assert.match(tailscaleOverride, /^After=time-sync\.target$/m);
  assert.match(tailscaleOverride, /^Wants=time-sync\.target$/m);
});

test('rover provisioning documents MagicDNS acceptance explicitly', async () => {
  const readme = await readRepoFile('rover/README.md');

  assert.match(readme, /tailscale up --auth-key=tskey-… --accept-dns=true/);
  assert.match(readme, /public fallback/);
});
