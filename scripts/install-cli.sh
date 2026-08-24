#!/bin/sh
# Copy herdr-dynamic-workflow next to the herdr binary (the directory already
# on PATH). Do not resolve Homebrew cellars: dirname of `command -v herdr` is
# /opt/homebrew/bin, not Cellar/herdr/<ver>/bin.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
src="$here/bin/herdr-dynamic-workflow"

if [ ! -f "$src" ]; then
  echo "install-cli: missing $src" >&2
  exit 1
fi

herdr=$(command -v herdr) || {
  echo "install-cli: herdr not found on PATH" >&2
  exit 1
}

bindir=$(dirname -- "$herdr")
dest="$bindir/herdr-dynamic-workflow"

if [ ! -w "$bindir" ]; then
  echo "install-cli: cannot write $dest (directory not writable)" >&2
  exit 1
fi

cp "$src" "$dest"
chmod +x "$dest"
echo "installed $dest"
