import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../..',import.meta.url));
const version='v0.0.0-20260925153657-d928b6ed57ee';
const cache=execFileSync(process.env.GO??'go',['env','GOMODCACHE'],{encoding:'utf8'}).trim();
const target=resolve(root,'.deps/native-registry');mkdirSync(target,{recursive:true});
const hashes={
 'arkade/engine.go':'aa229ea9d86e2db3713e2a220316d732364cf0dc1f624ed029b9df294d900469',
 'arkade/script.go':'a712cf4087cf579a4ef9a2e8e467e3f3fb00fc0b832cc82d568d7b1856123a5b',
 'arkade/opcode.go':'0e3ceadfdea7c394c8077d6a7da2d9668995c8c69f3451f45a6759a81e513d77',
 'emulator/service.go':'8dec76d4c1d6f602aa4c48933f974dc29292a3f8bfb5f6b96ba4564736c8cfc1',
 'emulator/tx.go':'7df63a6e984372e1940dfe04c16db466585656a49e6e2fa03694252c86e63c34'};
for(const [name,expected] of Object.entries(hashes)){const [module,file]=name.split('/');const source=join(cache,`github.com/arkade-os/emulator/pkg/${module}@${version}`,file);if(createHash('sha256').update(readFileSync(source)).digest('hex')!==expected)throw new Error(`Native registry base changed: ${name}`);}
function writable(path){if(!existsSync(path))return;for(const entry of readdirSync(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())writable(file);else chmodSync(file,0o644);}}
writable(target);
for(const name of ['arkade','emulator'])cpSync(join(cache,`github.com/arkade-os/emulator/pkg/${name}@${version}`),join(target,name),{recursive:true,force:true});
writable(target);
function patch(name,before,after){const file=join(target,name);let value=readFileSync(file,'utf8');if(!value.includes(before)||value.split(before).length!==2)throw new Error(`Patch context mismatch: ${name}`);writeFileSync(file,value.replace(before,after));}
patch('arkade/engine.go','type Engine struct {','type Engine struct {\n programRegistry *ProgramRegistry\n registryRaw []byte\n registryPackets *[4][]byte\n registryOldState []byte');
patch('arkade/script.go','if err := engine.Execute(); err != nil {','if err := engine.resolveRegisteredProgram(); err != nil { return fmt.Errorf("registered program: %w", err) }\n if err := engine.Execute(); err != nil {');
patch('arkade/opcode.go','content, err := findPacketByType(&vm.tx, uint8(packetType))','content, err := findPacketByType(&vm.tx, uint8(packetType))\n if vm.registryPackets != nil && packetType >= 0x80 && packetType <= 0x82 { content = vm.registryPackets[int(packetType)-0x80] }\n if packetType==0x83 { content,err=vm.registryState(content,false) }');
patch('arkade/opcode.go','content, err := findPacketByType(prevTx, uint8(packetType))','content, err := findPacketByType(prevTx, uint8(packetType))\n if packetType==0x83 { content,err=vm.registryState(content,true) }');
cpSync(join(root,'tools/native-registry/registry.go'),join(target,'arkade/registry.go'));
patch('emulator/service.go','type OffchainData struct {','type OffchainData struct {\n RegistrySidecar []byte');
patch('emulator/service.go','type service struct {','type service struct {\n programRegistry *arkade.ProgramRegistry');
writeFileSync(join(target,'emulator/registry.go'),`package emulator\nimport ("time";"github.com/arkade-os/emulator/pkg/arkade";"github.com/btcsuite/btcd/btcec/v2")\nfunc NewWithProgramRegistry(secret *btcec.PrivateKey, deprecated []*btcec.PrivateKey, until *time.Time, server *btcec.PublicKey, limits arkade.ComputeLimits, registry *arkade.ProgramRegistry)(Service,error){serviceValue,err:=New(secret,deprecated,until,server,limits);if err!=nil{return nil,err};serviceValue.(*service).programRegistry=registry;return serviceValue,nil}\n`);
patch('emulator/tx.go','arkade.WithExpiry(expiry),','arkade.WithExpiry(expiry),\n arkade.WithRegisteredPrograms(s.programRegistry, data.RegistrySidecar),');
let mod=readFileSync(join(root,'tools/vm/go.mod'),'utf8');for(const name of ['arkade','emulator'])mod+=`\nreplace github.com/arkade-os/emulator/pkg/${name} => ${JSON.stringify(join(target,name).replaceAll('\\','/'))}\n`;
writeFileSync(join(target,'vm.mod'),mod);cpSync(join(root,'tools/vm/go.sum'),join(target,'vm.sum'));
execFileSync(process.env.GO??'go',['fmt','./...'],{cwd:join(target,'arkade'),stdio:'inherit'});
execFileSync(process.env.GO??'go',['fmt','./...'],{cwd:join(target,'emulator'),stdio:'inherit'});
console.log('Pinned native registry patch applied in isolated dependency copy.');
