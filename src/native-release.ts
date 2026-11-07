export const NATIVE_RELEASE_ENDPOINT = '/api/native/releases';
export const NATIVE_RELEASE_MANIFEST_URL = 'https://raw.githubusercontent.com/arkade-os/shielded/native-mutinynet/latest.json';
export const NATIVE_RELEASE_ORIGIN = 'https://shielded.mutinynet.arkade.sh';

export type NativePlatform = 'windows-x86_64' | 'linux-x86_64' | 'macos-universal' | 'android-arm64' | 'ios';
export interface NativeReleasePackage {
  platform: NativePlatform;
  file: string;
  url: string;
  profile: 'release' | 'debug';
  requiresSigning: boolean;
  bytes: number;
  sha256: string;
}
export interface NativeRelease {
  schema: 1;
  channel: 'native-mutinynet';
  network: 'mutinynet';
  commit: string;
  buildNumber: number;
  version: string;
  publishedAt: string;
  releaseUrl: string;
  packages: NativeReleasePackage[];
}

export const NATIVE_PLATFORMS: readonly NativePlatform[] = ['windows-x86_64', 'linux-x86_64', 'macos-universal', 'android-arm64', 'ios'];
export const NATIVE_PACKAGE_MAX_BYTES = 2_147_483_647;
const releasesBase = 'https://github.com/arkade-os/shielded/releases';
const formats: Record<NativePlatform, readonly string[]> = {
  'windows-x86_64': ['.exe'], 'linux-x86_64': ['.deb', '.AppImage'],
  'macos-universal': ['.dmg', '.app.zip'], 'android-arm64': ['release.apk', 'debug.apk'],
  ios: ['.ipa', '-simulator.app.zip'],
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid native release object');
  return value as Record<string, unknown>;
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}
function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || /[%\\\s]/.test(value)) throw new Error('Invalid native release URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || url.href !== value) throw new Error('Invalid native release URL');
  return value;
}
function packageFormat(item: NativeReleasePackage): string {
  if (item.platform === 'android-arm64') return `${item.profile}.apk`;
  return formats[item.platform].find(format => item.file.endsWith(format)) ?? '';
}

export function parseNativeRelease(input: unknown): NativeRelease {
  const value = record(input);
  if (value.schema !== 1 || value.channel !== 'native-mutinynet' || value.network !== 'mutinynet') throw new Error('Invalid native release channel or network');
  if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit) || !positive(value.buildNumber)) throw new Error('Invalid native release identity');
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) || value.version.length > 64) throw new Error('Invalid native release version');
  if (typeof value.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt)) || new Date(value.publishedAt).toISOString().replace('.000Z', 'Z') !== value.publishedAt.replace('.000Z', 'Z')) throw new Error('Invalid native release publication time');
  const releaseUrl = safeUrl(value.releaseUrl);
  const tag = releaseUrl.slice(`${releasesBase}/tag/`.length);
  if (releaseUrl !== `${releasesBase}/tag/${tag}` || !/^native-mutinynet-[a-f0-9]{12,40}-run[1-9]\d*-attempt[1-9]\d*$/.test(tag) || !value.commit.startsWith(tag.split('-')[2])) throw new Error('Invalid native release repository or tag');
  if (!Array.isArray(value.packages) || value.packages.length < 9 || value.packages.length > 32) throw new Error('Incomplete native release packages');
  const files = new Set<string>(), urls = new Set<string>(), covered = new Set<string>();
  const packages = value.packages.map((raw): NativeReleasePackage => {
    const item = record(raw);
    if (!NATIVE_PLATFORMS.includes(item.platform as NativePlatform) || !['release', 'debug'].includes(item.profile as string) || typeof item.requiresSigning !== 'boolean') throw new Error('Invalid native package platform or profile');
    if (typeof item.file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(item.file) || item.file.includes('..') || !item.file.includes('mutinynet-') || !item.file.includes(item.platform as string) || !item.file.includes(`-${item.profile}-`)) throw new Error('Invalid native package filename');
    if (!positive(item.bytes, NATIVE_PACKAGE_MAX_BYTES) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid native package size or SHA256');
    const url = safeUrl(item.url);
    if (url !== `${releasesBase}/download/${tag}/${item.file}` || files.has(item.file) || urls.has(url)) throw new Error('Invalid or duplicate native package download');
    const result = { platform: item.platform, file: item.file, url, profile: item.profile, requiresSigning: item.requiresSigning, bytes: item.bytes, sha256: item.sha256 } as NativeReleasePackage;
    const format = packageFormat(result);
    const signing = (result.platform === 'android-arm64' && result.profile === 'release') || (result.platform === 'ios' && format === '.ipa');
    if (!format || (result.platform === 'android-arm64' && !result.file.endsWith('.apk')) || (result.platform !== 'android-arm64' && result.profile !== 'release') || signing !== result.requiresSigning || (signing && !result.file.includes('-unsigned-')) || (!signing && result.file.includes('-unsigned-'))) throw new Error('Invalid native package format or signing label');
    files.add(result.file); urls.add(url); covered.add(`${result.platform}:${format}`);
    return result;
  });
  for (const platform of NATIVE_PLATFORMS) for (const format of formats[platform]) if (!covered.has(`${platform}:${format}`)) throw new Error(`Incomplete native release: ${platform} ${format}`);
  return { schema: 1, channel: 'native-mutinynet', network: 'mutinynet', commit: value.commit, buildNumber: value.buildNumber, version: value.version, publishedAt: value.publishedAt, releaseUrl, packages };
}
