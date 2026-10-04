import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveWeightBudget } from '../tools/compact-mutinynet-evidence.ts';
import { validateCurrentDockerIdentity, validateLocalSmokeOrigin, validateSameContainerRestartAttestation } from '../tools/compact-mutinynet-restart-attestation.ts';

const baseline = { profileId: 'a'.repeat(64), finalFinancialStateSha256: 'b'.repeat(64), idempotencyKeyPrefix: 'compact-mutinynet-v1' };
function attestation() {
  const identity = (startedAt: string) => ({ Id: 'c'.repeat(64), Image: `sha256:${'d'.repeat(64)}`,
    State: { Status: 'running', StartedAt: startedAt }, Mounts: [{ Name: 'shielded_data', Destination: '/data', RW: true }],
    profileId: baseline.profileId, apiStateSha256: baseline.finalFinancialStateSha256 });
  return { version: 1, operation: 'same-container-volume-restart', dataVolume: 'shielded_data',
    idempotencyKeyPrefix: baseline.idempotencyKeyPrefix,
    beforeRestart: identity('2026-10-03T10:00:00.000000000Z'), afterRestart: identity('2026-10-03T11:00:00.000000000Z') };
}

test('restart evidence proves same running container, image, writable volume, profile and state after a later start', () => {
  const validated = validateSameContainerRestartAttestation(attestation(), baseline);
  assert.equal(validated.containerId, 'c'.repeat(64));
  assert.equal(validated.dataVolume, 'shielded_data');
  validateCurrentDockerIdentity({ Id: validated.containerId, Image: validated.imageId,
    State: { Status: 'running', StartedAt: validated.afterStartedAt }, Mounts: validated.afterMounts,
    NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '8788' }] } } }, validated, 8788);
});

test('restart evidence fails closed for changed identity, state, or volume', () => {
  assert.throws(() => validateSameContainerRestartAttestation(undefined, baseline));
  const changes: Array<(item: any) => void> = [
    (item) => { item.afterRestart.Id = 'e'.repeat(64); },
    (item) => { item.afterRestart.Image = `sha256:${'e'.repeat(64)}`; },
    (item) => { item.afterRestart.State.StartedAt = item.beforeRestart.State.StartedAt; },
    (item) => { item.afterRestart.profileId = 'f'.repeat(64); },
    (item) => { item.afterRestart.apiStateSha256 = 'f'.repeat(64); },
    (item) => { item.afterRestart.Mounts[0].RW = false; },
    (item) => { item.afterRestart.Mounts[0].Name = 'other-volume'; },
    (item) => { item.afterRestart.State.Status = 'exited'; },
    (item) => { item.afterRestart.State.StartedAt = 'not-a-time'; },
  ];
  for (const change of changes) {
    const candidate = attestation();
    change(candidate);
    assert.throws(() => validateSameContainerRestartAttestation(candidate, baseline));
  }
  const valid = validateSameContainerRestartAttestation(attestation(), baseline);
  const networkSettings = { NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '8788' }] } } };
  const mismatchedInspect = [
    { ...networkSettings, Id: 'e'.repeat(64), Image: valid.imageId, State: { Status: 'running', StartedAt: valid.afterStartedAt }, Mounts: valid.afterMounts },
    { ...networkSettings, Id: valid.containerId, Image: `sha256:${'e'.repeat(64)}`, State: { Status: 'running', StartedAt: valid.afterStartedAt }, Mounts: valid.afterMounts },
    { ...networkSettings, Id: valid.containerId, Image: valid.imageId, State: { Status: 'exited', StartedAt: valid.afterStartedAt }, Mounts: valid.afterMounts },
    { ...networkSettings, Id: valid.containerId, Image: valid.imageId, State: { Status: 'running', StartedAt: valid.beforeStartedAt }, Mounts: valid.afterMounts },
    { ...networkSettings, Id: valid.containerId, Image: valid.imageId, State: { Status: 'running', StartedAt: valid.afterStartedAt }, Mounts: [] },
    { ...networkSettings, Id: valid.containerId, Image: valid.imageId, State: { Status: 'running', StartedAt: valid.afterStartedAt }, Mounts: valid.afterMounts,
      NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '0.0.0.0', HostPort: '8788' }] } } },
    { ...networkSettings, Id: valid.containerId, Image: valid.imageId, State: { Status: 'running', StartedAt: valid.afterStartedAt }, Mounts: valid.afterMounts,
      NetworkSettings: { Ports: { '8787/tcp': [{ HostIp: '127.0.0.1', HostPort: '8787' }] } } },
  ];
  for (const current of mismatchedInspect) assert.throws(() => validateCurrentDockerIdentity(current, valid, 8788));
});

test('smoke API must be an explicit loopback HTTP origin and port', () => {
  assert.deepEqual(validateLocalSmokeOrigin('http://127.0.0.1:8788'), { origin: 'http://127.0.0.1:8788', port: 8788 });
  for (const url of ['https://127.0.0.1:8788', 'http://localhost:8788', 'http://192.0.2.1:8788',
    'http://127.0.0.1:8788/path', 'http://127.0.0.1:8788?query=1', 'http://user:pass@127.0.0.1:8788']) {
    assert.throws(() => validateLocalSmokeOrigin(url));
  }
});

test('positive transaction weight limit is min of operator effective limit and smoke cap', () => {
  assert.deepEqual(effectiveWeightBudget({ effectiveMaxTxWeight: '3000', maxTxWeight: '5000' }),
    { advertised: 5000n, effective: 3000n, smokeCap: 3000n });
  assert.deepEqual(effectiveWeightBudget({ effectiveMaxTxWeight: '6000', maxTxWeight: '8000' }),
    { advertised: 8000n, effective: 6000n, smokeCap: 4000n });
});

test('weight budget rejects missing, zero, malformed and above-advertised effective limits', () => {
  for (const operator of [
    {}, { effectiveMaxTxWeight: '0' }, { effectiveMaxTxWeight: 'nope' },
    { effectiveMaxTxWeight: '3000', maxTxWeight: '2500' }, { effectiveMaxTxWeight: '3000', maxTxWeight: 'NaN' },
  ]) assert.throws(() => effectiveWeightBudget(operator));
});
