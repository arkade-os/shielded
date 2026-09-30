import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface VmInfo { backend: string; emulatorPublicKey: string; serverPublicKey: string; nativeValidation?: string }
export async function startVm(): Promise<{ url: string; info: VmInfo; close(): void }> {
  const url = process.env.SHIELDED_VM_URL ?? 'http://127.0.0.1:8788';
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('The demo VM must run on loopback');
  let child: ChildProcess | undefined;
  const health = async (): Promise<VmInfo> => {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('Emulator health check failed');
    const info = await response.json() as VmInfo;
    if (info.backend !== 'arkade-emulator-Service.SubmitTx') throw new Error('Unexpected emulator backend');
    return info;
  };
  try { const info = await health(); return { url, info, close() {} }; } catch { /* Start the bundled local service. */ }
  const filename = process.platform === 'win32' ? 'shielded-vm.exe' : 'shielded-vm';
  const binary = process.env.SHIELDED_VM_BIN ?? fileURLToPath(new URL(`../bin/${filename}`, import.meta.url));
  await access(binary).catch(() => { throw new Error(`Emulator bridge not built. Run npm run vm:build (Go 1.26.6 required), or set SHIELDED_VM_BIN.`); });
  child = spawn(binary, ['--listen', `127.0.0.1:${parsed.port || 8788}`], { stdio: ['ignore', 'ignore', 'inherit'] });
  let startupError: Error | undefined;
  child.once('error', error => { startupError = error; });
  for (let i = 0; i < 40; i++) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error(`Emulator exited during startup (${child.exitCode})`);
    try { const info = await health(); return { url, info, close() { child?.kill('SIGTERM'); } }; } catch { /* wait for listener */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error('Emulator bridge did not become ready');
}
