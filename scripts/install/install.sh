#!/bin/sh
# AI Board Runner installer for macOS and Linux:
#   curl -fsSL https://aiboard.me/install.sh | sh
# Installs for the current user only (no sudo) into ~/.aiboard, verifies the signed release manifest
# with openssl and the bundle's SHA-256 before anything is extracted, and adds ~/.aiboard/bin to PATH
# in your shell profile. Set AIBOARD_NO_MODIFY_PATH=1 to leave profiles alone. Uninstall: aiboard uninstall
# This file is generated from scripts/install/install.sh by scripts/release/render-installers.mjs.
set -eu

MANIFEST_URL='__AIBOARD_MANIFEST_URL__'
ARTIFACT_PREFIX='__AIBOARD_ARTIFACT_PREFIX__'
CHANNEL='__AIBOARD_CHANNEL__'
EPOCH=__AIBOARD_EPOCH__
ANCHOR_DIGEST='__AIBOARD_ANCHOR_DIGEST__'
TRUST_CONFIG='__AIBOARD_TRUST_CONFIG__'
MIN_SEQUENCE=__AIBOARD_MIN_SEQUENCE__
ALLOW_LOOPBACK=__AIBOARD_ALLOW_LOOPBACK_SH__
INSTALLER_PROTOCOL=2
# "<key id> <base64 DER SubjectPublicKeyInfo>" per line.
TRUSTED_KEYS='__AIBOARD_TRUSTED_KEYS_SH__'
RECOVERY_KEYS='__AIBOARD_RECOVERY_KEYS_SH__'

# Color only on a terminal; NO_COLOR turns it off and FORCE_COLOR decides when set (0/false: off).
if [ -n "${FORCE_COLOR:-}" ]; then
  case "$FORCE_COLOR" in 0|false) AIB_COLOR= ;; *) AIB_COLOR=1 ;; esac
elif [ -z "${NO_COLOR:-}" ] && [ -t 1 ] && [ "${TERM:-}" != dumb ]; then AIB_COLOR=1
else AIB_COLOR=
fi
paint() { if [ -n "$AIB_COLOR" ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi; }
say() { printf '%s\n' "$*"; }
fail() { printf '%s %s\n' "$(paint '1;31' 'AIBoard install failed:')" "$*" >&2; exit 1; }
# Prints how to install Git when it is missing (macOS ships a /usr/bin/git stub until the developer tools exist).
git_hint() {
  if [ "$(uname -s)" = Darwin ]; then
    if command -v git >/dev/null 2>&1 && { [ "$(command -v git)" != /usr/bin/git ] || xcode-select -p >/dev/null 2>&1; }; then return 0; fi
    printf '%s' 'Install it with: xcode-select --install'
  else
    command -v git >/dev/null 2>&1 && return 0
    printf '%s' 'Install it with your package manager, for example: sudo apt install git'
  fi
}
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required${2:+ ($2)}."; }

allowed_url() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1:*/*) [ "$ALLOW_LOOPBACK" = 1 ] && return 0 ;;
  esac
  return 1
}

download() {
  allowed_url "$1" || fail "refusing a non-HTTPS download: $1"
  if command -v curl >/dev/null 2>&1; then
    if [ "$ALLOW_LOOPBACK" = 1 ]; then
      curl -fsSL --retry 2 -o "$2" "$1" || fail "could not download $1. Check your connection and retry; nothing was changed."
    else
      curl -fsSL --retry 2 --proto =https --proto-redir =https -o "$2" "$1" || fail "could not download $1. Check your connection and retry; nothing was changed."
    fi
  else
    wget_checked "$1" "$2" || fail "could not download $1. Check your connection and retry; nothing was changed."
  fi
}

# wget has no option that keeps redirects on HTTPS, so redirects are followed by hand (at most 5) and
# every hop is checked with allowed_url before it is contacted. Needs GNU wget (--max-redirect, -S).
wget_checked() {
  wget --version 2>/dev/null | grep -q 'GNU Wget' || fail "curl or GNU wget is required."
  wget_next=$1
  wget_hop=0
  while :; do
    allowed_url "$wget_next" || fail "refusing a non-HTTPS download or redirect: $wget_next"
    if wget -S --max-redirect=0 -O "$2" "$wget_next" 2> "$2.headers"; then rm -f "$2.headers"; return 0; fi
    wget_location=$(sed -n 's/^ *[Ll]ocation: *\([^[:space:]]*\).*/\1/p' "$2.headers" | tail -n 1)
    rm -f "$2.headers"
    case "$wget_location" in
      https://*|http://*) wget_next=$wget_location ;;
      /*) wget_next=$(printf '%s' "$wget_next" | sed 's#^\([a-z]*://[^/]*\).*#\1#')$wget_location ;;
      *) return 1 ;;
    esac
    wget_hop=$((wget_hop + 1))
    [ "$wget_hop" -le 5 ] || fail "too many redirects downloading $1."
  done
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  fi
}

# Runs a staged-bundle command for at most $1 seconds, its output in $2. A command that outlives the bound
# gets TERM, then KILL, and is reaped by `wait` before this returns, so the install lock and staging are
# never released while it can still run. Returns 124 on timeout, otherwise the command's status.
run_bounded() {
  bounded_limit=$1; bounded_output=$2; shift 2
  rm -f "$bounded_output.timeout"
  "$@" > "$bounded_output" 2>&1 &
  bounded_child=$!
  (
    bounded_sleep=""
    trap '[ -z "$bounded_sleep" ] || kill "$bounded_sleep" 2>/dev/null; exit 0' TERM
    sleep "$bounded_limit" & bounded_sleep=$!
    wait "$bounded_sleep"
    : > "$bounded_output.timeout"
    kill -TERM "$bounded_child" 2>/dev/null || exit 0
    sleep 5 & bounded_sleep=$!
    wait "$bounded_sleep"
    kill -KILL "$bounded_child" 2>/dev/null || true
  ) &
  bounded_watchdog=$!
  bounded_status=0
  wait "$bounded_child" || bounded_status=$?
  kill -TERM "$bounded_watchdog" 2>/dev/null || true
  wait "$bounded_watchdog" 2>/dev/null || true
  if [ -f "$bounded_output.timeout" ]; then return 124; fi
  return "$bounded_status"
}

# Top-level members of the canonical manifest are one per line: "name":value,
manifest_value() { sed -n "s/^\"$1\":\(.*\),\$/\1/p" "$2"; }
unquote() { printf '%s' "$1" | sed -n 's/^"\([^"\\]*\)"$/\1/p'; }
digits() { printf '%s' "$1" | tr -cd '0-9'; }

check_recorded_sequence() {
  recorded=$(cat "$root/sequence" 2>/dev/null || true)
  recorded_anchor=$(cat "$root/sequence-anchor" 2>/dev/null || true)
  if [ -f "$root/sequence-anchor" ] && [ -z "$recorded_anchor" ]; then fail "$root/sequence-anchor is corrupt."; fi
  if [ -n "$recorded_anchor" ]; then
    printf '%s' "$recorded_anchor" | grep -Eq '^[0-9a-f]{64}$' || fail "$root/sequence-anchor is corrupt."
    [ "$recorded_anchor" = "$ANCHOR_DIGEST" ] || recorded=""
  else recorded=""; fi
  if [ -f "$root/sequence" ] && [ -z "$recorded" ] && [ "$recorded_anchor" = "$ANCHOR_DIGEST" ]; then fail "$root/sequence is corrupt."; fi
  if [ -n "$recorded" ]; then
    printf '%s' "$recorded" | grep -Eq '^((0|[1-9][0-9]*):)?[1-9][0-9]*$' || fail "$root/sequence is corrupt."
    case "$recorded" in *:*) recorded_epoch=${recorded%%:*}; recorded_sequence=${recorded#*:} ;; *) recorded_epoch=0; recorded_sequence=$recorded ;; esac
    [ "${#recorded_epoch}" -le 7 ] && [ "${#recorded_sequence}" -le 13 ] && [ "$recorded_epoch" -le 1048576 ] && [ "$recorded_sequence" -ge 1 ] && [ "$recorded_sequence" -le 1099511627776 ] || fail "$root/sequence is corrupt."
    if [ "$epoch" -lt "$recorded_epoch" ] || { [ "$epoch" -eq "$recorded_epoch" ] && [ "$sequence" -lt "$recorded_sequence" ]; }; then fail "this machine already accepted a newer AIBoard release; refusing an older manifest."; fi
  fi
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi ;;
    Linux) os=linux
      if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
        fail "this Linux uses musl libc (for example Alpine); AI Board Runner needs a glibc-based distribution."
      fi ;;
    *) fail "unsupported operating system $os; on Windows run: irm https://aiboard.me/install.ps1 | iex" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "unsupported processor architecture $arch (x64 or arm64 is required)." ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

main() {
  [ -n "${HOME:-}" ] || fail "HOME is not set."
  if [ "$(id -u)" = 0 ] && [ "${AIBOARD_ALLOW_ROOT:-}" != 1 ]; then
    fail "do not run the installer as root or with sudo; it installs for your user only."
  fi
  [ -n "$TRUSTED_KEYS" ] || fail "AI Board Runner has not been released through the installer yet. See https://aiboard.me/runner-guide."
  need openssl "install it with your package manager, for example: sudo apt install openssl"
  need tar; need gzip; need sed; need grep; need fold; need mktemp; need uname
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "curl or wget is required."

  target=$(detect_target)
  root="$HOME/.aiboard"
  work=$(mktemp -d "${TMPDIR:-/tmp}/aiboard-install.XXXXXX")
  lock=""
  lock_owner=""
  staging=""
  trap 'rm -rf "$work"; if [ -n "$staging" ]; then rm -rf "$staging"; fi; if [ -n "$lock" ]; then if [ -f "$lock_owner" ] && [ "$(cat "$lock_owner" 2>/dev/null)" = "$$" ]; then rm -f "$lock_owner" && rmdir "$lock" 2>/dev/null || printf "Could not release install lock %s; confirm no install, update, or uninstall is running before removing it.\n" "$lock" >&2; else printf "Install lock ownership could not be verified: %s\n" "$lock" >&2; fi; fi' EXIT
  trap 'exit 1' INT TERM

  # 1. Signed manifest: the signature is checked before the bytes are parsed or any URL/hash is used.
  manifest="$work/manifest.json"
  download "$MANIFEST_URL" "$manifest"
  download "$MANIFEST_URL.sig" "$work/manifest.sig.b64"
  [ "$(wc -c < "$manifest" | tr -d ' ')" -le 65536 ] || fail "the release manifest is too large."
  tr -d ' \r\n' < "$work/manifest.sig.b64" | openssl base64 -d -A -out "$work/manifest.sig" 2>/dev/null || fail "the release signature is not valid base64."
  signer=""
  signer_role=""
  printf '%s\n' "$TRUSTED_KEYS" | sed 's/^/ordinary /' > "$work/keys"
  printf '%s\n' "$RECOVERY_KEYS" | sed 's/^/recovery /' >> "$work/keys"
  while read -r key_role key_id key_der; do
    [ -n "$key_id" ] || continue
    { echo "-----BEGIN PUBLIC KEY-----"; printf '%s\n' "$key_der" | fold -w 64; echo "-----END PUBLIC KEY-----"; } > "$work/key.pem"
    if openssl dgst -sha256 -verify "$work/key.pem" -signature "$work/manifest.sig" "$manifest" >/dev/null 2>&1; then
      signer=$key_id; signer_role=$key_role; break
    fi
  done < "$work/keys"
  [ -n "$signer" ] || fail "the release manifest signature does not verify against the trusted AIBoard release key. Nothing was installed."

  [ "$(head -n 1 "$manifest")" = "{" ] || fail "the release manifest is not in the expected format."
  schema=$(manifest_value schemaVersion "$manifest")
  case "$schema" in 1) epoch=0 ;; 2) epoch=$(manifest_value epoch "$manifest") ;; *) fail "unsupported release manifest version." ;; esac
  case "$epoch" in ''|*[!0-9]*) fail "the release manifest has an invalid epoch." ;; esac
  [ "${#epoch}" -le 7 ] && [ "$epoch" -le 1048576 ] || fail "the release manifest has an invalid epoch."
  [ "$epoch" -ge "$EPOCH" ] || fail "the release manifest is from an older epoch."
  if [ "$epoch" -gt "$EPOCH" ]; then
    [ "$signer_role" = recovery ] || fail "a new epoch requires a recovery signature."
    signing_keys=$(manifest_value signingKeys "$manifest")
    [ "$signing_keys" != '[]' ] && [ -n "$signing_keys" ] || fail "a new epoch needs signing keys."
  else
    [ "$signer_role" = ordinary ] || fail "a recovery key cannot sign an ordinary release."
  fi
  [ "$(unquote "$(manifest_value product "$manifest")")" = aiboard-runner ] || fail "the release manifest is for another product."
  [ "$(unquote "$(manifest_value channel "$manifest")")" = "$CHANNEL" ] || fail "the release manifest is for another channel."
  [ "$(unquote "$(manifest_value keyId "$manifest")")" = "$signer" ] || fail "the release manifest names a different key than the one that signed it."
  min_installer=$(manifest_value minInstallerVersion "$manifest")
  case "$min_installer" in ''|*[!0-9]*) fail "the release manifest is invalid." ;; esac
  [ "$min_installer" -le "$INSTALLER_PROTOCOL" ] || fail "this release needs a newer installer; download it again from https://aiboard.me."
  expires=$(digits "$(unquote "$(manifest_value expiresAt "$manifest")")")
  [ "${#expires}" = 14 ] || fail "the release manifest has an invalid expiry."
  [ "$expires" -gt "$(date -u +%Y%m%d%H%M%S)" ] || fail "the release manifest has expired; try again later."
  version=$(unquote "$(manifest_value version "$manifest")")
  printf '%s' "$version" | grep -Eq '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})(-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$' || fail "the release manifest has an invalid version."
  sequence=$(manifest_value sequence "$manifest")
  case "$sequence" in ''|*[!0-9]*) fail "the release manifest is invalid." ;; esac
  [ "${#sequence}" -le 13 ] && [ "$sequence" -ge 1 ] && [ "$sequence" -le 1099511627776 ] || fail "the release manifest has an invalid sequence."
  if [ "$epoch" -eq "$EPOCH" ]; then [ "$sequence" -ge "$MIN_SEQUENCE" ] || fail "the release manifest is older than this installer allows (possible replay)."; fi
  [ "$(grep -c "^{\"target\":\"$target\"," "$manifest")" = 1 ] || fail "the release has no bundle for $target."
  line=$(grep "^{\"target\":\"$target\"," "$manifest")
  url=$(printf '%s' "$line" | sed -n 's/.*"url":"\([^"\\]*\)"}.*/\1/p')
  sha=$(printf '%s' "$line" | sed -n 's/.*"sha256":"\([0-9a-f]\{64\}\)".*/\1/p')
  bytes=$(printf '%s' "$line" | sed -n 's/.*"bytes":\([0-9][0-9]*\),.*/\1/p')
  printf '%s' "$line" | grep -q '"format":"tar.gz"' || fail "the release manifest entry is invalid."
  [ -n "$url" ] && [ -n "$sha" ] && [ -n "$bytes" ] || fail "the release manifest entry is invalid."
  case "$url" in "$ARTIFACT_PREFIX"*) ;; *) fail "the bundle is not hosted on the approved release origin." ;; esac
  allowed_url "$url" || fail "the bundle is not served over HTTPS."
  if printf '%s' "$line" | grep -q '"preview":true'; then say "Note: $target is a preview build."; fi

  # 2. Per-user lock shared with `aiboard update` / `aiboard uninstall`.
  mkdir -p "$root/versions"
  if ! mkdir "$root/install.lock" 2>/dev/null; then
    fail "the install lock exists. After confirming no install, update, or uninstall is running, delete $root/install.lock and retry."
  fi
  pending_owner="$root/install.lock/owner-${work##*/}-$$"
  (umask 077; printf '%s' "$$" > "$pending_owner") || fail "could not record install lock ownership; the lock was retained."
  lock="$root/install.lock"
  lock_owner="$pending_owner"

  check_recorded_sequence
  current=$(cat "$root/current" 2>/dev/null || true)
  destination="$root/versions/$version"

  cat > "$work/verify-inventory.cjs" <<'NODE'
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const [verified, dir, version, target] = process.argv.slice(2);
if (!readFileSync(resolve(verified, 'release.json')).equals(readFileSync(resolve(dir, 'release.json')))) throw new Error('release inventory differs from signed bundle');
import(pathToFileURL(resolve(verified, 'app/runner-v2/src/self-update.js')).href)
  .then(m => m.verifyVersionDirectory(dir, { version, target }))
  .catch(e => { console.error(e.message); process.exitCode = 1; });
NODE
    # 3. Bundle: size and SHA-256 must match the signed manifest before extraction.
    archive="$work/aiboard-$version-$target.tar.gz"
    say "Downloading AI Board Runner $version for $target..."
    download "$url" "$archive"
    [ "$(wc -c < "$archive" | tr -d ' ')" = "$bytes" ] || fail "the downloaded bundle has the wrong size. Nothing was installed."
    [ "$(sha256_of "$archive")" = "$sha" ] || fail "the downloaded bundle does not match the signed checksum. Nothing was installed."

    # 4. Refuse links, special files, traversal and oversize content, then extract into fresh staging.
    tar -tzvf "$archive" > "$work/listing" || fail "the bundle is not a valid archive."
    if grep -v '^[-d]' "$work/listing" | grep -q .; then fail "the bundle contains links or special files."; fi
    tar -tzf "$archive" > "$work/names"
    [ "$(wc -l < "$work/names" | tr -d ' ')" -le 40000 ] || fail "the bundle has too many entries."
    if grep -Eq '^/|(^|/)\.\.?(/|$)|\\' "$work/names"; then fail "the bundle contains an unsafe path."; fi
    [ "$(gzip -dc "$archive" | wc -c | tr -d ' ')" -le 1610612736 ] || fail "the bundle is larger than allowed."
    staging="$root/versions/.s-$$"
    rm -rf "$staging"
    mkdir "$staging"
    (cd "$staging" && tar -xzf "$archive") || fail "could not extract the bundle."
    grep -q "^ \"version\": \"$version\",\$" "$staging/release.json" && grep -q "^ \"target\": \"$target\",\$" "$staging/release.json" \
      || fail "the bundle does not describe the release it was published as."

    # The archive's signed checksum authenticates the bundled Node and verifier before they run.
    run_bounded 600 "$work/inventory.log" "$staging/node/node" "$work/verify-inventory.cjs" "$staging" "$staging" "$version" "$target" || fail "bundle inventory verification failed or did not finish within 600 seconds. Nothing was installed. $(cat "$work/inventory.log")"

    # Schema 2 is checked again by the authenticated bundle's verifier, including canonical bytes and key shape.
    printf '%s' "$TRUST_CONFIG" > "$work/trust-config.json"
    printf '%s' "$TRUST_CONFIG" > "$work/next-trust.json"
    printf '%s' "$ANCHOR_DIGEST" > "$work/next-anchor"
    if [ "$schema" = 2 ]; then
      cat > "$work/verify-trust.cjs" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const [dir, manifest, signature, configPath, out, anchor] = process.argv.slice(2);
import(pathToFileURL(resolve(dir, 'app/runner-v2/src/release-manifest.js')).href).then(m => {
  const config = m.parseReleaseChannelConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const release = m.verifyReleaseManifest(readFileSync(manifest), readFileSync(signature, 'utf8'), config, { now: new Date() });
  const next = release.epoch > config.epoch ? m.parseReleaseChannelConfig({ ...config, epoch: release.epoch, keys: release.signingKeys, minSequence: 1 }) : config;
  writeFileSync(out, JSON.stringify(next), { mode: 0o600 });
  writeFileSync(anchor, m.releaseAnchorDigest(next), { mode: 0o600 });
}).catch(e => { console.error(e.message); process.exitCode = 1; });
NODE
      run_bounded 120 "$work/trust.log" "$staging/node/node" "$work/verify-trust.cjs" "$staging" "$manifest" "$work/manifest.sig.b64" "$work/trust-config.json" "$work/next-trust.json" "$work/next-anchor" || fail "release trust verification failed. Nothing was installed. $(cat "$work/trust.log")"
    fi

    # 5. Bounded smoke check with the bundle's own Node before switching.
    run_bounded 120 "$work/smoke.log" "$staging/node/node" "$staging/app/runner-v2/bin/aiboard.mjs" version || fail "the new version did not start within 120 seconds: $(cat "$work/smoke.log")"
    smoke=$(cat "$work/smoke.log")
    [ "$smoke" = "AIBoard Runner V2 $version" ] || fail "the new version did not start: $smoke"
    if [ "$current" = "$version" ] && [ -d "$destination" ]; then
      run_bounded 600 "$work/inventory.log" "$staging/node/node" "$work/verify-inventory.cjs" "$staging" "$destination" "$version" "$target" || fail "the existing version failed its inventory check. After stopping all AIBoard processes, remove $destination and run the installer again. $(cat "$work/inventory.log")"
      [ -x "$destination/node/node" ] || fail "the existing version's Node runtime is not executable. After stopping all AIBoard processes, remove $destination and run the installer again."
      say "AI Board Runner $version is already installed; repairing the command and PATH."
    else
      rm -rf "$destination"
      mv "$staging" "$destination"
      staging=""
    fi

  # 6. Command shim, then the atomic version switch.
  mkdir -p "$root/bin"
  cat > "$root/bin/aiboard.tmp" <<'SHIM'
#!/bin/sh
# AI Board Runner command (managed by the installer; see aiboard uninstall).
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1
version=$(cat "$root/current" 2>/dev/null) || version=""
case "$version" in
  ''|*[!0-9A-Za-z.-]*) echo "aiboard: no active version; reinstall with: curl -fsSL https://aiboard.me/install.sh | sh" >&2; exit 1 ;;
esac
exec "$root/versions/$version/node/node" "$root/versions/$version/app/runner-v2/bin/aiboard.mjs" "$@"
SHIM
  chmod 755 "$root/bin/aiboard.tmp"
  mv -f "$root/bin/aiboard.tmp" "$root/bin/aiboard"
  (umask 077; cat "$work/next-trust.json" > "$root/trusted-channel.json.tmp" && mv -f "$root/trusted-channel.json.tmp" "$root/trusted-channel.json")
  (umask 077; printf '%s:%s' "$epoch" "$sequence" > "$root/sequence.tmp" && mv -f "$root/sequence.tmp" "$root/sequence")
  (umask 077; cat "$work/next-anchor" > "$root/sequence-anchor.tmp" && mv -f "$root/sequence-anchor.tmp" "$root/sequence-anchor")
  if [ -n "$current" ] && [ "$current" != "$version" ]; then
    printf '%s' "$current" > "$root/previous.tmp" && mv -f "$root/previous.tmp" "$root/previous"
  fi
  printf '%s' "$version" > "$root/current.tmp" && mv -f "$root/current.tmp" "$root/current"
  [ -f "$root/install.json" ] || printf '{"schemaVersion":1,"product":"aiboard-runner","channel":"%s","installer":"install.sh"}\n' "$CHANNEL" > "$root/install.json"

  # 7. Keep the active and previous versions.
  previous=$(cat "$root/previous" 2>/dev/null || true)
  for dir in "$root/versions"/*; do
    [ -d "$dir" ] || continue
    name=${dir##*/}
    [ "$name" = "$version" ] || [ "$name" = "$previous" ] || rm -rf "$dir"
  done

  # 8. PATH in shell profiles (idempotent marked block).
  if [ "${AIBOARD_NO_MODIFY_PATH:-}" != 1 ]; then
    block='# >>> aiboard installer >>>
case ":${PATH}:" in *":$HOME/.aiboard/bin:"*) ;; *) export PATH="$HOME/.aiboard/bin:$PATH" ;; esac
# <<< aiboard installer <<<'
    profiles="$HOME/.profile"
    [ -f "$HOME/.bashrc" ] && profiles="$profiles $HOME/.bashrc"
    [ -f "$HOME/.bash_profile" ] && profiles="$profiles $HOME/.bash_profile"
    if [ -f "$HOME/.zshrc" ] || [ "$(basename "${SHELL:-}")" = zsh ] || [ "$(uname -s)" = Darwin ]; then profiles="$profiles $HOME/.zshrc"; fi
    for profile in $profiles; do
      if ! grep -q '^# >>> aiboard installer >>>$' "$profile" 2>/dev/null; then
        printf '\n%s\n' "$block" >> "$profile"
      fi
    done
    if [ -d "$HOME/.config/fish" ]; then
      mkdir -p "$HOME/.config/fish/conf.d"
      printf '%s\n' 'contains -- $HOME/.aiboard/bin $PATH; or set -gx PATH $HOME/.aiboard/bin $PATH' > "$HOME/.config/fish/conf.d/aiboard.fish"
    fi
  fi

  say ""
  say "$(paint '1;32' "AI Board Runner $version is installed in $root.")"
  say "Start it in a project folder:  $(paint 1 'aiboard')"
  say "Let ChatGPT or Claude use this computer:  $(paint 1 'aiboard remote')"
  say "Open a new terminal (or run: export PATH=\"\$HOME/.aiboard/bin:\$PATH\") if aiboard is not found. Update: aiboard update. Remove: aiboard uninstall."
  hint=$(git_hint)
  if [ -n "$hint" ]; then
    say ""
    say "$(paint '1;33' 'Note:') Git was not found. Chat and account providers work without it; Build mode needs Git. $hint, then run aiboard again."
  fi
}

main "$@"
