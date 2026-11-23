#!/bin/bash
set -euo pipefail
umask 077
root="${X2_INSTALL_DIR:-$HOME/.x2-install}"
source_url="https://raw.githubusercontent.com/Stanleyzrice/x2/main/ops/install"
mkdir -p "$root/runtime"
app="$root/app"
manifest="$root/runtime/pixi.toml"
export PIXI_HOME="$root/pixi" PIXI_NO_PATH_UPDATE=1 PIXI_NO_TELEMETRY=1
pixi="$PIXI_HOME/bin/pixi"

if [[ ! -x "$pixi" ]]; then
  curl -fsSL https://pixi.sh/install.sh -o "$root/runtime/pixi-install.sh"
  /bin/bash "$root/runtime/pixi-install.sh"
fi
if [[ ! -f "$manifest" ]]; then
  curl -fsSL "$source_url/pixi.toml" -o "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
fi

if [[ ! -d "$app/.git" ]]; then
  "$pixi" run --manifest-path "$manifest" git clone --depth 1 https://github.com/Stanleyzrice/x2.git "$app"
fi
cd "$app"
"$pixi" run --manifest-path "$manifest" npm exec --yes --package pnpm@10.18.3 -- pnpm --dir "$app" install --frozen-lockfile
exec "$pixi" run --manifest-path "$manifest" node "$app/ops/install/start.mjs" "$root" "$@"
