import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('./firmware/', import.meta.url));
function runFirmware(t, source, args = []) {
  const build = mkdtempSync(join(tmpdir(), 'fsk-firmware-test-'));
  t.after(() => rmSync(build, { recursive: true, force: true }));
  const binary = join(build, 'test');
  execFileSync('cc', ['-std=c11', '-O0', `-I${join(fixtures, 'stubs')}`,
    '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections',
    join(fixtures, source), '-o', binary], { timeout: 30000 });
  execFileSync(binary, args, { timeout: 3000, stdio: 'pipe' });
}

test('timer rollover preserves elapsed time, link health, and pending events', t => runFirmware(t, 'rollover.c'));
test('an edge during initial skew acquisition does not poison later synchronized events', t => runFirmware(t, 'firmware.c'));
test('authenticated ACK from an old master session cannot evict the pending event', t => runFirmware(t, 'ack.c'));
test('USB capture boundaries and event acknowledgements preserve full tick and boot identity', t => runFirmware(t, 'usb-protocol.c'));

test("a capture clock fault is reliably reported and does not block later healthy captures", t => runFirmware(t, "firmware.c", ["fault"]));
test('master backpressure preserves events and clock renewal preserves old-session acknowledgements', t => runFirmware(t, 'master-queue.c'));
test('ISR overflow retains the lost capture range and the next edge recovers without reboot', t => runFirmware(t, 'capture-queue.c'));
