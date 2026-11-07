import type {NativePlatform} from '../../src/native-release.ts';

export function nativeReleaseFixture() {
  const commit = 'a'.repeat(40), tag = `native-mutinynet-${commit.slice(0, 12)}-run123-attempt1`;
  const packages = ([
    ['windows-x86_64', 'Shielded.exe', 'release', false],
    ['linux-x86_64', 'Shielded.deb', 'release', false], ['linux-x86_64', 'Shielded.AppImage', 'release', false],
    ['macos-universal', 'Shielded.dmg', 'release', false], ['macos-universal', 'Shielded.app.zip', 'release', false],
    ['android-arm64', 'Shielded.apk', 'release', true], ['android-arm64', 'Shielded.apk', 'debug', false],
    ['ios', 'Shielded.ipa', 'release', true], ['ios', 'Shielded-simulator.app.zip', 'release', false],
  ] as [NativePlatform, string, string, boolean][]).map(([platform, suffix, profile, requiresSigning]) => {
    const file = `shielded-mutinynet-${platform}-run123-mutinynet-${profile}${requiresSigning ? '-unsigned' : ''}-${suffix}`;
    return { platform, file, profile, requiresSigning, url: `https://github.com/arkade-os/shielded/releases/download/${tag}/${file}`, bytes: 100, sha256: 'b'.repeat(64) };
  });
  return { schema: 1, channel: 'native-mutinynet', network: 'mutinynet', commit, buildNumber: 123, version: '0.1.0', publishedAt: '2026-11-07T12:00:00Z', releaseUrl: `https://github.com/arkade-os/shielded/releases/tag/${tag}`, packages };
}
