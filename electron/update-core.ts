/**
 * The parts of the updater that don't need Electron (so they're tested with the rest):
 * reading GitHub's latest release, choosing the right file, checking a download is intact,
 * and the small script that swaps the app on a Mac.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export interface ReleaseAsset { name: string; url: string; size: number; sha256: string | null }
export interface Available { version: string; tag: string; notes: string; publishedAt: string; page: string; asset: ReleaseAsset }

/** "v1.2.10" → [1, 2, 10]; anything else → null. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The installer for this computer, named as the build names them. */
export function assetName(version: string, platform: string, arch: string): string | null {
  if (platform === 'darwin') return `Ledger-${version}-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  if (platform === 'win32') return `Ledger-Setup-${version}.exe`;
  return null;
}

/**
 * Looks at the latest GitHub release and returns it if it's newer than this version and has a file
 * for this computer. GitHub publishes a SHA-256 for every release file; we use it to check downloads.
 */
export async function latestRelease(repo: string, current: string, platform: string, arch: string, fetchImpl: typeof fetch = fetch, token?: string): Promise<Available | null> {
  // No sign-in needed for a public repo. A token is only used by the build's update test
  // (GitHub's shared build machines can hit the anonymous rate limit).
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ledger-desktop-updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r: any = await res.json();
  if (r.draft || r.prerelease) return null;
  const version = String(r.tag_name ?? '').replace(/^v/, '');
  if (!parseVersion(version) || !isNewer(version, current)) return null;
  const want = assetName(version, platform, arch);
  const a = (r.assets ?? []).find((x: any) => x.name === want);
  if (!a) return null;
  const digest = typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : null;
  return {
    version, tag: r.tag_name, notes: String(r.body ?? '').trim(), publishedAt: r.published_at, page: r.html_url,
    asset: { name: a.name, url: a.browser_download_url, size: a.size, sha256: digest },
  };
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** The download is the size GitHub says and (when GitHub gives one) has the right SHA-256. */
export async function verifyDownload(file: string, asset: ReleaseAsset): Promise<void> {
  const size = fs.statSync(file).size;
  if (size !== asset.size) throw new Error(`The download is incomplete (${size} of ${asset.size} bytes)`);
  if (asset.sha256) {
    const got = await sha256File(file);
    if (got !== asset.sha256) throw new Error("The download doesn't match the release (checksum differs)");
  }
}

/** Where a Mac app can be replaced in place; null with a reason when it can't. */
export function macAppPath(execPath: string, writable: (dir: string) => boolean): { app: string } | { reason: string } {
  const i = execPath.indexOf('.app/Contents/MacOS/');
  if (i < 0) return { reason: "Ledger isn't running as an installed app" };
  const app = execPath.slice(0, i + 4);
  if (app.startsWith('/Volumes/')) return { reason: 'Ledger is running from the disk image. Drag it to Applications first.' };
  if (app.includes('/AppTranslocation/')) return { reason: 'macOS is running Ledger from a temporary location. Move it to Applications (or open it once from there) and try again.' };
  const dir = app.slice(0, app.lastIndexOf('/'));
  if (!writable(dir)) return { reason: `Ledger can't write to ${dir}.` };
  return { app };
}

/**
 * Runs after Ledger quits: mounts the new disk image, copies the new app next to the old one,
 * swaps them, and opens it. If anything fails, the old app is put back and the disk image is
 * opened so the update can be installed by hand. Nothing is ever left half-replaced.
 */
export function macInstallScript(): string {
  return `#!/bin/bash
# Ledger updater: $1 = PID to wait for, $2 = new .dmg, $3 = installed .app, $4 = log file, $5 = "norelaunch" in tests
PID="$1"; DMG="$2"; APP="$3"; LOG="$4"; MODE="$5"
exec >>"$LOG" 2>&1
echo "$(date) updating $APP from $DMG"
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
MNT="$(mktemp -d /tmp/ledger-update.XXXXXX)"
fail() {
  echo "failed: $1"
  if [ ! -d "$APP" ] && [ -d "$APP.previous" ]; then mv "$APP.previous" "$APP"; fi
  hdiutil detach "$MNT" -quiet 2>/dev/null
  [ "$MODE" = "norelaunch" ] || { open "$DMG"; open "$APP"; }
  exit 1
}
hdiutil attach -nobrowse -noverify -readonly -mountpoint "$MNT" "$DMG" || fail "could not open the disk image"
SRC="$(ls -d "$MNT"/*.app 2>/dev/null | head -1)"
[ -n "$SRC" ] || fail "no app in the disk image"
NEW="$APP.new"
rm -rf "$NEW" "$APP.previous"
ditto "$SRC" "$NEW" || fail "could not copy the new version"
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null
mv "$APP" "$APP.previous" || fail "could not move the old version aside"
mv "$NEW" "$APP" || fail "could not put the new version in place"
rm -rf "$APP.previous"
hdiutil detach "$MNT" -quiet
rm -f "$DMG"
echo "$(date) updated"
[ "$MODE" = "norelaunch" ] || open "$APP"
`;
}
