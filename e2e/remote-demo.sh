#!/usr/bin/env bash
# Isolated, real-model two-node rehearsal for Courier remote nodes.
# All configs, credentials, servers, logs and disposable Git repositories live outside this repo.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=${COURIER_DEMO_HOME:-"$(cd "$ROOT/.." && pwd)/.opencode-courier-demo"}
RUNTIME=${COURIER_DEMO_RUNTIME:-/Users/pharkink/sources/.opencode-courier-demo/runtime-2.0.32}
OC="$RUNTIME/node_modules/.bin/opencode"
NODE=${COURIER_DEMO_NODE:-/Users/pharkink/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}
BUN=${COURIER_DEMO_BUN:-$RUNTIME/node_modules/@oven/bun-darwin-aarch64/bin/bun}
OC_EXE=$(sed -n 's/^# cmd-shim-target=//p' "$OC" 2>/dev/null | tail -n 1)
HEAD_PORT=${COURIER_HEAD_PORT:-4720}
WORKER_PORT=${COURIER_WORKER_PORT:-4721}
HEAD_HOOK_PORT=${COURIER_HEAD_HOOK_PORT:-4722}
WORKER_HOOK_PORT=${COURIER_WORKER_HOOK_PORT:-4723}
REMOTE_WORKER=${COURIER_REMOTE_WORKER:-dsowks132}
REMOTE_WORKTREE_ROOT=${COURIER_REMOTE_WORKTREE_ROOT:-/home/pharkink/.local/share/courier-cross-node-demo/data/opencode/worktree}
REMOTE_SOURCE_ROOT=${COURIER_REMOTE_SOURCE_ROOT:-/home/pharkink/.local/share/courier-cross-node-demo/workspace/worker-source}
REMOTE_ATTACH=${COURIER_REMOTE_ATTACH:-/home/pharkink/.local/share/courier-cross-node-demo/bin/attach-tui}

die() { echo "remote demo: $*" >&2; exit 1; }
need_private_runtime() {
  [ -x "$OC" ] || die "private OpenCode runtime missing at $OC"
  [ -x "$OC_EXE" ] || die "private OpenCode executable could not be resolved"
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
  # Peer HTTP must go directly over the tailnet, never through a corporate proxy.
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}127.0.0.1,localhost,100.84.15.57,100.102.197.40"
  export no_proxy=$NO_PROXY
}
node_url() { [ "$1" = head ] && echo "http://127.0.0.1:$HEAD_PORT" || echo "http://127.0.0.1:$WORKER_PORT"; }
repo_root() { cat "$BASE/repositories.path"; }
repo_dir() { echo "$(repo_root)/$1"; }
node_pidfile() { echo "$BASE/$1/server.pid"; }
server_command_matches() {
  local role=$1 pid=$2 port command
  port=$HEAD_PORT
  [ "$role" = worker ] && port=$WORKER_PORT
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in
    "$RUNTIME/"*"/opencode.exe serve --hostname 127.0.0.1 --port $port --print-logs") ;;
    *) return 1 ;;
  esac
  lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}
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
api_get_dir() {
  local role=$1 path=$2 workdir=$3 directory
  node_env "$role"
  directory=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$workdir")
  curl --config "$BASE/$role/secrets/curl.conf" -fsS "$(node_url "$role")/api/$path?directory=$directory"
}
start_node() {
  local role=$1 port hook_port log pidfile
  node_env "$role"
  port=$HEAD_PORT; hook_port=$HEAD_HOOK_PORT
  [ "$role" = worker ] && { port=$WORKER_PORT; hook_port=$WORKER_HOOK_PORT; }
  pidfile=$(node_pidfile "$role")
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    server_command_matches "$role" "$(cat "$pidfile")" || die "$role PID file points to a process that is not its private server/port"
    if api_ok "$role" info; then return; fi
    die "$role PID file exists but its server is not healthy; run stop and inspect its private log"
  fi
  log="$BASE/$role/server.log"
  (cd "$(repo_dir "$role")" && exec nohup "$OC_EXE" serve --hostname 127.0.0.1 --port "$port" --print-logs) >>"$log" 2>&1 </dev/null &
  echo $! >"$pidfile"
  for _ in $(seq 1 45); do
    if api_ok "$role" info; then echo "$role server ready at $(node_url "$role") (listener port $hook_port)"; return; fi
    sleep 1
  done
  die "$role server failed to start; private log: $log"
}
stop_node() {
  local role=$1 pidfile pid port
  pidfile=$(node_pidfile "$role")
  [ -f "$pidfile" ] || return 0
  pid=$(cat "$pidfile")
  port=$HEAD_PORT
  [ "$role" = worker ] && port=$WORKER_PORT
  if kill -0 "$pid" 2>/dev/null; then
    server_command_matches "$role" "$pid" || die "refusing to stop PID $pid: it is not the recorded private $role server executable/port"
    # PIDs are recorded by this runner only. Never use process-name-wide termination.
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 15); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      command=$(ps -p "$pid" -o command= 2>/dev/null || true)
      [ -n "$command" ] && die "$role server PID $pid did not stop"
    fi
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
Use courier_spawn exactly once with peer "worker", directory "$worker_dir", workName "remote-demo-marker", and isolate true. Do not do the file work yourself.

isolate=true intentionally creates a new Worker-side Git worktree. The actual returned worktree directory in courier_spawn and the child assignment brief is canonical. It will be under the Worker's private worktree storage and can differ from the source repository directory passed above. That is expected; use the returned worktree path and do not describe the path difference as a failure.

Assign the worker this sequence: (1) use the parent session ID from the child brief to call courier_send to the parent with message exactly REMOTE_DEMO_PROGRESS_42 and no status, so it is progress; (2) schedule a message to itself with courier_later for 0.5 minutes from now, saying "finish the marker and report done", then end the turn without further tool calls; (3) only after that scheduled wake, create REMOTE-DEMO-MARKER.txt in the actual assigned worktree with exactly COURIER_REMOTE_DEMO_OK_42 and commit it on a named branch; use the available file-edit tool or a shell call with its required command string, not a patch payload sent to shell; (4) report to the parent with courier_send status done, message exactly REMOTE_DEMO_DONE_42, and artifacts.branch, artifacts.commits, and artifacts.files containing the branch, commit, and REMOTE-DEMO-MARKER.txt. Do no other file work. If a tool call errors, do not claim success.

After the progress report arrives, reply exactly HEAD_UNIT_PROGRESS_SEEN_42 and end your turn. After the done report arrives, reply exactly HEAD_UNIT_WOKE_ON_REMOTE_REPORT_42.
EOF
}

question_prompt() {
  local worker_dir=${REMOTE_SOURCE_ROOT:-$(repo_dir worker)}
  cat <<EOF
Use courier_spawn exactly once with peer "worker", directory "$worker_dir", workName "remote-question-answer", and isolate true. Do not do the file work yourself. Explain that isolate=true creates a new Worker-side Git worktree: the actual returned worktree directory is canonical and can differ from the source repository directory, so the Worker should use its assigned worktree.

Assign the Worker to create a new file named REMOTE-DEMO-ANSWER.json containing a JSON object with an "answer" string field. Do not put the answer value in the assignment. Before changing files, the Worker must use courier_send with status=blocked to ask you what exact string value to use for "answer", then end its turn and wait. When that blocked question arrives, send the value HEAD_ONLY_REPLY_2026-10-19 to the same qualified Worker session using courier_send, then wait. After the Worker wakes, creates valid JSON with your answer, commits it on its existing branch, and reports status=done with branch, commit, and file artifact, acknowledge its completion. Do not poll or send any other Worker messages. If any tool call errors, do not claim success. Worker shell calls must include the required command field; never send patch payloads to shell.
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

head_tui_new() {
  need_private_runtime
  api_ok head info || die "Head Unit service is not ready; run start first"
  local result session_id dir
  dir=$(repo_dir head)
  result="$BASE/head/new-session.json"
  node_env head
  directory=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$dir")
  curl --config "$BASE/head/secrets/curl.conf" -fsS -X POST -H 'Content-Type: application/json' -d '{}' \
    "$(node_url head)/api/session?directory=$directory" >"$result"
  chmod 600 "$result"
  session_id=$(jq -er '.data.id' "$result")
  printf '%s\n' "$session_id" >"$BASE/head/current-session"
  chmod 600 "$BASE/head/current-session"
  echo "New Head Unit session: $session_id"
  cd "$dir"
  exec "$OC" --server "$(node_url head)" --session "$session_id"
}

watch_child() {
  need_private_runtime
  local parent=${2:-} parent_file="$BASE/head/current-session" messages child_record child child_dir child_bare errors
  [ -n "$parent" ] || { [ -r "$parent_file" ] && parent=$(cat "$parent_file"); }
  [ -n "$parent" ] || die "Head session ID missing; run head-tui-new first or pass it explicitly"
  case "$parent" in ses_*) ;; *) die "expected an unqualified Head session ID" ;; esac
  echo "Watching Head Unit session for a remote child; no messages will be sent."
  for _ in $(seq 1 900); do
    messages=$(api_get head "session/$parent/message" 2>/dev/null || true)
    if [ -n "$messages" ]; then
      child_record=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_spawn" and .state.status == "completed") | .state.metadata | [.sessionID, .directory] | @tsv] | first // empty' <<<"$messages")
      errors=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .state.status == "error")] | length' <<<"$messages")
      [ "$errors" = 0 ] || die "Head Unit tool call failed; inspect private API history for $parent"
      [ -n "$child_record" ] && break
    fi
    sleep 1
  done
  [ -n "${child_record:-}" ] || die "no remote child was created within 15 minutes"
  IFS=$'\t' read -r child child_dir <<<"$child_record"
  case "$child" in worker/ses_*) ;; *) die "spawn returned an unexpected remote session reference" ;; esac
  case "$child_dir" in "$BASE"/worker/data/opencode/worktree/*) ;; *) die "spawn returned a directory outside the private Worker worktree root" ;; esac
  [ -d "$child_dir" ] || die "spawn's returned worktree directory is not present"
  child_bare=${child#worker/}
  printf '%s\n%s\n' "$child" "$child_dir" >"$BASE/worker/current-child"
  chmod 600 "$BASE/worker/current-child"
  echo "Attaching to the spawned Worker session in its returned worktree."
  node_env worker
  cd "$child_dir"
  exec "$OC" --server "$(node_url worker)" --session "$child_bare"
}

watch_remote_child() {
  need_private_runtime
  local parent=${2:-} parent_file="$BASE/head/current-session" messages child_record child child_dir child_bare errors
  [ -n "$parent" ] || { [ -r "$parent_file" ] && parent=$(cat "$parent_file"); }
  [ -n "$parent" ] || die "Head session ID missing; run head-tui-new first or pass it explicitly"
  case "$parent" in ses_*) ;; *) die "expected an unqualified Head session ID" ;; esac
  echo "Watching the Mac Head session for a WSL Worker; no messages will be sent."
  for _ in $(seq 1 900); do
    messages=$(api_get head "session/$parent/message" 2>/dev/null || true)
    if [ -n "$messages" ]; then
      errors=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .state.status == "error")] | length' <<<"$messages")
      [ "$errors" = 0 ] || die "Head Unit tool call failed; inspect private API history for $parent"
      child_record=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_spawn" and .state.status == "completed") | .state.metadata | [.sessionID, .directory] | @tsv] | first // empty' <<<"$messages")
      [ -n "$child_record" ] && break
    fi
    sleep 1
  done
  [ -n "${child_record:-}" ] || die "no remote child was created within 15 minutes"
  IFS=$'\t' read -r child child_dir <<<"$child_record"
  case "$child" in worker/ses_*) ;; *) die "spawn returned an unexpected WSL Worker session reference" ;; esac
  case "$child_dir" in "$REMOTE_WORKTREE_ROOT"/*) ;; *) die "spawn returned a worktree outside the private WSL Worker root" ;; esac
  child_bare=${child#worker/}
  echo "Attaching to WSL session $child in its returned worktree."
  exec ssh -tt "$REMOTE_WORKER" "$REMOTE_ATTACH" "$child_bare" "$child_dir"
}

verify_live() {
  need_private_runtime
  local parent=${2:-} parent_file="$BASE/head/current-session" messages child_record child child_dir parent_json child_json worker_reports head_text worker_text invalid false_failure marker report_branch report_commit actual_commit evidence
  [ -n "$parent" ] || { [ -r "$parent_file" ] && parent=$(cat "$parent_file"); }
  [ -n "$parent" ] || die "Head session ID is required (or create it with head-tui-new)"
  messages=$(api_get head "session/$parent/message")
  child_record=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_spawn" and .state.status == "completed") | .state.metadata | [.sessionID, .directory] | @tsv] | first // empty' <<<"$messages")
  [ -n "$child_record" ] || die "Head history has no completed courier_spawn"
  IFS=$'\t' read -r child child_dir <<<"$child_record"
  case "$child" in worker/ses_*) ;; *) die "spawn returned an unexpected remote session reference" ;; esac
  case "$child_dir" in "$BASE"/worker/data/opencode/worktree/*) ;; *) die "spawn returned a directory outside the private Worker worktree root" ;; esac
  parent_json="$BASE/head/live-verification.json"
  child_json="$BASE/worker/live-verification.json"
  printf '%s\n' "$messages" >"$parent_json"
  chmod 600 "$parent_json"
  child=${child#worker/}
  messages=$(api_get_dir worker "session/$child/message" "$child_dir")
  printf '%s\n' "$messages" >"$child_json"
  chmod 600 "$child_json"
  worker_reports=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send" and .state.input.status == "done" and (.state.input.artifacts.files // [] | index("REMOTE-DEMO-MARKER.txt")) and (.state.input.artifacts.branch // "" | length > 0) and (.state.input.artifacts.commits // [] | length > 0)) | .state.input] | length' "$child_json")
  [ "$worker_reports" -gt 0 ] || die "Worker history has no done report with marker artifact"
  report_branch=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send" and .state.input.status == "done") | .state.input.artifacts.branch] | first // empty' "$child_json")
  report_commit=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .name == "courier_send" and .state.input.status == "done") | .state.input.artifacts.commits[0]] | first // empty' "$child_json")
  invalid=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .state.status == "error")] | length' "$parent_json")
  invalid=$((invalid + $(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "tool" and .state.status == "error")] | length' "$child_json")))
  [ "$invalid" = 0 ] || die "live transcript contains $invalid failed tool call(s); private histories: $parent_json and $child_json"
  head_text=$(jq -r '[.data[] | select(.type == "synthetic") | .text] | join("\n")' "$parent_json")
  worker_text=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "text") | .text] | join("\n")' "$parent_json")
  jq -e --arg h "$head_text" '($h | contains("REMOTE_DEMO_PROGRESS_42")) and ($h | contains("REMOTE_DEMO_DONE_42")) and ($h | contains("status=\"done\"")) and ($h | contains("REMOTE-DEMO-MARKER.txt"))' <<<"{}" >/dev/null \
    || die "Head transcript is missing progress, done status, or the marker artifact"
  [[ "$worker_text" == *HEAD_UNIT_WOKE_ON_REMOTE_REPORT_42* ]] || die "Head Unit did not reply after the done report"
  false_failure=$(jq -r '[.data[] | select(.type == "assistant") | .content[]? | select(.type == "text") | .text] | join("\n") | test("cannot complete|can.t complete|different directory|wrong directory|not the assigned directory"; "i")' "$parent_json")
  [ "$false_failure" = false ] || die "Head transcript contains a worktree-path failure claim"
  [ -n "$report_branch" ] && [ -n "$report_commit" ] || die "done report is missing its branch or commit"
  [ "$(git -C "$child_dir" branch --show-current)" = "$report_branch" ] || die "reported branch does not match the worker worktree"
  actual_commit=$(git -C "$child_dir" rev-parse HEAD)
  [[ "$actual_commit" == "$report_commit"* ]] || die "reported commit does not match the worker worktree"
  marker="$child_dir/REMOTE-DEMO-MARKER.txt"
  [ -f "$marker" ] && [ "$(cat "$marker")" = COURIER_REMOTE_DEMO_OK_42 ] || die "worker marker is missing or differs from its expected contents"
  evidence="$BASE/evidence-$(date +%F).txt"
  {
    echo "Live remote-node demo passed on $(date '+%Y-%m-%d %H:%M:%S %Z')."
    echo "Model: chatgpt/gpt-6-luna (kinfer)."
    echo "Head session: $parent"
    echo "Worker session: worker/${child}"
    echo "Worker worktree: $child_dir"
    echo "Branch: $report_branch"
    echo "Commit: $actual_commit"
    echo "Artifact: REMOTE-DEMO-MARKER.txt (exact expected contents verified)."
    echo "Head received progress and completion; both wakeup replies verified."
    echo "Failed tool calls: 0 (Head and Worker histories)."
  } >"$evidence"
  chmod 600 "$evidence"
  echo "PASS: progress and completion reports reached the Head Unit"
  echo "PASS: completion includes status=done and REMOTE-DEMO-MARKER.txt"
  echo "PASS: reported branch and commit match the worker worktree"
  echo "PASS: Head Unit replied after the done report without claiming a worktree path failure"
  echo "PASS: worker marker contents are exact"
  echo "PASS: Head and Worker histories contain no failed tool calls"
  echo "Secret-free evidence: $evidence"
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
  start-head)
    need_private_runtime
    [ -d "$(repo_dir head)/.git" ] || die "run setup first"
    start_node head
    echo "Mac Head service ready at $(node_url head) (remote listener port $HEAD_HOOK_PORT)."
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
  question-prompt) question_prompt ;;
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
  head-tui-new) head_tui_new ;;
  watch-child) watch_child "$@" ;;
  watch-remote-child) watch_remote_child "$@" ;;
  verify-live) verify_live "$@" ;;
  *) die "usage: $0 {build|setup|start|start-head|serve|status|prompt|question-prompt|rehearse|head-tui-new|watch-child [head-session-id]|watch-remote-child [head-session-id]|verify-live [head-session-id]|stop|tui [head-session-id]|reset}" ;;
esac
