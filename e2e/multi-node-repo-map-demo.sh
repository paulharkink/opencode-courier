#!/usr/bin/env bash
# Private Polyrepo Coordinator fixture and evidence runner.
# Never edits or stops the existing remote-node demo, user config, or source checkouts.
set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
REMOTE_HOST=${COURIER_MRM_REMOTE_HOST:-dsowks132}
RUNTIME=${COURIER_MRM_OPENCODE_RUNTIME:-/Users/pharkink/sources/.opencode-courier-demo/runtime-2.0.32}
OC="$RUNTIME/node_modules/.bin/opencode"
NODE=${COURIER_MRM_NODE:-/Users/pharkink/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}
TAILSCALE=${COURIER_MRM_TAILSCALE:-/Applications/Tailscale.app/Contents/MacOS/Tailscale}
BUN=${COURIER_MRM_BUN:-$RUNTIME/node_modules/@oven/bun-darwin-aarch64/bin/bun}
WSL_RUNTIME=${COURIER_MRM_WSL_RUNTIME:-/home/pharkink/.local/share/courier-cross-node-demo/runtime}
WSL_OC=${COURIER_MRM_WSL_OC:-$WSL_RUNTIME/bin/opencode}
WSL_BUN_VERSION=1.3.14
CONFIG_SOURCE=${COURIER_MRM_CONFIG_SOURCE:-${HOME:?HOME must remain set}/.config/opencode/opencode.json}
AACT_LIVE_STATE=${COURIER_MRM_AACT_STATE_SOURCE:-${HOME:?HOME must remain set}/.local/state/agent-skills}
AACT_LIVE_CONFIG=${COURIER_MRM_AACT_CONFIG_SOURCE:-${HOME:?HOME must remain set}/.config/agent-skills}
AACT_SOURCE=${COURIER_MRM_AACT_SOURCE:-}
COURIER_SOURCE=${COURIER_MRM_COURIER_SOURCE:-$ROOT}
BASE=${COURIER_MRM_HOME:-}
MAC_PORT=${COURIER_MRM_MAC_PORT:-4830}
WSL_PORT=${COURIER_MRM_WSL_PORT:-4831}
MAC_HOOK_PORT=${COURIER_MRM_MAC_HOOK_PORT:-4832}
WSL_HOOK_PORT=${COURIER_MRM_WSL_HOOK_PORT:-4833}

die() { printf 'polyrepo fixture: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"; }
json() { jq -cn "$@"; }
hash_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}
mac_process_image() {
  python3 - "$1" <<'PY'
import ctypes, os, sys
pid = int(sys.argv[1])
libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
proc_pidpath = libproc.proc_pidpath
proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
proc_pidpath.restype = ctypes.c_int
buffer = ctypes.create_string_buffer(4096)
length = proc_pidpath(pid, buffer, len(buffer))
if length <= 0:
    raise SystemExit('could not verify the running Mac process image')
print(os.path.realpath(buffer.value.decode()))
PY
}

seed_private_opencode_config() {
  local source=$1 destination=$2
  # Keep only the selected Kinfer provider/model settings needed by this fixture. Live MCP
  # endpoints, plugins, agents, hooks, and every other user setting stay out of the run tree.
  jq '{
    "$schema": .["$schema"],
    model: (if ((.model // "") | startswith("kinfer/")) then .model else null end),
    provider: (if (.provider.kinfer // .providers.kinfer) != null then {kinfer:(.provider.kinfer // .providers.kinfer)} else null end),
    mcp: {"fixture-inert-mcp": {type:"local", command:["/usr/bin/false"], enabled:false}},
    plugins: ["fixture-unrelated-plugin"]
  } | with_entries(select(.value != null))' "$source" >"$destination"
  chmod 600 "$destination"
}

verify_private_opencode_config() {
  local config=$1
  jq -e '{mcpKeys:(.mcp|keys),plugins,providerKeys:(.provider|keys)} |
    .mcpKeys == ["fixture-inert-mcp"] and
    .plugins == ["fixture-unrelated-plugin"] and
    .providerKeys == ["kinfer"]' "$config" >/dev/null ||
    die 'private OpenCode config contains unexpected MCP/plugin/provider entries'
  printf 'PASS: isolated OpenCode config contains only Kinfer plus inert fixture sentinels; no live MCP entries were copied.\n'
}

snapshot_originals() {
  local destination=$1
  python3 - "$CONFIG_SOURCE" "$HOME/.config/opencode/opencode.json" "$HOME/.config/opencode/opencode.jsonc" "$AACT_LIVE_STATE" "$AACT_LIVE_CONFIG" <<'PY' >"$destination"
import hashlib, json, os, stat, sys

paths = sys.argv[1:]
def digest(path):
    if not os.path.lexists(path):
        return "missing"
    root = os.path.realpath(path)
    h = hashlib.sha256()
    def add_file(name):
        rel = os.path.relpath(name, root) if os.path.isdir(root) else os.path.basename(root)
        st = os.lstat(name)
        if stat.S_ISLNK(st.st_mode):
            h.update(b"L\0" + rel.encode() + b"\0" + os.readlink(name).encode() + b"\0")
        elif stat.S_ISREG(st.st_mode):
            h.update(b"F\0" + rel.encode() + b"\0" + str(stat.S_IMODE(st.st_mode)).encode() + b"\0")
            with open(name, "rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    h.update(chunk)
    if os.path.isdir(root):
        for current, dirs, files in os.walk(root, followlinks=False):
            dirs.sort(); files.sort()
            h.update(b"D\0" + os.path.relpath(current, root).encode() + b"\0")
            for name in dirs:
                full = os.path.join(current, name)
                if os.path.islink(full): add_file(full)
            for name in files: add_file(os.path.join(current, name))
    else:
        add_file(root)
    return h.hexdigest()

keys = ["configured_opencode", "normal_opencode_json", "normal_opencode_jsonc", "aact_state", "aact_config"]
values = {key: digest(path) for key, path in zip(keys, paths)}
print(json.dumps(values, sort_keys=True))
PY
  chmod 600 "$destination"
}

verify_originals() {
  local current="$BASE/evidence/originals-after.json"
  [ -r "$BASE/evidence/originals-before.json" ] || die 'original settings baseline snapshot is missing'
  snapshot_originals "$current"
  python3 - "$BASE/evidence/originals-before.json" "$current" <<'PY'
import json, sys
before, after = (json.load(open(path)) for path in sys.argv[1:])
if before != after:
    print("Original AACT/OpenCode state or config changed during the fixture run.", file=sys.stderr)
    raise SystemExit(1)
print("PASS: original AACT state/config and OpenCode config match their private baseline snapshots.")
PY
}

path_guard() {
  [ -n "$BASE" ] || die 'set COURIER_MRM_HOME to the private fixture path printed by fixture local'
  [ -d "$BASE" ] || die "fixture path does not exist: $BASE"
  local resolved marker
  resolved=$(cd "$BASE" && pwd -P)
  case "$resolved" in /tmp/courier-mrm-mac.*|/private/tmp/courier-mrm-mac.*) ;; *) die "refusing path outside /tmp/courier-mrm-mac.*: $resolved" ;; esac
  marker="$resolved/.courier-mrm-owner.json"
  [ -f "$marker" ] || die 'fixture ownership marker missing'
  jq -e --arg path "$resolved" '.version == 1 and ((.macRoot | sub("^/private/tmp/"; "/tmp/")) == ($path | sub("^/private/tmp/"; "/tmp/"))) and (.runId | length >= 16)' "$marker" >/dev/null || die 'fixture ownership marker does not match canonical path'
  BASE=$resolved
}

write_repo() {
  local path=$1 name=$2
  mkdir -p "$path"
  git -C "$path" init -q -b fixture-main
  git -C "$path" config user.name 'Polyrepo Fixture'
  git -C "$path" config user.email 'polyrepo-fixture@localhost'
  printf '# Fixture %s\n\nDisposable repository for an isolated Polyrepo Coordinator rehearsal.\n' "$name" >"$path/README.md"
  git -C "$path" add README.md
  git -C "$path" commit -q -m "Initialize disposable $name fixture"
  git -C "$path" remote add origin "https://fixture.invalid/team/$name.git"
  git -C "$path" branch fixture-existing
}

write_fixture_repos() {
  local root=$1
  mkdir -p "$root/repos"
  write_repo "$root/repos/alpha" alpha
  write_repo "$root/repos/beta" beta
  write_repo "$root/repos/gamma" gamma
  printf 'Preserve this untracked main-checkout file during the rehearsal.\n' >"$root/repos/gamma/KEEP-DIRTY-MAIN.txt"
  # A separate clone with the same remote tests repoId ambiguity without network access.
  git clone -q --no-hardlinks "$root/repos/alpha" "$root/repos/alpha-clone"
  git -C "$root/repos/alpha-clone" remote set-url origin https://fixture.invalid/team/alpha.git
  # A linked checkout must resolve to alpha's same git-common-dir/repoId.
  git -C "$root/repos/alpha" branch fixture-linked
  git -C "$root/repos/alpha" worktree add -q "$root/repos/alpha-linked" fixture-linked
  printf '%s\n' "$root/repos/alpha" "$root/repos/beta" "$root/repos/gamma" \
    "$root/repos/alpha-clone" "$root/repos/alpha-linked" >"$root/repository-roots.txt"
  chmod 600 "$root/repository-roots.txt"
}

preflight() {
  local command version
  for command in git jq curl openssl tar ssh scp rsync unzip python3; do need "$command"; done
  [ -x "$OC" ] || die "pinned OpenCode 2.0.32 runtime not found at $OC"
  [ -x "$NODE" ] || die "pinned Node runtime not found at $NODE"
  [ -x "$BUN" ] || die "pinned Bun runtime not found at $BUN"
  [ -r "$CONFIG_SOURCE" ] || die "private provider config is not readable at $CONFIG_SOURCE"
  jq -e '(.providers.kinfer // .provider.kinfer) != null' "$CONFIG_SOURCE" >/dev/null 2>&1 || die 'source config does not contain kinfer; config contents are never displayed'
  version=$("$OC" --version 2>/dev/null || true)
  case "$version" in *2.0.32*) ;; *) die "expected pinned OpenCode 2.0.32, got ${version:-no version}" ;; esac
  [ -n "$AACT_SOURCE" ] || printf 'AACT source: set COURIER_MRM_AACT_SOURCE to the dedicated implementation worktree before build/start.\n'
  printf 'Preflight passed: private OpenCode 2.0.32, Node/Bun, git, scanner-safe config, and required tools.\n'
  printf 'Remote fixture host is %s; no SSH mutation is performed by preflight.\n' "$REMOTE_HOST"
}

fixture_local() {
  local run_id config_dir state_dir agent_dir repo
  [ -z "$BASE" ] || die 'unset COURIER_MRM_HOME for the first fixture local command'
  need mktemp
  BASE=$(mktemp -d "/tmp/courier-mrm-mac.XXXXXXXX")
  BASE=$(cd "$BASE" && pwd -P)
  chmod 700 "$BASE"
  run_id=$(openssl rand -hex 16)
  mkdir -p "$BASE/mac/config" "$BASE/mac/data" "$BASE/mac/state" "$BASE/mac/cache" \
    "$BASE/opencode-local/.config/opencode" "$BASE/mac/secrets" "$BASE/mac/logs" "$BASE/mac/api" \
    "$BASE/mac/worktrees" "$BASE/source" "$BASE/evidence" "$BASE/bin"
  config_dir="$BASE/opencode-local/.config/opencode"
  state_dir="$BASE/mac/state"
  agent_dir="$BASE/mac/agent"
  seed_private_opencode_config "$CONFIG_SOURCE" "$config_dir/opencode.jsonc"
  verify_private_opencode_config "$config_dir/opencode.jsonc"
  openssl rand -hex 32 >"$BASE/mac/secrets/server-password"
  printf 'user = "opencode:%s"\n' "$(cat "$BASE/mac/secrets/server-password")" >"$BASE/mac/secrets/curl.conf"
  chmod 600 "$BASE/mac/secrets/server-password" "$BASE/mac/secrets/curl.conf"
  write_fixture_repos "$BASE/mac"
  printf '%s\n' "$run_id" >"$BASE/run-id"
  chmod 600 "$BASE/run-id"
  json --arg id "$run_id" --arg path "$BASE" --arg remote "$REMOTE_HOST" \
    '{version:1,runId:$id,macRoot:$path,remoteHost:$remote,remotePrefix:("/tmp/courier-mrm-" + $id + "-wsl"),createdAt:(now|todate)}' \
    >"$BASE/.courier-mrm-owner.json"
  chmod 600 "$BASE/.courier-mrm-owner.json"
  # Snapshot digests stay private and are compared later; no raw config or digest is printed.
  hash_file "$CONFIG_SOURCE" >"$BASE/source-config.sha256"
  chmod 600 "$BASE/source-config.sha256"
  snapshot_originals "$BASE/evidence/originals-before.json"
  printf 'Private Mac fixture created: %s\n' "$BASE"
  printf 'Before any WSL mutation, notify the coordinator of this exact planned WSL prefix: %s\n' \
    "$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")"
  printf 'Next: message the coordinator with the WSL prefix, then run fixture wsl with COURIER_MRM_HOME=%q.\n' "$BASE"
  printf 'No real checkout or existing demo path was opened for writes.\n'
}

copy_source() {
  local source=$1 destination=$2
  [ -d "$source" ] || die "source checkout is missing: $source"
  mkdir -p "$destination"
  # Copy the exact working tree (including implementation under review) without Git metadata,
  # dependencies, build output, or any edits back to the source checkout.
  tar -C "$source" --exclude=.git --exclude=node_modules --exclude=dist -cf - . | tar -C "$destination" -xf -
}

build_private() {
  path_guard
  [ -n "$AACT_SOURCE" ] || die 'set COURIER_MRM_AACT_SOURCE to the dedicated AACT implementation worktree'
  [ -x "$BUN" ] || die "pinned Bun not found: $BUN"
  rm -rf -- "$BASE/source/courier" "$BASE/source/courier-aact-source" "$BASE/source/aact" "$BASE/source/aact-fixture-pack"
  copy_source "$COURIER_SOURCE" "$BASE/source/courier"
  copy_source "$COURIER_SOURCE" "$BASE/source/courier-aact-source"
  copy_source "$AACT_SOURCE" "$BASE/source/aact"
  mkdir -p "$BASE/source/aact-fixture-pack"
  cp -R "$BASE/source/aact/packages/polyrepo-coordinator" "$BASE/source/aact-fixture-pack/polyrepo-coordinator"
  cat >"$BASE/source/aact-fixture-pack/aact.toml" <<'MANIFEST'
schema_version = 1
pack_id = "fixture"

[[catalog]]
id = "polyrepo-coordinator"
source = "./polyrepo-coordinator"
MANIFEST
  chmod 600 "$BASE/source/aact-fixture-pack/aact.toml"
  (cd "$BASE/source/courier" && "$BUN" install --frozen-lockfile && "$BUN" run build)
  (cd "$BASE/source/aact" && go build -o "$BASE/bin/aact" ./cmd/aact)
  chmod 700 "$BASE/bin/aact"
  printf 'Built private Courier and AACT artifacts under %s; source checkouts remain untouched.\n' "$BASE"
}

aact_local() (
  export XDG_CONFIG_HOME="$BASE/mac/config" XDG_DATA_HOME="$BASE/mac/data"
  export XDG_STATE_HOME="$BASE/mac/state" XDG_CACHE_HOME="$BASE/mac/cache"
  export AACT_BUNDLED_ROOT="$BASE/source/aact/packages"
  export PATH="$(dirname "$OC"):$(dirname "$BUN"):$(dirname "$NODE"):$PATH"
  "$BASE/bin/aact" --state-dir "$BASE/mac/state" --agent-home "opencode=$BASE/opencode-local" "$@"
)

aact_cross_local() (
  export XDG_CONFIG_HOME="$BASE/mac/config" XDG_DATA_HOME="$BASE/mac/data"
  export XDG_STATE_HOME="$BASE/mac/state-cross" XDG_CACHE_HOME="$BASE/mac/cache"
  export AACT_BUNDLED_ROOT="$BASE/source/aact/packages"
  export PATH="$(dirname "$OC"):$(dirname "$BUN"):$(dirname "$NODE"):$PATH"
  "$BASE/bin/aact" --state-dir "$BASE/mac/state-cross" --agent-home "opencode=$BASE/opencode-cross" "$@"
)

install_local_polyrepo() {
  aact_local --config "$BASE/source/aact-fixture-pack/aact.toml" \
    --agent-home "opencode=$BASE/opencode-local" --agent opencode \
    --set "courier_source=$BASE/source/courier-aact-source" install polyrepo-coordinator
}

uninstall_local_polyrepo() {
  aact_local --config "$BASE/source/aact-fixture-pack/aact.toml" \
    --agent-home "opencode=$BASE/opencode-local" --profile default --agent opencode \
    uninstall polyrepo-coordinator
}

prepare_local() {
  path_guard
  [ -x "$BASE/bin/aact" ] || die 'run build first'
  mkdir -p "$BASE/opencode-local/.config/opencode"
  seed_private_opencode_config "$CONFIG_SOURCE" "$BASE/opencode-local/.config/opencode/opencode.jsonc"
  verify_private_opencode_config "$BASE/opencode-local/.config/opencode/opencode.jsonc"
  aact_local polyrepo configure --root "$BASE/mac/repos" --worktree-root "$BASE/mac/worktrees" --host fixture.invalid
  aact_local polyrepo list >"$BASE/evidence/mac-inventory-initial.json"
  chmod 600 "$BASE/evidence/mac-inventory-initial.json"
  install_local_polyrepo
  verify_local_config
  verify_originals
  install_local_polyrepo
  verify_local_config
  uninstall_local_polyrepo
  verify_local_removed
  install_local_polyrepo
  verify_local_config
  jq '.plugins |= map(select(. != "fixture-unrelated-plugin"))' "$BASE/opencode-local/.config/opencode/opencode.jsonc" \
    >"$BASE/opencode-local/.config/opencode/opencode.jsonc.tmp"
  chmod 600 "$BASE/opencode-local/.config/opencode/opencode.jsonc.tmp"
  mv "$BASE/opencode-local/.config/opencode/opencode.jsonc.tmp" "$BASE/opencode-local/.config/opencode/opencode.jsonc"
  printf 'Removed only the non-loadable fixture plugin sentinel after proving AACT preserved it through install, update, and uninstall.\n'
  printf 'Local repo map and plugin installed, updated, removed, and reinstalled through AACT in private state/config only.\n'
}

write_local_env() {
  export XDG_CONFIG_HOME="$BASE/mac/config" XDG_DATA_HOME="$BASE/mac/data"
  if [ -r "$BASE/opencode-cross/.config/opencode/opencode.jsonc" ]; then
    export XDG_STATE_HOME="$BASE/mac/state-cross"
  else
    export XDG_STATE_HOME="$BASE/mac/state"
  fi
  export XDG_CACHE_HOME="$BASE/mac/cache"
  if [ -r "$BASE/opencode-cross/.config/opencode/opencode.jsonc" ]; then
    export OPENCODE_CONFIG="$BASE/opencode-cross/.config/opencode/opencode.jsonc"
  else
    export OPENCODE_CONFIG="$BASE/opencode-local/.config/opencode/opencode.jsonc"
  fi
  export OPENCODE_SERVER_PASSWORD
  OPENCODE_SERVER_PASSWORD=$(cat "$BASE/mac/secrets/server-password")
  export OPENCODE_PASSWORD=$OPENCODE_SERVER_PASSWORD
  local_ips=''
  [ -r "$BASE/mac/tailscale-ip" ] && local_ips=$(cat "$BASE/mac/tailscale-ip")
  [ -r "$BASE/wsl/tailscale-ip" ] && local_ips="${local_ips:+$local_ips,}$(cat "$BASE/wsl/tailscale-ip")"
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost${local_ips:+,$local_ips}"
  export no_proxy=$NO_PROXY
}

serve_mac() {
  path_guard
  [ -d "$BASE/mac/repos/alpha/.git" ] || die 'fixture repos are missing; run fixture local first'
  write_local_env
  printf '%s\n' "$$" >"$BASE/mac/server.pid"
  printf '%s\n' "$BASE/.courier-mrm-owner.json" >"$BASE/mac/server.owner"
  chmod 600 "$BASE/mac/server.pid" "$BASE/mac/server.owner"
  cd "$BASE/mac/repos/alpha"
  exec "$OC" serve --hostname 127.0.0.1 --port "$MAC_PORT" --print-logs >"$BASE/mac/server.log" 2>&1
}

serve_wsl() {
  path_guard
  local prefix run_id mac_ip wsl_ip
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  run_id=$(cat "$BASE/run-id")
  mac_ip=$(cat "$BASE/mac/tailscale-ip")
  wsl_ip=$(cat "$BASE/wsl/tailscale-ip")
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" "$WSL_PORT" "$mac_ip" "$wsl_ip" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3 port=$4 mac_ip=$5 wsl_ip=$6
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
[ -x "$oc" ] || { echo 'pinned WSL OpenCode runtime is missing' >&2; exit 2; }
  export XDG_CONFIG_HOME="$prefix/config" XDG_DATA_HOME="$prefix/data" XDG_STATE_HOME="$prefix/state-cross" XDG_CACHE_HOME="$prefix/cache"
  export OPENCODE_CONFIG="$prefix/opencode-wsl-cross/.config/opencode/opencode.jsonc"
export OPENCODE_SERVER_PASSWORD="$(cat "$prefix/secrets/server-password")" OPENCODE_PASSWORD="$(cat "$prefix/secrets/server-password")"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,$mac_ip,$wsl_ip"
export no_proxy=$NO_PROXY
printf '%s\n' "$$" >"$prefix/server.pid"
printf '%s\n' "$run_id" >"$prefix/server.owner"
chmod 600 "$prefix/server.pid" "$prefix/server.owner"
cd "$prefix/repos/alpha"
exec "$oc" serve --hostname 127.0.0.1 --port "$port" --print-logs >"$prefix/logs/server.log" 2>&1
REMOTE
}

run_warm_mac() {
  path_guard
  local prompt="$BASE/evidence/mac-warm-initial-prompt.txt" output="$BASE/evidence/mac-warm"
  cat >"$prompt" <<'PROMPT'
This is a read-only infrastructure warmup, not a project task. Register this current session as a named Courier root with courier_session({name:"fixture-mac-warmup"}), then call courier_repos({query:"team/alpha"}) and report the repository names and count. Do not spawn workers or change files. If both calls succeed, respond exactly READY.
PROMPT
  chmod 600 "$prompt"
  write_local_env
  if (cd "$BASE/mac/repos/alpha" && "$OC" run --server "http://127.0.0.1:$MAC_PORT" \
      --model kinfer/chatgpt/gpt-6-luna --auto --format json "$(cat "$prompt")") >"$output.jsonl" 2>"$output.stderr"; then
    chmod 600 "$output.jsonl" "$output.stderr"
    printf 'Mac infrastructure warm turn completed; inspect private tool records before proceeding.\n'
  else
    local code=$?
    chmod 600 "$output.jsonl" "$output.stderr" 2>/dev/null || true
    printf 'Mac warm turn failed with exit code %s; private output and stderr are retained separately.\n' "$code" >&2
    return "$code"
  fi
}

run_warm_wsl() {
  path_guard
  local prefix run_id mac_ip wsl_ip
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  run_id=$(cat "$BASE/run-id")
  mac_ip=$(cat "$BASE/mac/tailscale-ip")
  wsl_ip=$(cat "$BASE/wsl/tailscale-ip")
  cat >"$BASE/evidence/wsl-warm-initial-prompt.txt" <<'PROMPT'
This is a read-only infrastructure warmup, not a project task. Register this current session as a named Courier root with courier_session({name:"fixture-wsl-warmup"}), then call courier_repos({query:"team/alpha"}) and report the repository names and count. Do not spawn workers or change files. If both calls succeed, respond exactly READY.
PROMPT
  chmod 600 "$BASE/evidence/wsl-warm-initial-prompt.txt"
  scp "$BASE/evidence/wsl-warm-initial-prompt.txt" "$REMOTE_HOST:$prefix/logs/wsl-warm-initial-prompt.txt"
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" "$WSL_PORT" "$mac_ip" "$wsl_ip" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3 port=$4 mac_ip=$5 wsl_ip=$6
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
export PATH="$(dirname "$oc"):$prefix/bin:$PATH"
export XDG_CONFIG_HOME="$prefix/config" XDG_DATA_HOME="$prefix/data" XDG_STATE_HOME="$prefix/state-cross" XDG_CACHE_HOME="$prefix/cache"
export OPENCODE_CONFIG="$prefix/opencode-wsl-cross/.config/opencode/opencode.jsonc"
export OPENCODE_SERVER_PASSWORD="$(cat "$prefix/secrets/server-password")" OPENCODE_PASSWORD="$(cat "$prefix/secrets/server-password")"
proxy_bypass="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,$mac_ip,$wsl_ip"
export NO_PROXY="$proxy_bypass" no_proxy="$proxy_bypass"
if (cd "$prefix/repos/alpha" && "$oc" run --server "http://127.0.0.1:$port" --model kinfer/chatgpt/gpt-6-luna \
    --auto --format json "$(cat "$prefix/logs/wsl-warm-initial-prompt.txt")") \
    >"$prefix/logs/wsl-warm.jsonl" 2>"$prefix/logs/wsl-warm.stderr"; then
  chmod 600 "$prefix/logs/wsl-warm.jsonl" "$prefix/logs/wsl-warm.stderr"
else
  code=$?
  chmod 600 "$prefix/logs/wsl-warm.jsonl" "$prefix/logs/wsl-warm.stderr" 2>/dev/null || true
  exit "$code"
fi
REMOTE
  scp "$REMOTE_HOST:$prefix/logs/wsl-warm.jsonl" "$BASE/evidence/wsl-warm.jsonl"
  scp "$REMOTE_HOST:$prefix/logs/wsl-warm.stderr" "$BASE/evidence/wsl-warm.stderr"
  chmod 600 "$BASE/evidence/wsl-warm.jsonl" "$BASE/evidence/wsl-warm.stderr"
  printf 'WSL infrastructure warm turn completed; inspect private tool records before proceeding.\n'
}

warm_nodes() {
  path_guard
  local prefix run_id mac_ip wsl_ip mac_node
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  run_id=$(cat "$BASE/run-id")
  mac_ip=$(cat "$BASE/mac/tailscale-ip")
  wsl_ip=$(cat "$BASE/wsl/tailscale-ip")
  mac_node=$(jq -r .nodeId "$BASE/mac/state-cross/manager/repo-map-v1.json")
  rg -q "courier webhook: listening on http://$mac_ip:$MAC_HOOK_PORT" "$BASE/mac/server.log" || die 'run the Mac warm turn first; receiver is not listening'
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$wsl_ip" "$WSL_HOOK_PORT" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 ip=$3 port=$4
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
grep -Fq "courier webhook: listening on http://$ip:$port" "$prefix/logs/server.log" || { echo 'run the WSL warm turn first; receiver is not listening' >&2; exit 2; }
REMOTE
  NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,$mac_ip,$wsl_ip" no_proxy="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,$mac_ip,$wsl_ip" \
    python3 - "$BASE/mac/secrets/peer.key" "$wsl_ip" "$WSL_HOOK_PORT" "$mac_node" "$BASE/evidence/peer-query-check.json" <<'PY'
import hashlib, hmac, json, sys, urllib.error, urllib.request, uuid
from pathlib import Path
secret_path, host, port, sender, result_path = sys.argv[1:]
secret = Path(secret_path).read_text().strip().encode()
envelope = {"version": 1, "id": str(uuid.uuid4()), "sender": sender,
            "operation": "repositories", "payload": {"query": "team/beta"}}
body = json.dumps(envelope, separators=(",", ":")).encode()
signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
request = urllib.request.Request(f"http://{host}:{port}/courier", data=body, method="POST",
    headers={"content-type": "application/json", "x-courier-signature": signature})
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        code, payload = response.status, json.loads(response.read())
except urllib.error.HTTPError as error:
    raise SystemExit(f"signed peer query failed with HTTP {error.code}")
result = payload.get("result", {})
repos = result.get("repositories", [])
summary = {"status": code, "repositoryCount": len(repos),
           "returnedBeta": any(repo.get("name") == "team/beta" for repo in repos),
           "repoIds": [repo.get("repoId") for repo in repos]}
if code != 200 or not summary["returnedBeta"]:
    raise SystemExit("signed peer query did not return the expected WSL fixture repository")
Path(result_path).write_text(json.dumps(summary, sort_keys=True) + "\n")
Path(result_path).chmod(0o600)
print(json.dumps(summary, sort_keys=True))
PY
  printf 'Both Courier receivers bound and the signed direct Tailnet peer query returned the expected WSL repository.\n'
}

run_head() {
  path_guard
  local kind=$1 prompt=$2 code output
  [[ "$kind" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || die 'run evidence name must be a short lowercase identifier'
  [ -r "$prompt" ] || die "readable one-shot Head prompt file required: $prompt"
  [ -x "$OC" ] || die "pinned OpenCode runtime not found at $OC"
  mkdir -p "$BASE/evidence"
  if [ "$prompt" != "$BASE/evidence/$kind-initial-prompt.txt" ]; then
    cp "$prompt" "$BASE/evidence/$kind-initial-prompt.txt"
  fi
  chmod 600 "$BASE/evidence/$kind-initial-prompt.txt"
  output="$BASE/evidence/$kind-head"
  write_local_env
  if (cd "$BASE/mac/repos/alpha" && "$OC" run --server "http://127.0.0.1:$MAC_PORT" \
      --model kinfer/chatgpt/gpt-6-luna --auto --format json "$(cat "$BASE/evidence/$kind-initial-prompt.txt")") \
      >"$output.jsonl" 2>"$output.stderr"; then
    chmod 600 "$output.jsonl" "$output.stderr"
    verify_originals
    printf 'One initial Head prompt completed; raw result is private at %s.jsonl\n' "$output"
  else
    code=$?
    chmod 600 "$output.jsonl" "$output.stderr" 2>/dev/null || true
    printf 'Head command failed with exit code %s; private output and stderr are retained separately.\n' "$code" >&2
    return "$code"
  fi
}

run_local() { run_head local "$1"; }
run_cross_node() { run_head cross-node "$1"; }
run_local_named() { [ "$#" -eq 2 ] || die 'run-local-named requires an evidence name and prompt file'; run_head "$1" "$2"; }

verify_local_config() {
  path_guard
  local inventory config alpha clone linked plugin_path plugin_root
  inventory="$BASE/mac/state/manager/repo-map-v1.json"
  config="$BASE/opencode-local/.config/opencode/opencode.jsonc"
  [ -r "$inventory" ] && [ -r "$config" ] || die 'run prepare-local first'
  [ "$(jq '.repositories | length' "$inventory")" -eq 5 ] || die 'local inventory does not contain the five expected checkouts'
  alpha=$(jq -r '.repositories[] | select(.path | endswith("/repos/alpha")) | .repoId' "$inventory")
  linked=$(jq -r '.repositories[] | select(.path | endswith("/repos/alpha-linked")) | .repoId' "$inventory")
  clone=$(jq -r '.repositories[] | select(.path | endswith("/repos/alpha-clone")) | .repoId' "$inventory")
  [ -n "$alpha" ] && [ "$alpha" = "$linked" ] || die 'linked worktree repoId did not match alpha common directory'
  [ -n "$clone" ] && [ "$alpha" != "$clone" ] || die 'independent clone repoId was not distinct'
  jq -e '.repositories[] | select(.path | endswith("/repos/gamma")) | .worktrees[0].dirty == true' "$inventory" >/dev/null || die 'dirty main checkout is not reported'
  jq -s -e --arg map "$inventory" '.[0].provider.kinfer == .[1].provider.kinfer and .[0].model == .[1].model and .[1].mcp == {"fixture-inert-mcp":{"type":"local","command":["/usr/bin/false"],"enabled":false}} and ([.[1].plugins[]? | select(type == "object" and .options.repoMapFile? == $map)] | length == 1) and ([.[1].plugins[]? | select(if type == "object" then .options.repoMapFile? != $map else . != "fixture-unrelated-plugin" end)] | length == 0)' \
    "$CONFIG_SOURCE" "$config" >/dev/null || die 'private OpenCode config changed provider/MCP data or lacks exactly one local plugin entry'
  plugin_path=$(jq -r --arg map "$inventory" '.plugins[] | select(type == "object" and .options.repoMapFile? == $map) | .package' "$config")
  plugin_root=$(dirname "$plugin_path")
  [ -d "$plugin_path" ] && [ -r "$plugin_path/index.js" ] && [ -r "$plugin_root/package.json" ] && [ -d "$plugin_root/node_modules" ] || die 'registered plugin does not point to its complete private source-built package'
  for tool in courier_session courier_repos courier_spawn courier_close; do
    rg -l -q "$tool" "$plugin_path" || die "built plugin is missing tool export $tool"
  done
  jq -n --arg node "$(jq -r .nodeId "$inventory")" --argjson rows "$(jq '.repositories | length' "$inventory")" \
    --arg alpha "$alpha" --arg linked "$linked" --arg clone "$clone" '{nodeId:$node,repositoryRows:$rows,linkedRepoIdsEqual:($alpha==$linked),separateCloneIdsDistinct:($alpha!=$clone),dirtyMainReported:true,providerAndMcpPreserved:true,unrelatedPluginSentinelPreserved:true,oneOwnedPlugin:true}' \
    >"$BASE/evidence/local-config-check.json"
  chmod 600 "$BASE/evidence/local-config-check.json"
  printf 'PASS: five repo rows; linked worktree identity matches; separate clone identity differs; dirty main is reported.\n'
  printf 'PASS: providers, MCP, and unrelated plugin entry are preserved; one local plugin is registered.\n'
}

verify_local_removed() {
  path_guard
  local config
  config="$BASE/opencode-local/.config/opencode/opencode.jsonc"
  jq -s -e --arg map "$BASE/mac/state/manager/repo-map-v1.json" '.[0].provider.kinfer == .[1].provider.kinfer and .[0].model == .[1].model and .[1].mcp == {"fixture-inert-mcp":{"type":"local","command":["/usr/bin/false"],"enabled":false}} and ([.[1].plugins[]? | select(type == "object" and .options.repoMapFile? == $map)] | length == 0) and ([.[1].plugins[]? | select(. == "fixture-unrelated-plugin")] | length == 1)' \
    "$CONFIG_SOURCE" "$config" >/dev/null || die 'uninstall removed unrelated config or left an owned Polyrepo plugin entry'
  printf 'PASS: uninstall removed only the owned plugin entry and preserved provider/MCP configuration.\n'
}

fixture_wsl() {
  path_guard
  local run_id prefix
  run_id=$(cat "$BASE/run-id")
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  mkdir -p "$BASE/wsl"
  # `mkdir` targets an announced, random run-specific prefix. No generic WSL path or live demo is used.
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3
case "$prefix" in /tmp/courier-mrm-*-wsl) ;; *) echo 'refusing unexpected WSL fixture prefix' >&2; exit 2 ;; esac
[ ! -e "$prefix" ] || { echo 'WSL fixture path already exists' >&2; exit 2; }
umask 077
  mkdir -m 700 "$prefix"
mkdir -m 700 "$prefix/repos" "$prefix/config" "$prefix/data" "$prefix/state" "$prefix/cache" \
  "$prefix/secrets" "$prefix/logs" "$prefix/api" "$prefix/worktrees" "$prefix/bin" "$prefix/opencode-wsl" "$prefix/private-config"
printf '%s\n' "$run_id" >"$prefix/run-id"
chmod 600 "$prefix/run-id"
printf '%s\n' "$prefix"
REMOTE
  printf 'WSL fixture root recorded under the announced private prefix: %s\n' "$prefix"
  printf 'Run prepare-wsl after build to create only the isolated provider copy, fake repos, and Linux AACT setup.\n'
}

prepare_wsl() {
  path_guard
  local run_id prefix mac_ip wsl_ip wsl_node mac_node bun_zip bun_path
  run_id=$(cat "$BASE/run-id")
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  mkdir -p "$BASE/wsl"
  [ "$(ssh "$REMOTE_HOST" "$WSL_OC" --version 2>/dev/null)" = 'opencode v2.0.32' ] || die "pinned WSL OpenCode runtime is not v2.0.32 at $WSL_OC"
  command -v go >/dev/null 2>&1 || die 'Go is required for a private Linux AACT binary build'
  [ -x "$TAILSCALE" ] || die "Tailscale CLI is required to discover this Mac peer IP: $TAILSCALE"
  mac_ip=$("$TAILSCALE" ip -4 | head -n 1)
  wsl_ip=$(ssh "$REMOTE_HOST" tailscale ip -4 | head -n 1)
  [[ "$mac_ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] || die 'Mac Tailscale IP is not in the CGNAT tailnet range'
  [[ "$wsl_ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]] || die 'WSL Tailscale IP is not in the CGNAT tailnet range'
  printf '%s\n' "$mac_ip" >"$BASE/mac/tailscale-ip"
  printf '%s\n' "$wsl_ip" >"$BASE/wsl/tailscale-ip"
  chmod 600 "$BASE/mac/tailscale-ip" "$BASE/wsl/tailscale-ip"
  jq --arg mac "$mac_ip" --arg wsl "$wsl_ip" '.macTailIP=$mac | .wslTailIP=$wsl' \
    "$BASE/.courier-mrm-owner.json" >"$BASE/.courier-mrm-owner.json.tmp"
  chmod 600 "$BASE/.courier-mrm-owner.json.tmp"
  mv "$BASE/.courier-mrm-owner.json.tmp" "$BASE/.courier-mrm-owner.json"

  openssl rand -hex 32 >"$BASE/mac/secrets/peer.key"
  chmod 600 "$BASE/mac/secrets/peer.key"
  bun_zip="$BASE/bin/bun-linux-x64.zip"
  bun_path="$BASE/bin/bun-linux-x64"
  curl --fail --location --silent --show-error --retry 2 \
    "https://github.com/oven-sh/bun/releases/download/bun-v$WSL_BUN_VERSION/bun-linux-x64.zip" -o "$bun_zip"
  unzip -p "$bun_zip" bun-linux-x64/bun >"$bun_path"
  chmod 700 "$bun_path"

  (cd "$BASE/source/aact" && GOCACHE="$BASE/mac/cache/go" GOMODCACHE="$BASE/mac/cache/go-mod" \
    GOOS=linux GOARCH=amd64 go build -o "$BASE/bin/aact-linux-amd64" ./cmd/aact)
  chmod 700 "$BASE/bin/aact-linux-amd64"
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3
case "$prefix" in /tmp/courier-mrm-*-wsl) ;; *) echo 'refusing unexpected WSL fixture prefix' >&2; exit 2 ;; esac
[ -d "$prefix" ] && [ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
mkdir -m 700 -p "$prefix/source" "$prefix/opencode-wsl/.config/opencode" "$prefix/secrets" "$prefix/private-config"
make_repo() {
  path=$1 name=$2
  mkdir -p "$path"
  git -C "$path" init -q -b fixture-main
  git -C "$path" config user.name 'Polyrepo Fixture'
  git -C "$path" config user.email 'polyrepo-fixture@localhost'
  printf '# Fixture %s\n\nDisposable WSL repository for an isolated Polyrepo Coordinator rehearsal.\n' "$name" >"$path/README.md"
  git -C "$path" add README.md
  git -C "$path" commit -q -m "Initialize disposable $name fixture"
  git -C "$path" remote add origin "https://fixture.invalid/team/$name.git"
}
if [ ! -d "$prefix/repos/alpha/.git" ]; then
  make_repo "$prefix/repos/alpha" alpha
  make_repo "$prefix/repos/beta" beta
  make_repo "$prefix/repos/gamma" gamma
  printf 'Preserve this untracked main-checkout file during the rehearsal.\n' >"$prefix/repos/gamma/KEEP-DIRTY-MAIN.txt"
fi
REMOTE
  scp "$bun_path" "$REMOTE_HOST:$prefix/bin/bun"
  scp "$BASE/bin/aact-linux-amd64" "$REMOTE_HOST:$prefix/bin/aact"
  seed_private_opencode_config "$CONFIG_SOURCE" "$BASE/wsl/opencode-seed.jsonc"
  scp "$BASE/wsl/opencode-seed.jsonc" "$REMOTE_HOST:$prefix/opencode-wsl/.config/opencode/opencode.jsonc"
  scp "$BASE/wsl/opencode-seed.jsonc" "$REMOTE_HOST:$prefix/private-config/opencode-seed.jsonc"
  scp "$BASE/mac/secrets/peer.key" "$REMOTE_HOST:$prefix/secrets/peer.key"
  rsync -az --delete -e ssh "$BASE/source/courier-aact-source/" "$REMOTE_HOST:$prefix/source/courier-aact-source/"
  scp -r "$BASE/source/aact-fixture-pack" "$REMOTE_HOST:$prefix/source/"
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
chmod 700 "$prefix/bin/aact" "$prefix/bin/bun"
chmod 600 "$prefix/opencode-wsl/.config/opencode/opencode.jsonc" "$prefix/secrets/peer.key"
[ "$("$prefix/bin/bun" --version)" = '1.3.14' ] || { echo 'downloaded WSL Bun version did not match the pinned version' >&2; exit 2; }
openssl rand -hex 32 >"$prefix/secrets/server-password"
printf 'user = "opencode:%s"\n' "$(cat "$prefix/secrets/server-password")" >"$prefix/secrets/curl.conf"
chmod 600 "$prefix/secrets/server-password" "$prefix/secrets/curl.conf"
REMOTE
  ssh "$REMOTE_HOST" bash -s -- "$prefix" <<'REMOTE'
set -euo pipefail
prefix=$1
export PATH="$prefix/bin:$PATH"
export XDG_CONFIG_HOME="$prefix/config" XDG_DATA_HOME="$prefix/data" XDG_STATE_HOME="$prefix/state" XDG_CACHE_HOME="$prefix/cache"
"$prefix/bin/aact" --state-dir "$prefix/state" --agent-home "opencode=$prefix/opencode-wsl" polyrepo configure --root "$prefix/repos" --worktree-root "$prefix/worktrees" --host fixture.invalid
"$prefix/bin/aact" --state-dir "$prefix/state" --agent-home "opencode=$prefix/opencode-wsl" polyrepo list >"$prefix/logs/inventory-initial.json"
chmod 600 "$prefix/logs/inventory-initial.json"
REMOTE
  scp "$REMOTE_HOST:$prefix/logs/inventory-initial.json" "$BASE/evidence/wsl-inventory-initial.json"
  chmod 600 "$BASE/evidence/wsl-inventory-initial.json"
  printf 'Private WSL fixture, Linux AACT binary, Bun %s, provider config, repos, and initial inventory prepared.\n' "$WSL_BUN_VERSION"
}

prepare_cross_node() {
  path_guard
  local prefix run_id mac_ip wsl_ip mac_node wsl_node local_map
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  run_id=$(cat "$BASE/run-id")
  mac_ip=$(cat "$BASE/mac/tailscale-ip")
  wsl_ip=$(cat "$BASE/wsl/tailscale-ip")
  [ -r "$BASE/evidence/wsl-inventory-initial.json" ] || die 'run prepare-wsl first'
  [ ! -e "$BASE/mac/state-cross/manager/settings.json" ] || die 'cross-node AACT state already exists; preserve this attempt and use a fresh fixture run ID'
  mkdir -p "$BASE/mac/state-cross" "$BASE/opencode-cross/.config/opencode"
  seed_private_opencode_config "$CONFIG_SOURCE" "$BASE/opencode-cross/.config/opencode/opencode.jsonc"
  aact_cross_local polyrepo configure --root "$BASE/mac/repos" --worktree-root "$BASE/mac/worktrees" --host fixture.invalid
  aact_cross_local polyrepo list >"$BASE/evidence/mac-inventory-cross-initial.json"
  chmod 600 "$BASE/evidence/mac-inventory-cross-initial.json"
  mac_node=$(jq -r .nodeId "$BASE/evidence/mac-inventory-cross-initial.json")

  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
[ ! -e "$prefix/state-cross/manager/settings.json" ] || { echo 'cross-node WSL AACT state already exists; preserving it' >&2; exit 2; }
mkdir -m 700 -p "$prefix/state-cross" "$prefix/opencode-wsl-cross/.config/opencode"
install -m 600 "$prefix/private-config/opencode-seed.jsonc" "$prefix/opencode-wsl-cross/.config/opencode/opencode.jsonc"
export PATH="$(dirname "$oc"):$prefix/bin:$PATH"
export XDG_CONFIG_HOME="$prefix/config" XDG_DATA_HOME="$prefix/data" XDG_STATE_HOME="$prefix/state-cross" XDG_CACHE_HOME="$prefix/cache"
"$prefix/bin/aact" --state-dir "$prefix/state-cross" --agent-home "opencode=$prefix/opencode-wsl-cross" \
  polyrepo configure --root "$prefix/repos" --worktree-root "$prefix/worktrees" --host fixture.invalid
"$prefix/bin/aact" --state-dir "$prefix/state-cross" --agent-home "opencode=$prefix/opencode-wsl-cross" \
  polyrepo list >"$prefix/logs/inventory-cross-initial.json"
"$prefix/bin/aact" --config "$prefix/source/aact-fixture-pack/aact.toml" --state-dir "$prefix/state-cross" \
  --agent-home "opencode=$prefix/opencode-wsl-cross" --agent opencode \
  --set "courier_source=$prefix/source/courier-aact-source" install polyrepo-coordinator
chmod 600 "$prefix/logs/inventory-cross-initial.json"
REMOTE
  scp "$REMOTE_HOST:$prefix/logs/inventory-cross-initial.json" "$BASE/evidence/wsl-inventory-cross-initial.json"
  chmod 600 "$BASE/evidence/wsl-inventory-cross-initial.json"
  wsl_node=$(jq -r .nodeId "$BASE/evidence/wsl-inventory-cross-initial.json")

  aact_cross_local --webhook-host "$mac_ip" --webhook-port "$MAC_HOOK_PORT" \
    --webhook-secret-file "$BASE/mac/secrets/peer.key" polyrepo configure
  aact_cross_local --peer-id "$wsl_node" --peer-url "http://$wsl_ip:$WSL_HOOK_PORT" \
    --secret-file "$BASE/mac/secrets/peer.key" --allowed-root "$BASE/mac/repos" \
    --allowed-root "$BASE/mac/worktrees" polyrepo peer add
  aact_cross_local polyrepo list >"$BASE/evidence/mac-inventory-cross.json"
  chmod 600 "$BASE/evidence/mac-inventory-cross.json"

  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$mac_node" "$mac_ip" "$MAC_HOOK_PORT" "$wsl_ip" "$WSL_HOOK_PORT" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 peer_id=$3 peer_ip=$4 peer_port=$5 local_ip=$6 local_port=$7
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
export PATH="$prefix/bin:$PATH"
export XDG_CONFIG_HOME="$prefix/config" XDG_DATA_HOME="$prefix/data" XDG_STATE_HOME="$prefix/state-cross" XDG_CACHE_HOME="$prefix/cache"
"$prefix/bin/aact" --state-dir "$prefix/state-cross" --agent-home "opencode=$prefix/opencode-wsl-cross" \
  --webhook-host "$local_ip" --webhook-port "$local_port" \
  --webhook-secret-file "$prefix/secrets/peer.key" polyrepo configure
"$prefix/bin/aact" --state-dir "$prefix/state-cross" --agent-home "opencode=$prefix/opencode-wsl-cross" \
  --peer-id "$peer_id" --peer-url "http://$peer_ip:$peer_port" --secret-file "$prefix/secrets/peer.key" \
  --allowed-root "$prefix/repos" --allowed-root "$prefix/worktrees" polyrepo peer add
"$prefix/bin/aact" --state-dir "$prefix/state-cross" --agent-home "opencode=$prefix/opencode-wsl-cross" \
  polyrepo list >"$prefix/logs/inventory-cross.json"
chmod 600 "$prefix/logs/inventory-cross.json"
REMOTE
  scp "$REMOTE_HOST:$prefix/logs/inventory-cross.json" "$BASE/evidence/wsl-inventory-cross.json"
  chmod 600 "$BASE/evidence/wsl-inventory-cross.json"

  install_cross_local() {
    aact_cross_local --config "$BASE/source/aact-fixture-pack/aact.toml" --agent opencode \
      --set "courier_source=$BASE/source/courier-aact-source" install polyrepo-coordinator
  }
  install_cross_local
  aact_cross_local --webhook-host "$mac_ip" --webhook-port "$MAC_HOOK_PORT" \
    --webhook-secret-file "$BASE/mac/secrets/peer.key" polyrepo configure
  install_cross_local
  install_cross_local
  local_map="$BASE/mac/state-cross/manager/repo-map-v1.json"
  jq -e --arg map "$local_map" --arg host "$mac_ip" --argjson port "$MAC_HOOK_PORT" --arg secret "$BASE/mac/secrets/peer.key" \
    '[.plugins[]? | select(type=="object" and .options.repoMapFile?==$map and .options.webhook.host==$host and .options.webhook.port==$port and .options.webhook.secretFile==$secret)] | length == 1' \
    "$BASE/opencode-cross/.config/opencode/opencode.jsonc" >/dev/null || die 'Mac cross config is missing its single AACT-owned listener entry'
  jq -s -e '.[0].provider.kinfer == .[1].provider.kinfer and .[0].model == .[1].model and .[1].mcp == {"fixture-inert-mcp":{"type":"local","command":["/usr/bin/false"],"enabled":false}} and ([.[1].plugins[]? | select(.=="fixture-unrelated-plugin")] | length==1)' \
    "$CONFIG_SOURCE" "$BASE/opencode-cross/.config/opencode/opencode.jsonc" >/dev/null || die 'Mac cross install changed provider/MCP or lost unrelated plugin preservation'
  jq '.plugins |= map(select(. != "fixture-unrelated-plugin"))' "$BASE/opencode-cross/.config/opencode/opencode.jsonc" >"$BASE/opencode-cross/config.tmp"
  chmod 600 "$BASE/opencode-cross/config.tmp" && mv "$BASE/opencode-cross/config.tmp" "$BASE/opencode-cross/.config/opencode/opencode.jsonc"

  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" "$wsl_ip" "$WSL_HOOK_PORT" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3 local_ip=$4 local_port=$5
[ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
export PATH="$(dirname "$oc"):$prefix/bin:$PATH"
export XDG_CONFIG_HOME="$prefix/config" XDG_DATA_HOME="$prefix/data" XDG_STATE_HOME="$prefix/state-cross" XDG_CACHE_HOME="$prefix/cache"
config="$prefix/opencode-wsl-cross/.config/opencode/opencode.jsonc"
seed="$prefix/private-config/opencode-seed.jsonc"
map="$prefix/state-cross/manager/repo-map-v1.json"
install_plugin() {
  "$prefix/bin/aact" --config "$prefix/source/aact-fixture-pack/aact.toml" --state-dir "$prefix/state-cross" \
    --agent-home "opencode=$prefix/opencode-wsl-cross" --agent opencode \
    --set "courier_source=$prefix/source/courier-aact-source" install polyrepo-coordinator
}
check_config() {
  jq -s -e --arg map "$map" --arg prefix "$prefix/state-cross/" --arg host "$local_ip" --argjson port "$local_port" --arg secret "$prefix/secrets/peer.key" '
    .[0] as $before | .[1] as $after |
    $after.provider == $before.provider and $after.model == $before.model and $after.mcp == $before.mcp and
    ([ $after.plugins[]? | select(type=="object" and .options.repoMapFile?==$map and .options.webhook.host==$host and .options.webhook.port==$port and .options.webhook.secretFile==$secret)] | length)==1 and
    ([ $after.plugins[]? | select(.=="fixture-unrelated-plugin")] | length)==1
  ' "$seed" "$config" >/dev/null
}
install_plugin
"$prefix/bin/aact" --state-dir "$prefix/state-cross" --agent-home "opencode=$prefix/opencode-wsl-cross" \
  --webhook-host "$local_ip" --webhook-port "$local_port" --webhook-secret-file "$prefix/secrets/peer.key" polyrepo configure
install_plugin
install_plugin
check_config
jq '.plugins |= map(select(. != "fixture-unrelated-plugin"))' "$config" >"$config.tmp"
chmod 600 "$config.tmp" && mv "$config.tmp" "$config"
chmod 600 "$config"
REMOTE
  printf 'Fresh private cross state: AACT install, listener configure, and two normal updates left one owned entry on each node; sentinels were removed before service start.\n'
}

status() {
  path_guard
  printf 'Run %s\nMac fixture: %s\nWSL host: %s\nWSL prefix: %s\n' \
    "$(cat "$BASE/run-id")" "$BASE" "$REMOTE_HOST" \
    "$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")"
  for role in mac wsl; do
    local pidfile pid
    pidfile="$BASE/$role/server.pid"
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then printf '%s OpenCode PID: %s (ownership verification required before stop)\n' "$role" "$pid"
      else printf '%s OpenCode PID file is stale: %s\n' "$role" "$pid"; fi
    else printf '%s OpenCode service: not started\n' "$role"; fi
  done
  local prefix run_id
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  run_id=$(cat "$BASE/run-id")
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2
if [ ! -d "$prefix" ] || [ "$(cat "$prefix/run-id" 2>/dev/null || true)" != "$run_id" ]; then
  echo 'wsl fixture: absent or ownership marker mismatch'
elif [ -f "$prefix/server.pid" ] && kill -0 "$(cat "$prefix/server.pid")" 2>/dev/null; then
  echo "wsl OpenCode PID: $(cat "$prefix/server.pid") (ownership verification required before stop)"
else
  echo 'wsl OpenCode service: not started'
fi
REMOTE
  printf 'Private evidence directory: %s/evidence\n' "$BASE"
}

stop_owned() {
  path_guard
  local pidfile pid port command cwd owner prefix run_id
  pidfile="$BASE/mac/server.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    owner=$(cat "$BASE/mac/server.owner" 2>/dev/null || true)
    [ "$owner" = "$BASE/.courier-mrm-owner.json" ] || die 'Mac server ownership marker mismatch'
    port=$MAC_PORT
    if kill -0 "$pid" 2>/dev/null; then
      command=$(ps -p "$pid" -o command= 2>/dev/null || true)
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)
      expected_entrypoint="$RUNTIME/node_modules/.pnpm/@opencode+cli@2.0.32/node_modules/@opencode/cli/bin/opencode.exe"
      expected_image=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$expected_entrypoint")
      actual_image=$(mac_process_image "$pid") || die "refusing to stop PID $pid: executable image could not be verified"
      [ "$actual_image" = "$expected_image" ] || die "refusing to stop PID $pid: executable image is not the pinned OpenCode 2.0.32 binary"
      case "$command" in *"/@opencode+cli@2.0.32/node_modules/@opencode/cli/bin/opencode.exe serve --hostname 127.0.0.1 --port $port "*) ;; *) die "refusing to stop PID $pid: command/port does not match fixture" ;; esac
      case "$cwd" in "$BASE/mac/repos/alpha") ;; *) die "refusing to stop PID $pid: working directory is outside fixture" ;; esac
      lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || die "refusing to stop PID $pid: fixture port is not listening"
      kill "$pid"
      for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -0 "$pid" 2>/dev/null && die "Mac service PID $pid did not stop"
    fi
    rm -f "$pidfile" "$BASE/mac/server.owner"
    printf 'Stopped only the recorded, verified Mac fixture service.\n'
  fi
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  run_id=$(cat "$BASE/run-id")
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_OC" "$WSL_PORT" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 oc=$3 port=$4
if [ ! -d "$prefix" ]; then exit 0; fi
[ "$(cat "$prefix/run-id" 2>/dev/null || true)" = "$run_id" ] || { echo 'WSL fixture ownership mismatch' >&2; exit 2; }
pidfile="$prefix/server.pid"
[ -f "$pidfile" ] || exit 0
pid=$(cat "$pidfile")
[ "$(cat "$prefix/server.owner" 2>/dev/null || true)" = "$run_id" ] || { echo 'WSL server owner mismatch' >&2; exit 2; }
if kill -0 "$pid" 2>/dev/null; then
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
  exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)
  command=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)
  [ "$cwd" = "$prefix/repos/alpha" ] && [ "$exe" = "$(readlink -f "$oc")" ] && [[ "$command" == *"serve"*"--port $port"* ]] || { echo "refusing to stop unverified WSL PID $pid" >&2; exit 2; }
  ss -ltnp "sport = :$port" 2>/dev/null | grep -F "pid=$pid," >/dev/null || { echo "refusing to stop WSL PID $pid: expected port is not owned" >&2; exit 2; }
  kill "$pid"
  for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && { echo "WSL PID $pid did not stop" >&2; exit 2; }
fi
rm -f "$pidfile" "$prefix/server.owner"
echo 'Stopped only the recorded, verified WSL fixture service.'
REMOTE
}

cleanup_owned() {
  path_guard
  local run_id prefix
  run_id=$(cat "$BASE/run-id")
  prefix=$(jq -r .remotePrefix "$BASE/.courier-mrm-owner.json")
  [ ! -e "$BASE/mac/server.pid" ] && [ ! -e "$BASE/wsl/server.pid" ] || die 'stop-owned must succeed before cleanup-owned'
  [ "${COURIER_MRM_CONFIRM_CLEANUP:-}" = "$run_id" ] || die "set COURIER_MRM_CONFIRM_CLEANUP=$run_id to delete only this run's private directories"
  local listener
  for port in "$MAC_PORT" "$MAC_HOOK_PORT"; do
    listener=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    [ -z "$listener" ] || die "refusing cleanup: TCP listener still exists on Mac fixture port $port (PID $listener); identify it manually, do not stop an unknown process"
  done
  ssh "$REMOTE_HOST" bash -s -- "$prefix" "$run_id" "$WSL_PORT" "$WSL_HOOK_PORT" <<'REMOTE'
set -euo pipefail
prefix=$1 run_id=$2 service_port=$3 hook_port=$4
[ -d "$prefix" ] && [ "$(cat "$prefix/run-id")" = "$run_id" ] || { echo 'WSL ownership marker mismatch' >&2; exit 2; }
case "$(realpath "$prefix")" in /tmp/courier-mrm-*-wsl) ;; *) echo 'refusing noncanonical WSL fixture path' >&2; exit 2 ;; esac
[ ! -e "$prefix/server.pid" ] || { echo 'WSL server pid marker remains; run stop-owned first' >&2; exit 2; }
for port in "$service_port" "$hook_port"; do
  listener=$(ss -H -ltn "sport = :$port" 2>/dev/null || true)
  [ -z "$listener" ] || { printf '%s\n' "$listener" >&2; echo "refusing cleanup: TCP listener still exists on WSL fixture port $port; identify it manually, do not stop an unknown process" >&2; exit 2; }
done
rm -rf -- "$prefix"
REMOTE
  case "$BASE" in /tmp/courier-mrm-mac.*|/private/tmp/courier-mrm-mac.*) ;; *) die 'refusing nonfixture cleanup path' ;; esac
  rm -rf -- "$BASE"
  printf 'Removed only the matching run-ID fixture directories.\n'
}

usage() {
  cat <<'USAGE'
Usage:
  e2e/multi-node-repo-map-demo.sh preflight
  e2e/multi-node-repo-map-demo.sh fixture local
  COURIER_MRM_HOME=/tmp/courier-mrm-mac.<id> e2e/multi-node-repo-map-demo.sh fixture wsl
  COURIER_MRM_HOME=<path> COURIER_MRM_AACT_SOURCE=<path> e2e/multi-node-repo-map-demo.sh build
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh prepare-local
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh prepare-wsl
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh prepare-cross-node
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh serve-mac
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh serve-wsl
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh run-warm-mac
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh run-warm-wsl
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh warm-nodes
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh run-local <private-prompt-file>
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh run-local-named <name> <private-prompt-file>
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh run-cross-node <private-prompt-file>
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh verify-local-config
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh verify-originals
  COURIER_MRM_HOME=<path> e2e/multi-node-repo-map-demo.sh status|stop-owned
  COURIER_MRM_HOME=<path> COURIER_MRM_CONFIRM_CLEANUP=<run-id> e2e/multi-node-repo-map-demo.sh cleanup-owned

No command defaults HOME or CODEX_HOME, edits an existing checkout, or addresses the existing demo.
USAGE
}

case "${1:-}" in
  preflight) preflight ;;
  fixture)
    case "${2:-}" in local) fixture_local ;; wsl) fixture_wsl ;; *) usage; exit 2 ;; esac
    ;;
  status) status ;;
  stop-owned) stop_owned ;;
  build) build_private ;;
  prepare-local) prepare_local ;;
  prepare-wsl) prepare_wsl ;;
  prepare-cross-node) prepare_cross_node ;;
  serve-mac) serve_mac ;;
  serve-wsl) serve_wsl ;;
  run-warm-mac) run_warm_mac ;;
  run-warm-wsl) run_warm_wsl ;;
  warm-nodes) warm_nodes ;;
  run-local) [ "$#" -eq 2 ] || { usage; exit 2; }; run_local "$2" ;;
  run-local-named) [ "$#" -eq 3 ] || { usage; exit 2; }; run_local_named "$2" "$3" ;;
  run-cross-node) [ "$#" -eq 2 ] || { usage; exit 2; }; run_cross_node "$2" ;;
  verify-local-config) verify_local_config ;;
  verify-originals) path_guard; verify_originals ;;
  cleanup-owned) cleanup_owned ;;
  *) usage; exit 2 ;;
esac
