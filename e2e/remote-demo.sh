#!/usr/bin/env bash
# Isolated, real-model two-node rehearsal for Courier remote nodes.
# All configs, credentials, servers, logs and disposable Git repositories live outside this repo.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=${COURIER_DEMO_HOME:-"$(cd "$ROOT/.." && pwd)/.opencode-courier-demo"}
RUNTIME=${COURIER_DEMO_RUNTIME:-/Users/pharkink/sources/.opencode-courier-demo/runtime}
OC="$RUNTIME/node_modules/.bin/opencode"
NODE=${COURIER_DEMO_NODE:-/Users/pharkink/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}
BUN=${COURIER_DEMO_BUN:-$RUNTIME/node_modules/@oven/bun-darwin-aarch64/bin/bun}
HEAD_PORT=${COURIER_HEAD_PORT:-4720}
WORKER_PORT=${COURIER_WORKER_PORT:-4721}
HEAD_HOOK_PORT=${COURIER_HEAD_HOOK_PORT:-4722}
WORKER_HOOK_PORT=${COURIER_WORKER_HOOK_PORT:-4723}

die() { echo "remote demo: $*" >&2; exit 1; }
need_private_runtime() {
  [ -x "$OC" ] || die "private OpenCode runtime missing at $OC"
  [ -x "$NODE" ] || die "Node runtime missing"
  [ -x "$BUN" ] || die "private Bun runtime missing"
}
node_env() {
  local role=$1
  export XDG_CONFIG_HOME="$BASE/$role/config"
  export XDG_DATA_HOME="$BASE/$role/data"
  export XDG_STATE_HOME="$BASE/$role/state"
  export XDG_CACHE_HOME="$BASE/$role/cache"
  export OPENCODE_CONFIG_DIR="$BASE/$role/config/opencode"
  export OPENCODE_SERVER_PASSWORD
  OPENCODE_SERVER_PASSWORD=$(cat "$BASE/$role/secrets/server-password")
  export OPENCODE_PASSWORD=$OPENCODE_SERVER_PASSWORD
}
node_url() { [ "$1" = head ] && echo "http://127.0.0.1:$HEAD_PORT" || echo "http://127.0.0.1:$WORKER_PORT"; }
repo_root() { cat "$BASE/repositories.path"; }
repo_dir() { echo "$(repo_root)/$1"; }
node_pidfile() { echo "$BASE/$1/server.pid"; }
api_ok() {
  local role=$1 path=$2
  node_env "$role"
  curl --config "$BASE/$role/secrets/curl.conf" -fsS "$(node_url "$role")/api/$path" >/dev/null 2>&1
}
api_get() {
  local role=$1 path=$2 directory
  node_env "$role"
  directory=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$(repo_dir "$role")")
  curl --config "$BASE/$role/secrets/curl.conf" -fsS "$(node_url "$role")/api/$path?directory=$directory"
}
start_node() {
  local role=$1 port hook_port log pidfile
  node_env "$role"
  port=$HEAD_PORT; hook_port=$HEAD_HOOK_PORT
  [ "$role" = worker ] && { port=$WORKER_PORT; hook_port=$WORKER_HOOK_PORT; }
  pidfile=$(node_pidfile "$role")
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    if api_ok "$role" info; then return; fi
    die "$role PID file exists but its server is not healthy; run stop and inspect its private log"
  fi
  log="$BASE/$role/server.log"
  (cd "$(repo_dir "$role")" && exec nohup "$OC" serve --hostname 127.0.0.1 --port "$port" --print-logs) >>"$log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  for _ in $(seq 1 45); do
    if api_ok "$role" info; then echo "$role server ready at $(node_url "$role") (listener port $hook_port)"; return; fi
    sleep 1
  done
  die "$role server failed to start; private log: $log"
}
stop_node() {
  local role=$1 pidfile pid
  pidfile=$(node_pidfile "$role")
  [ -f "$pidfile" ] || return 0
  pid=$(cat "$pidfile")
  if kill -0 "$pid" 2>/dev/null; then
    case "$(ps -p "$pid" -o command= 2>/dev/null || true)" in
      *"$OC"*"serve"*) ;;
      *) rm -f "$pidfile"; return 0 ;;
    esac
    # PIDs are recorded by this runner only. Never use process-name-wide termination.
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && die "$role server PID $pid did not stop"
  fi
  rm -f "$pidfile"
}

setup() {
  need_private_runtime
  local source_config="$HOME/.config/opencode/opencode.json"
  [ -r "$source_config" ] || die "OpenCode config not readable at expected path"
  [ ! -e "$BASE/repositories.path" ] || die "demo repositories already exist; run stop, then reset, then setup"
  mkdir -p "$BASE/secrets" "$BASE/head/secrets" "$BASE/worker/secrets"
  chmod 700 "$BASE" "$BASE/head" "$BASE/worker" "$BASE/secrets"
  # Generate secrets outside the checkout. Never print secret contents or config values.
  openssl rand -hex 32 >"$BASE/secrets/peer.key"
  openssl rand -hex 32 >"$BASE/head/secrets/server-password"
  openssl rand -hex 32 >"$BASE/worker/secrets/server-password"
  openssl rand -hex 32 >"$BASE/head/secrets/webhook.key"
  openssl rand -hex 32 >"$BASE/worker/secrets/webhook.key"
  chmod 600 "$BASE/secrets/peer.key" "$BASE/head/secrets/server-password" "$BASE/worker/secrets/server-password" "$BASE/head/secrets/webhook.key" "$BASE/worker/secrets/webhook.key"
  for role in head worker; do
    printf 'user = "opencode:%s"\n' "$(cat "$BASE/$role/secrets/server-password")" >"$BASE/$role/secrets/curl.conf"
    chmod 600 "$BASE/$role/secrets/curl.conf"
  done

  local repo_root
  repo_root=$(mktemp -d "$BASE/repositories.XXXXXX")
  printf '%s\n' "$repo_root" >"$BASE/repositories.path"
  chmod 600 "$BASE/repositories.path"
  mkdir -p "$repo_root/head" "$repo_root/worker"
  for role in head worker; do
    git -C "$repo_root/$role" init -q
    git -C "$repo_root/$role" config user.name 'Courier demo'
    git -C "$repo_root/$role" config user.email 'courier-demo@localhost'
    printf '%s\n' "Disposable $role repository for the Courier remote-node demo." >"$repo_root/$role/README.md"
    git -C "$repo_root/$role" add README.md
    git -C "$repo_root/$role" commit -q -m 'Initialize disposable demo repository'
    mkdir -p "$BASE/$role/config/opencode" "$BASE/$role/data" "$BASE/$role/state" "$BASE/$role/cache" "$BASE/$role/secrets"
  done

  # Preserve the real provider/model configuration while dropping unrelated integrations.
  # The provider config may contain credentials; jq writes directly to protected private files.
  for role in head worker; do
    if [ "$role" = head ]; then node_id=head; peer_id=worker; peer_port=$WORKER_HOOK_PORT; hook_port=$HEAD_HOOK_PORT
    else node_id=worker; peer_id=head; peer_port=$HEAD_HOOK_PORT; hook_port=$WORKER_HOOK_PORT; fi
    jq --arg plugin "$ROOT/dist" --arg node "$node_id" --arg peer "$peer_id" \
      --arg peerurl "http://127.0.0.1:$peer_port" --arg peersecret "$BASE/secrets/peer.key" \
      --arg webhooksecret "$BASE/$role/secrets/webhook.key" --argjson webhookport "$hook_port" \
      --arg root "$repo_root/$role" \
      'del(.mcp, .mcpServers) | .plugins = [{"package": $plugin, "options": {
         "remoteNodes": {"nodeId": $node, "peers": {($peer): {"url": $peerurl, "secretFile": $peersecret,
           "allowedRoots": [$root]}}},
         "webhook": {"host": "127.0.0.1", "port": $webhookport, "secretFile": $webhooksecret}
       }}]' \
      "$source_config" >"$BASE/$role/config/opencode/opencode.json"
  done
  chmod 600 "$BASE/head/config/opencode/opencode.json" "$BASE/worker/config/opencode/opencode.json"
  echo "Private demo configured. Provider/model settings were copied into protected isolated configs; credentials were not displayed."
}

demo_prompt() {
  local worker_dir
  worker_dir=$(repo_dir worker)
  cat <<EOF
Use courier_spawn exactly once with peer "worker", directory "$worker_dir", workName "remote-demo-marker", and isolate true. Do not do the file work yourself. Assign the worker this sequence: (1) use the parent session ID provided in your child brief to call courier_send with message exactly REMOTE_DEMO_PROGRESS_42 and no status so it is progress; (2) schedule a message to itself with courier_later for 0.5 minutes from now, saying "finish the marker and report done", then end its turn; (3) after that scheduled wake, create REMOTE-DEMO-MARKER.txt in the worker assigned directory with exactly COURIER_REMOTE_DEMO_OK_42; (4) report with status done, message exactly REMOTE_DEMO_DONE_42, and artifacts.files containing REMOTE-DEMO-MARKER.txt. After a progress report arrives, reply exactly HEAD_UNIT_PROGRESS_SEEN_42 and end your turn. After the done report arrives, reply exactly HEAD_UNIT_WOKE_ON_REMOTE_REPORT_42.
EOF
}

rehearse() {
  need_private_runtime
  api_ok head info || die "Head Unit service is not ready; run start first"
  api_ok worker info || die "Worker service is not ready; run start first"
  node_env head
  local worker_dir prompt parent child child_dir head_url messages progress done done_status reply marker artifact
  worker_dir=$(repo_dir worker)
  head_url=$(node_url head)
  prompt=$(demo_prompt)
  # Let OpenCode create the Head Unit session through the real API. Output can include provider
  # diagnostics, so retain it privately and never dump it into the terminal.
  local output_file="$BASE/rehearsal.jsonl"
  umask 077
  (cd "$(repo_dir head)" && "$OC" run --server "$head_url" --auto --format json "$prompt") >"$output_file" 2>&1 || die "real-model rehearsal failed; private output: $output_file"
  chmod 600 "$output_file"
  parent=$(jq -rs '[.[] | select(.type == "tool_use") | .sessionID] | first // empty' "$output_file")
  [ -n "$parent" ] || die "Head Unit session ID missing; private output: $output_file"
  child=$(jq -rs '[.[] | select(.type == "tool_use" and .part.tool == "courier_spawn" and .part.state.status == "completed") | .part.state.metadata.metadata.sessionID] | first // empty' "$output_file")
  child_dir=$(jq -rs '[.[] | select(.type == "tool_use" and .part.tool == "courier_spawn" and .part.state.status == "completed") | .part.state.metadata.metadata.directory] | first // empty' "$output_file")
  [[ "$child" == worker/* ]] || die "remote child was not created; private output: $output_file"
  [ -n "$child_dir" ] || child_dir=$worker_dir
  child=${child#worker/}
  echo "Head Unit session: $parent"
  echo "Remote worker session: worker/$child"
  echo "Attach the live Head Unit with: e2e/remote-demo.sh tui $parent"
  echo "Waiting for the worker marker and both parent wakeups..."
  progress=false; done=false; done_status=false; reply=false; marker=false; artifact=false
  for _ in $(seq 1 300); do
    messages=$(api_get head "session/$parent/message" 2>/dev/null || true)
    if [ -n "$messages" ]; then
      progress=$(jq -r '[.data[] | select(.type == "synthetic") | .text] | join("\n") | contains("REMOTE_DEMO_PROGRESS_42")' <<<"$messages")
      done=$(jq -r '[.data[] | select(.type == "synthetic") | .text] | join("\n") | contains("REMOTE_DEMO_DONE_42")' <<<"$messages")
      done_status=$(jq -r '[.data[] | select(.type == "synthetic") | .text] | join("\n") | contains("status=\"done\"")' <<<"$messages")
      artifact=$(jq -r '[.data[] | select(.type == "synthetic") | .text] | join("\n") | contains("files: REMOTE-DEMO-MARKER.txt")' <<<"$messages")
      reply=$(jq -r '[.data[] | select(.type == "assistant") | ([.content[]? | select(.type == "text") | .text] | join(""))] | join("\n") | contains("HEAD_UNIT_WOKE_ON_REMOTE_REPORT_42")' <<<"$messages")
    fi
    [ -f "$child_dir/REMOTE-DEMO-MARKER.txt" ] && [ "$(cat "$child_dir/REMOTE-DEMO-MARKER.txt")" = COURIER_REMOTE_DEMO_OK_42 ] && marker=true
    [ "$progress" = true ] && [ "$done" = true ] && [ "$done_status" = true ] && [ "$artifact" = true ] && [ "$reply" = true ] && [ "$marker" = true ] && break
    sleep 2
  done
  [ "$progress" = true ] || die "Head Unit did not receive the worker progress message"
  [ "$done" = true ] || die "Head Unit did not receive the worker completion report"
  [ "$done_status" = true ] || die "worker completion message did not carry status=done"
  [ "$artifact" = true ] || die "Head Unit report did not contain the marker artifact"
  [ "$marker" = true ] || die "worker marker was not created with the expected content"
  [ "$reply" = true ] || die "Head Unit did not answer after the completion report"
  echo "PASS: progress report reached the Head Unit"
  echo "PASS: completion report and marker artifact reached the Head Unit"
  echo "PASS: the idle Head Unit answered after the remote report"
  echo "Use the printed TUI attach command to inspect the same live session."
}

warm_worker() {
  node_env worker
  local output_file="$BASE/worker/warmup.jsonl"
  # OpenCode loads plugins when a session runs in a directory. Warm the Worker service
  # once so its peer listener is bound before the Head Unit attempts remote spawn.
  (cd "$(repo_dir worker)" && "$OC" run --server "$(node_url worker)" --format json 'Reply with exactly WORKER_READY.') >"$output_file" 2>&1 \
    || die "Worker listener warmup failed; private output: $output_file"
  chmod 600 "$output_file"
}

case "${1:-}" in
  setup) setup ;;
  build)
    need_private_runtime
    mkdir -p "$BASE"
    (cd "$ROOT" && PATH="$(dirname "$NODE"):$RUNTIME/node_modules/@oven/bun-darwin-aarch64/bin:$PATH" "$BUN" run build) >"$BASE/build.log" 2>&1 || die "Courier build failed; see private build log"
    echo "Courier build complete. Build log is private at $BASE/build.log"
    ;;
  start)
    need_private_runtime
    [ -d "$(repo_dir head)/.git" ] || die "run setup first"
    start_node head
    start_node worker
    warm_worker
    echo "Head repository: $(repo_dir head)"
    echo "Worker repository: $(repo_dir worker)"
    echo "Both nodes initialized with isolated private state."
    ;;
  serve)
    need_private_runtime
    [ -d "$(repo_dir head)/.git" ] || die "run setup first"
    start_node head
    start_node worker
    warm_worker
    echo "Both nodes initialized. Keep this terminal open; use another terminal for rehearse or tui."
    trap 'stop_node head; stop_node worker' INT TERM EXIT
    while :; do sleep 3600; done
    ;;
  rehearse) rehearse ;;
  prompt) demo_prompt ;;
  status)
    for role in head worker; do
      if api_ok "$role" info; then echo "$role: healthy $(node_url "$role")"; else echo "$role: stopped or unhealthy"; fi
    done
    ;;
  stop) stop_node head; stop_node worker; echo "Demo servers stopped." ;;
  reset)
    stop_node head; stop_node worker
    repos=$(repo_root 2>/dev/null || true)
    case "$repos" in "$BASE"/repositories.*) [ -d "$repos" ] && rm -rf "$repos" ;; esac
    rm -f "$BASE/repositories.path"
    rm -rf "$BASE/repos" "$BASE/head" "$BASE/worker" "$BASE/secrets"
    echo "Private demo state removed; pinned runtime preserved. Run setup to create a fresh rehearsal."
    ;;
  tui)
    need_private_runtime
    node_env head
    tui_args=(--server "$(node_url head)")
    [ -z "${2:-}" ] || tui_args+=(--session "$2")
    cd "$(repo_dir head)"
    exec "$OC" "${tui_args[@]}"
    ;;
  *) die "usage: $0 {build|setup|start|serve|status|prompt|rehearse|stop|tui [head-session-id]|reset}" ;;
esac
