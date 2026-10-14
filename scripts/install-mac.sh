#!/bin/sh
# Remote Hands installer for macOS. No administrator rights are needed.
#
# Open Terminal (Cmd+Space, type "Terminal", Enter) and paste this one line:
#
#   curl -fsSL https://raw.githubusercontent.com/Kushal-Padshala/remote-hands/main/scripts/install-mac.sh | sh
#
# It puts everything in your own ~/.remote-hands folder: its own copy of Node.js (so nothing already on your Mac can clash
# with it), the Remote Hands command line tool, and three small launchers (rh, remote-hands, rh-browser) that always use that
# copy of Node. Then it starts the guided setup. You can run it again at any time: that updates everything.
#
# Settings for testing: RH_SKIP_SETUP=1 stops before the guided setup; RH_PACKAGE=<npm spec or tarball> installs that instead
# of the published package.

main() {
  set -eu

  RH="${HOME}/.remote-hands"
  NODE_DIR="${RH}/node"
  NPM_PREFIX="${RH}/npm"
  BIN_DIR="${RH}/bin"
  NODE_BIN="${NODE_DIR}/bin/node"
  PACKAGE="${RH_PACKAGE:-remote-hands-cli}"
  CLI_ENTRY="${NPM_PREFIX}/lib/node_modules/remote-hands-cli/dist/index.js"
  NODE_MAJOR=22

  step() { printf '\n== %s\n' "$1"; }
  note() { printf '   %s\n' "$1"; }
  fail() {
    printf '\nCould not finish: %s\n' "$1" >&2
    printf 'Nothing is broken. You can run the same command again.\n' >&2
    exit 1
  }

  printf '\nRemote Hands for Mac\n'
  printf 'Press a shortcut anywhere on your Mac and tell it what to do.\n'

  step 'Checking this Mac'
  [ "$(uname -s)" = "Darwin" ] || fail 'This installer is for macOS. (Windows has its own: see the Remote Hands README.)'
  version="$(sw_vers -productVersion 2>/dev/null || echo 0)"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  case "$minor" in ''|*[!0-9]*) minor=0 ;; esac
  # Node.js 22 itself needs macOS 13.5 or newer
  if [ "$major" -lt 13 ] || { [ "$major" -eq 13 ] && [ "$minor" -lt 5 ]; }; then
    fail "Remote Hands needs macOS 13.5 or newer (this Mac has $version). Update macOS in System Settings > General > Software Update."
  fi
  note "macOS $version: OK"
  command -v curl >/dev/null 2>&1 || fail 'curl was not found.'

  arch="x64"
  if [ "$(uname -m)" = "arm64" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then arch="arm64"; fi

  step 'Node.js (a private copy, used only by Remote Hands)'
  if node_ok; then
    note "Already installed ($("$NODE_BIN" --version)): OK"
  else
    install_node
    node_ok || fail 'Node.js was installed but could not be started. Please try again, or ask for help with this message.'
  fi

  step 'Remote Hands'
  npm_cli="${NODE_DIR}/lib/node_modules/npm/bin/npm-cli.js"
  [ -f "$npm_cli" ] || fail 'npm was not found in the Node.js that was installed.'
  mkdir -p "$NPM_PREFIX" "$BIN_DIR"
  note 'Installing the Remote Hands command line tool...'
  # The folder is given on the command line, so no setting on this Mac (a project file, an old npm setup) can redirect it.
  PATH="${NODE_DIR}/bin:${PATH}" "$NODE_BIN" "$npm_cli" install -g "$PACKAGE" --prefix "$NPM_PREFIX" \
    || fail 'Installing Remote Hands failed (see the messages above).'
  [ -f "$CLI_ENTRY" ] || fail "Remote Hands was installed but its program file is missing in $NPM_PREFIX."
  write_launchers
  add_to_path
  note 'Installed.'

  if [ "${RH_SKIP_SETUP:-}" = "1" ]; then
    printf '\nInstalled. Run the guided setup with:  %s/rh setup --hud\n' "$BIN_DIR"
    return 0
  fi

  step 'Guided setup (a few questions, one sign-in and a few macOS switches)'
  printf '\n'
  # Piped from curl, this script owns the keyboard input; the questions must be read from the real terminal.
  if ( : </dev/tty ) 2>/dev/null; then
    # agy installs into ~/.local/bin, which a new Mac's PATH does not list yet; the private Node's npx must be found too
    if PATH="${NODE_DIR}/bin:${BIN_DIR}:${HOME}/.local/bin:${PATH}" "$NODE_BIN" "$CLI_ENTRY" setup --hud </dev/tty; then
      printf '\nSetup finished. To check that everything is ready, open a new Terminal window and type:  rh doctor\n'
    else
      printf '\nSetup did not finish. Fix what it says above, then run:  rh setup --hud\n' >&2
      printf '(If "rh" is not found, open a new Terminal window first.)\n' >&2
      return 1
    fi
  else
    printf 'No terminal is available for the guided setup. Open Terminal and run:  %s/rh setup --hud\n' "$BIN_DIR"
  fi
}

# True when the private Node.js exists and is new enough (22.13 or newer, 23.4 or newer, or 24+).
node_ok() {
  [ -x "$NODE_BIN" ] || return 1
  v="$("$NODE_BIN" --version 2>/dev/null)" || return 1
  v="${v#v}"
  maj="${v%%.*}"
  r="${v#*.}"
  min="${r%%.*}"
  case "$maj" in ''|*[!0-9]*) return 1 ;; esac
  case "$min" in ''|*[!0-9]*) return 1 ;; esac
  [ "$maj" -ge 24 ] && return 0
  [ "$maj" -eq 23 ] && [ "$min" -ge 4 ] && return 0
  [ "$maj" -eq 22 ] && [ "$min" -ge 13 ] && return 0
  return 1
}

# Downloads the newest Node.js 22 (checked against its published checksum) and unpacks it in ~/.remote-hands/node.
install_node() {
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  note 'Looking up the current Node.js release...'
  work="$(mktemp -d "${TMPDIR:-/tmp}/remote-hands-node.XXXXXX")" || fail 'Could not create a temporary folder.'
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT INT TERM
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt" || fail 'Could not reach nodejs.org. Check your internet connection and try again.'
  line="$(grep " node-v[0-9.]*-darwin-${arch}\.tar\.gz\$" "$work/SHASUMS256.txt" | head -n 1)"
  [ -n "$line" ] || fail 'Could not find a suitable Node.js release on nodejs.org.'
  expected="${line%% *}"
  file="${line##* }"
  note "Downloading ${file%.tar.gz} (about 45 MB)..."
  if [ -t 1 ]; then progress="--progress-bar"; else progress="-sS"; fi
  curl -fL "$progress" "$base/$file" -o "$work/$file" || fail 'The Node.js download failed. Please try again.'
  actual="$(shasum -a 256 "$work/$file" | cut -d ' ' -f 1)"
  [ "$expected" = "$actual" ] || fail 'The Node.js download did not match its checksum, so it was not installed. Please try again.'
  tar -xzf "$work/$file" -C "$work" || fail 'Could not unpack Node.js.'
  inner="$work/${file%.tar.gz}"
  [ -d "$inner" ] || fail 'The Node.js download had an unexpected layout.'
  mkdir -p "$RH"
  # Replace an older private copy; a running Remote Hands keeps using the old files until it restarts.
  if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$work/old-node"; fi
  mv "$inner" "$NODE_DIR"
  note "Node.js installed."
  rm -rf "$work"
  trap - EXIT INT TERM
}

# Launchers that always run Remote Hands with its own Node.js, whatever else is installed or first on PATH. The private Node's
# folder is put on PATH for what Remote Hands starts (npx for the phone setup), but not for the person's own shell.
write_launchers() {
  for name in rh remote-hands rh-browser; do
    # rh-browser is the same program started as "rh browser" (it used to find that out from its own file name)
    extra=""
    if [ "$name" = "rh-browser" ]; then extra=" browser"; fi
    {
      printf '#!/bin/sh\n'
      printf '# Written by the Remote Hands installer.\n'
      printf 'PATH="$HOME/.remote-hands/node/bin:$PATH"\n'
      printf 'export PATH\n'
      printf 'exec "$HOME/.remote-hands/node/bin/node" "$HOME/.remote-hands/npm/lib/node_modules/remote-hands-cli/dist/index.js"%s "$@"\n' "$extra"
    } > "$BIN_DIR/$name"
    chmod 755 "$BIN_DIR/$name"
  done
}

# Puts ~/.remote-hands/bin first on PATH for new Terminal windows (once; running it again changes nothing).
add_to_path() {
  line='export PATH="$HOME/.remote-hands/bin:$PATH"  # remote-hands'
  added=""
  for rc in "$HOME/.zprofile" "$HOME/.zshrc"; do
    if [ ! -f "$rc" ] || ! grep -Fq '# remote-hands' "$rc" 2>/dev/null; then
      printf '\n%s\n' "$line" >> "$rc"
      added="$added $(basename "$rc")"
    fi
  done
  # bash reads the first of these that exists; a person on bash with none of them gets a new .bash_profile
  bash_rc=""
  for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -f "$candidate" ]; then bash_rc="$candidate"; break; fi
  done
  if [ -z "$bash_rc" ]; then
    case "${SHELL:-}" in */bash) bash_rc="$HOME/.bash_profile" ;; esac
  fi
  if [ -n "$bash_rc" ] && ! grep -Fq '# remote-hands' "$bash_rc" 2>/dev/null; then
    printf '\n%s\n' "$line" >> "$bash_rc"
    added="$added $(basename "$bash_rc")"
  fi
  existing="$(command -v rh 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "$BIN_DIR/rh" ]; then
    note "Another rh command exists at $existing. New Terminal windows use the one installed here first."
  fi
  if [ -n "$added" ]; then note "The commands rh and remote-hands are ready in new Terminal windows (added to:$added)."; fi
}

main "$@"
