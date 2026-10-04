export interface DockerRestartIdentity {
  Id: string;
  Image: string;
  State: { Status: string; StartedAt: string };
  Mounts: Array<{ Name?: string; Destination: string; RW: boolean }>;
  profileId: string;
  apiStateSha256: string;
}

export interface SameContainerRestartAttestation {
  version: 1;
  operation: 'same-container-volume-restart';
  dataVolume: string;
  idempotencyKeyPrefix: string;
  beforeRestart: DockerRestartIdentity;
  afterRestart: DockerRestartIdentity;
}

const HEX_256 = /^[0-9a-f]{64}$/i;
const DOCKER_ID = /^[0-9a-f]{12,64}$/i;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}

function identity(value: unknown, label: string, dataVolume: string) {
  const item = object(value, label);
  const state = object(item.State, `${label}.State`);
  if (typeof item.Id !== 'string' || !DOCKER_ID.test(item.Id) || typeof item.Image !== 'string' || !item.Image ||
      state.Status !== 'running' || typeof state.StartedAt !== 'string' || !RFC3339_UTC.test(state.StartedAt) ||
      !Number.isFinite(Date.parse(state.StartedAt)) ||
      !Array.isArray(item.Mounts) || !HEX_256.test(item.profileId) || !HEX_256.test(item.apiStateSha256)) {
    throw new Error(`${label} is missing a valid Docker identity or state fingerprint`);
  }
  const mounts = item.Mounts.map((mount: unknown) => {
    const entry = object(mount, `${label}.Mounts entry`);
    if (typeof entry.Destination !== 'string' || typeof entry.RW !== 'boolean' ||
        (entry.Name !== undefined && typeof entry.Name !== 'string')) throw new Error(`${label} contains an invalid mount record`);
    return { Name: entry.Name, Destination: entry.Destination, RW: entry.RW };
  }).sort((a: { Destination: string; Name?: string }, b: { Destination: string; Name?: string }) =>
    a.Destination.localeCompare(b.Destination) || (a.Name ?? '').localeCompare(b.Name ?? ''));
  const dataMounts = mounts.filter((mount: { Name?: string; Destination: string; RW: boolean }) =>
    mount.Name === dataVolume && mount.Destination === '/data' && mount.RW);
  if (dataMounts.length !== 1) throw new Error(`${label} does not mount the named writable data volume at /data`);
  return { Id: item.Id, Image: item.Image, StartedAt: state.StartedAt,
    Mounts: mounts as Array<{ Name?: string; Destination: string; RW: boolean }>,
    profileId: item.profileId, apiStateSha256: item.apiStateSha256 };
}

export function validateSameContainerRestartAttestation(value: unknown, baseline: {
  profileId: string; finalFinancialStateSha256: string; idempotencyKeyPrefix: string;
}): {
  dataVolume: string; containerId: string; imageId: string; beforeStartedAt: string; afterStartedAt: string;
  profileId: string; financialStateSha256: string; idempotencyKeyPrefix: string;
  beforeMounts: Array<{ Name?: string; Destination: string; RW: boolean }>;
  afterMounts: Array<{ Name?: string; Destination: string; RW: boolean }>;
} {
  const attestation = object(value, 'Restart attestation');
  if (attestation.version !== 1 || attestation.operation !== 'same-container-volume-restart' ||
      typeof attestation.dataVolume !== 'string' || !attestation.dataVolume ||
      attestation.idempotencyKeyPrefix !== baseline.idempotencyKeyPrefix ||
      !HEX_256.test(baseline.profileId) || !HEX_256.test(baseline.finalFinancialStateSha256)) {
    throw new Error('Restart attestation does not match the expected operation or fresh-run baseline');
  }
  const before = identity(attestation.beforeRestart, 'beforeRestart', attestation.dataVolume);
  const after = identity(attestation.afterRestart, 'afterRestart', attestation.dataVolume);
  const beforeTime = Date.parse(before.StartedAt), afterTime = Date.parse(after.StartedAt);
  if (before.Id !== after.Id || before.Image !== after.Image || afterTime <= beforeTime ||
      JSON.stringify(before.Mounts) !== JSON.stringify(after.Mounts) ||
      before.profileId !== baseline.profileId || after.profileId !== baseline.profileId ||
      before.apiStateSha256 !== baseline.finalFinancialStateSha256 || after.apiStateSha256 !== baseline.finalFinancialStateSha256) {
    throw new Error('Restart did not preserve the same container, image, named volume, profile, and financial-state digest');
  }
  return { dataVolume: attestation.dataVolume, containerId: after.Id, imageId: after.Image,
    beforeStartedAt: before.StartedAt, afterStartedAt: after.StartedAt,
    profileId: after.profileId, financialStateSha256: after.apiStateSha256,
    idempotencyKeyPrefix: attestation.idempotencyKeyPrefix,
    beforeMounts: before.Mounts, afterMounts: after.Mounts };
}

export function validateLocalSmokeOrigin(value: string): { origin: string; port: number } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Smoke API URL must be a local HTTP origin'); }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || !Number.isInteger(port) || port < 1 || port > 65_535 ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Smoke API URL must be http://127.0.0.1:<port> with no credentials, path, query or fragment');
  }
  return { origin: url.origin, port };
}

export function validateCurrentDockerIdentity(current: unknown, validated: ReturnType<typeof validateSameContainerRestartAttestation>,
  expectedHostPort: number): void {
  const actual = object(current, 'Current Docker inspect result');
  const state = object(actual.State, 'Current Docker state');
  const network = object(actual.NetworkSettings, 'Current Docker network settings');
  const mounts = Array.isArray(actual.Mounts) ? actual.Mounts.map((mount: unknown) => {
    const entry = object(mount, 'Current Docker mount');
    return { Name: entry.Name, Destination: entry.Destination, RW: entry.RW };
  }).sort((a: { Destination: string; Name?: string }, b: { Destination: string; Name?: string }) =>
    a.Destination.localeCompare(b.Destination) || (a.Name ?? '').localeCompare(b.Name ?? '')) : undefined;
  const bindings = network.Ports?.['8787/tcp'];
  const loopbackOnly = Array.isArray(bindings) && bindings.length > 0 && bindings.every((binding: unknown) => {
    const entry = object(binding, 'Current Docker published port');
    return entry.HostIp === '127.0.0.1' && entry.HostPort === String(expectedHostPort);
  });
  if (actual.Id !== validated.containerId || actual.Image !== validated.imageId || state.Status !== 'running' ||
      state.StartedAt !== validated.afterStartedAt || !mounts ||
      JSON.stringify(mounts) !== JSON.stringify(validated.afterMounts) || !loopbackOnly) {
    throw new Error('Current Docker inspect does not match the attested container, image, volume, restart time, and loopback-only API port');
  }
}
