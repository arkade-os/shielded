import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(resolve(root, 'bin'), { recursive: true });
const registry=process.argv.includes('--registry');
if(registry){const patch=spawnSync(process.execPath,[resolve(root,'tools/native-registry/apply.mjs')],{cwd:root,stdio:'inherit'});if(patch.status!==0)process.exit(patch.status??1);}
const name = process.platform === 'win32' ? (registry?'shielded-registry-vm.exe':'shielded-vm.exe') : (registry?'shielded-registry-vm':'shielded-vm');
const result = spawnSync(process.env.GO ?? 'go', ['build', ...(registry?['-modfile',resolve(root,'.deps/native-registry/vm.mod'),'-tags','registry']:[]), '-o', resolve(root, 'bin', name), '.'], { cwd: resolve(root, 'tools/vm'), stdio: 'inherit' });
if (result.error) throw new Error(`Go 1.26.6 or newer is required to rebuild the VM bridge: ${result.error.message}`);
process.exit(result.status ?? 1);
