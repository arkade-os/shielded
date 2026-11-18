import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { prepareApplePasskeys } from './native-build.mjs';

assert.equal(process.platform, 'darwin', 'This check requires the macOS plutil executable');
const temporary = realpathSync(tmpdir()), prefix = 'shielded-apple-entitlements-';
const workspace = mkdtempSync(join(temporary, prefix));
const key = 'com.apple.developer.associated-domains', domain = 'webcredentials:shielded.mutinynet.arkade.sh';
const plist = file => {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { shell: false, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

try {
  const apple = join(workspace, 'src-tauri/gen/apple'), project = join(apple, 'Shielded.xcodeproj');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(apple, 'Shielded_iOS'));
  writeFileSync(join(workspace, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'io.arkade.shielded' }));
  const projectFile = join(project, 'project.pbxproj');
  const source = `// !$*UTF8*$!
{
  archiveVersion = 1;
  objectVersion = 56;
  objects = {
    application = { isa = PBXNativeTarget; productType = "com.apple.product-type.application"; buildConfigurationList = configurations; };
    configurations = { isa = XCConfigurationList; buildConfigurations = (debug, release); };
    debug = { isa = XCBuildConfiguration; name = Debug; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = io.arkade.shielded; CODE_SIGN_ENTITLEMENTS = "Shielded_iOS/Shielded_iOS.entitlements"; DEVELOPMENT_TEAM = "retained-fixture-team"; }; };
    release = { isa = XCBuildConfiguration; name = Release; buildSettings = { PRODUCT_BUNDLE_IDENTIFIER = io.arkade.shielded; CODE_SIGN_ENTITLEMENTS = "Shielded_iOS/Shielded_iOS.entitlements"; DEVELOPMENT_TEAM = "retained-fixture-team"; }; };
  };
  rootObject = application;
}`;
  writeFileSync(projectFile, source);
  const file = join(apple, 'Shielded_iOS/Shielded_iOS.entitlements');
  for (const existing of [false, true]) {
    const association = existing ? `<key>${key}</key><array><string>webcredentials:other.example</string></array>` : '';
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  ${association}
  <key>com.apple.security.device.camera</key><true/>
  <key>keychain-access-groups</key><array><string>existing-prefix.io.arkade.shielded</string></array>
  <key>get-task-allow</key><false/>
  <key>com</key><dict><key>apple</key><dict><key>developer</key><dict><key>retained</key><true/></dict></dict></dict>
</dict></plist>`);
    const before = plist(file);
    prepareApplePasskeys(workspace, { SHIELDED_APPLE_PASSKEYS: '1' });
    assert.deepEqual(plist(file), { ...before, [key]: [...existing ? ['webcredentials:other.example'] : [], domain] });
    assert.equal(readFileSync(projectFile, 'utf8'), source);
    const committed = readFileSync(file, 'utf8');
    prepareApplePasskeys(workspace, { SHIELDED_APPLE_PASSKEYS: '1' });
    assert.equal(readFileSync(file, 'utf8'), committed, 'preparation must be idempotent');
  }
  console.info('Apple entitlement preparation passed real plutil insert, replace, preservation and idempotence checks.');
} finally {
  const target = realpathSync(workspace);
  assert.equal(dirname(target), temporary);
  assert.ok(basename(target).startsWith(prefix));
  rmSync(target, { recursive: true, force: true });
}
