#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
OPENCC_SOURCE="${OPENCC_SOURCE:-$HOME/Local/Cloned/OpenCC}"
EMSDK="${EMSDK:-$HOME/Local/Cloned/emsdk}"
opencc_commit=$(node -p "require('./engine/upstream.lock.json').opencc.commit")
sdk_commit=$(node -p "require('./engine/upstream.lock.json').emsdk.commit")
sdk_version=$(node -p "require('./engine/upstream.lock.json').emsdk.version")
[ "$(git -C "$OPENCC_SOURCE" rev-parse HEAD)" = "$opencc_commit" ] || { echo 'OpenCC checkout differs from lock; refusing to change it.' >&2; exit 1; }
if ! git -C "$OPENCC_SOURCE" diff --quiet || ! git -C "$OPENCC_SOURCE" diff --cached --quiet; then
  echo 'OpenCC checkout has changes; refusing to build from ambiguous source.' >&2
  exit 1
fi
[ "$(git -C "$EMSDK" rev-parse HEAD)" = "$sdk_commit" ] || { echo 'emsdk checkout differs from lock; refusing to change it.' >&2; exit 1; }
if ! git -C "$EMSDK" diff --quiet || ! git -C "$EMSDK" diff --cached --quiet; then
  echo 'emsdk checkout has changes; refusing to use an ambiguous toolchain.' >&2
  exit 1
fi
# Use committed source, never patch or overwrite the external checkout.
SOURCE="$ROOT/build/source/opencc-$opencc_commit"
if [ ! -f "$SOURCE/.source-complete" ]; then
  [ ! -e "$SOURCE" ] || { echo 'Incomplete source extraction; inspect the build directory before retrying.' >&2; exit 1; }
  mkdir -p "$SOURCE"
  git -C "$OPENCC_SOURCE" archive "$opencc_commit" | tar -x -C "$SOURCE"
  touch "$SOURCE/.source-complete"
fi
# This environment change lasts only for this build subprocess.
set +u
source "$EMSDK/emsdk_env.sh" >/dev/null
set -u
emcc --version | grep -F "$sdk_version"
emcmake cmake -S "$ROOT/engine" -B "$ROOT/build/wasm" \
  -DOPENCC_SOURCE_DIR="$SOURCE" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
cmake --build "$ROOT/build/wasm" --target opencc_selection_engine --parallel 4
