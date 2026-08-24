#!/bin/sh
# Install a copy of the bundled authoring skill into detected agent clients.
# Herdr builds remote plugins in a temporary checkout before moving them, so
# this must copy the skill rather than leave symlinks to the build directory.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

npx --yes skills@1.5.23 add "$here" \
  --skill herdr-workflow-authoring \
  --global \
  --yes \
  --copy
