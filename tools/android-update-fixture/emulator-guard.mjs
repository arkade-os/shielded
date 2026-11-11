import assert from 'node:assert/strict';

export function requireDisposableEmulator(serial, device) {
  if (serial === undefined) return false;
  assert.match(serial, /^emulator-[1-9]\d{3,4}$/, 'Only an explicit emulator serial may receive fixture APKs');
  assert.equal(device('shell', 'getprop', 'ro.kernel.qemu').stdout.trim(), '1', 'Refusing a physical Android device');
  assert.equal(device('shell', 'pm', 'list', 'packages', 'io.arkade.shielded').stdout.trim(), '', 'Existing Shielded installation is preserved; use a fresh disposable emulator');
  return true;
}
