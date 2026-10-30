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
MIN_SEQUENCE=__AIBOARD_MIN_SEQUENCE__
ALLOW_LOOPBACK=__AIBOARD_ALLOW_LOOPBACK_SH__
INSTALLER_PROTOCOL=1
# "<key id> <base64 DER SubjectPublicKeyInfo>" per line.
TRUSTED_KEYS='__AIBOARD_TRUSTED_KEYS_SH__'

say() { printf '%s\n' "$*"; }
fail() { printf 'AIBoard install failed: %s\n' "$*" >&2; exit 1; }
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
    wget -q -O "$2" "$1" || fail "could not download $1. Check your connection and retry; nothing was changed."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  fi
}

# Top-level members of the canonical manifest are one per line: "name":value,
manifest_value() { sed -n "s/^\"$1\":\(.*\),\$/\1/p" "$2"; }
unquote() { printf '%s' "$1" | sed -n 's/^"\([^"\\]*\)"$/\1/p'; }
digits() { printf '%s' "$1" | tr -cd '0-9'; }

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
  staging=""
  trap 'rm -rf "$work"; if [ -n "$staging" ]; then rm -rf "$staging"; fi; if [ -n "$lock" ]; then rm -rf "$lock"; fi' EXIT
  trap 'exit 1' INT TERM

  # 1. Signed manifest: the signature is checked before the bytes are parsed or any URL/hash is used.
  manifest="$work/manifest.json"
  download "$MANIFEST_URL" "$manifest"
  download "$MANIFEST_URL.sig" "$work/manifest.sig.b64"
  [ "$(wc -c < "$manifest" | tr -d ' ')" -le 65536 ] || fail "the release manifest is too large."
  tr -d ' \r\n' < "$work/manifest.sig.b64" | openssl base64 -d -A -out "$work/manifest.sig" 2>/dev/null || fail "the release signature is not valid base64."
  signer=""
  printf '%s\n' "$TRUSTED_KEYS" > "$work/keys"
  while read -r key_id key_der; do
    [ -n "$key_id" ] || continue
    { echo "-----BEGIN PUBLIC KEY-----"; printf '%s\n' "$key_der" | fold -w 64; echo "-----END PUBLIC KEY-----"; } > "$work/key.pem"
    if openssl dgst -sha256 -verify "$work/key.pem" -signature "$work/manifest.sig" "$manifest" >/dev/null 2>&1; then
      signer=$key_id; break
    fi
  done < "$work/keys"
  [ -n "$signer" ] || fail "the release manifest signature does not verify against the trusted AIBoard release key. Nothing was installed."

  [ "$(head -n 1 "$manifest")" = "{" ] || fail "the release manifest is not in the expected format."
  [ "$(manifest_value schemaVersion "$manifest")" = 1 ] || fail "unsupported release manifest version."
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
  [ "$sequence" -ge "$MIN_SEQUENCE" ] || fail "the release manifest is older than this installer allows (possible replay)."
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
    owner=$(cat "$root/install.lock/pid" 2>/dev/null || true)
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then fail "another AIBoard install or update is running (process $owner)."; fi
    rm -rf "$root/install.lock"
    mkdir "$root/install.lock" || fail "could not take the install lock."
  fi
  lock="$root/install.lock"
  printf '%s' "$$" > "$lock/pid"

  recorded=$(cat "$root/sequence" 2>/dev/null || true)
  case "$recorded" in *[!0-9]*) fail "$root/sequence is corrupt; remove $root and reinstall." ;; esac
  if [ -n "$recorded" ] && [ "$sequence" -lt "$recorded" ]; then fail "this machine already accepted a newer AIBoard release; refusing an older manifest."; fi
  current=$(cat "$root/current" 2>/dev/null || true)
  destination="$root/versions/$version"

  if [ "$current" = "$version" ] && [ -x "$destination/node/node" ]; then
    say "AI Board Runner $version is already installed; repairing the command and PATH."
  else
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

    # 5. Bounded smoke check with the bundle's own Node before switching.
    smoke=$("$staging/node/node" "$staging/app/runner-v2/bin/aiboard.mjs" version 2>&1) || fail "the new version did not start: $smoke"
    [ "$smoke" = "AIBoard Runner V2 $version" ] || fail "the new version did not start: $smoke"
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
  highest=$sequence
  if [ -n "$recorded" ] && [ "$recorded" -gt "$highest" ]; then highest=$recorded; fi
  printf '%s' "$highest" > "$root/sequence.tmp" && mv -f "$root/sequence.tmp" "$root/sequence"
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
  say "AI Board Runner $version is installed in $root."
  say "Start it in a project folder:  aiboard"
  say "Let ChatGPT or Claude use this computer:  aiboard remote"
  say "Open a new terminal (or run: export PATH=\"\$HOME/.aiboard/bin:\$PATH\") if aiboard is not found. Update: aiboard update. Remove: aiboard uninstall."
}

main "$@"
