#!/usr/bin/env bash
# serve-local-models.sh - run Qwen coding models locally with llama-server
#
# Two profiles are defined for a 12 GB VRAM / 32 GB RAM laptop:
#
#   fast   Qwen3.6-35B-A3B (MoE, ~3B active). Experts live in system RAM,
#          attention + KV cache live in VRAM. Long context, high tok/s.
#   smart  Qwen3.8-27B (dense). Best local coding quality, slower, and it
#          needs most of the GPU, so it does not coexist with `fast`.
#
# Only one profile should run at a time on this hardware. See README.md
# in this directory for the memory budget behind that rule.
#
# Usage:
#   serve-local-models.sh start  <fast|smart>      start one profile (downloads on first run)
#   serve-local-models.sh switch <fast|smart>      stop the other profile, then start this one
#   serve-local-models.sh stop   [fast|smart|all]  stop a profile (default: all)
#   serve-local-models.sh status                   show what is running, VRAM and RAM
#   serve-local-models.sh cmd    <fast|smart>      print the llama-server command without running it
#
# Every setting below can be overridden from the environment, e.g.
#   FAST_CTX=262144 FAST_NCMOE=36 ./serve-local-models.sh start fast

set -euo pipefail

# ---------------------------------------------------------------- settings --

LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"          # path to the llama-server binary
export LLAMA_CACHE="${LLAMA_CACHE:-$HOME/.cache/llama.cpp}"  # where -hf downloads land
HOST="${HOST:-127.0.0.1}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/local-models}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-1800}"              # seconds to wait for /health (first run downloads ~20 GB)
MTP="${MTP:-1}"                                       # 1 = multi-token-prediction speculative decoding
KV_TYPE="${KV_TYPE:-q8_0}"                            # KV cache quantisation: q8_0 (safe) or q4_0 (more context)

# fast: Qwen3.6-35B-A3B with the MTP head baked in.
FAST_HF="${FAST_HF:-unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL}"
FAST_PORT="${FAST_PORT:-8081}"
FAST_CTX="${FAST_CTX:-131072}"                        # native max is 262144
FAST_NCMOE="${FAST_NCMOE:-32}"                        # expert layers kept in RAM (of 40). Raise on OOM, lower for speed.
FAST_ALIAS="${FAST_ALIAS:-qwen3.6-35b-a3b}"
FAST_RAM_GB=15                                        # rough resident RAM with the defaults above

# smart: Qwen3.8-27B dense. Unsloth GGUFs from UD-Q3 up carry the MTP head.
SMART_HF="${SMART_HF:-unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL}"
SMART_PORT="${SMART_PORT:-8082}"
SMART_CTX="${SMART_CTX:-98304}"                       # native max is 262144, 12 GB VRAM caps it well below that
SMART_NGL="${SMART_NGL:-32}"                          # layers on GPU (of 64). Raise for speed, lower on OOM.
SMART_ALIAS="${SMART_ALIAS:-qwen3.8-27b}"
SMART_RAM_GB=9

# Sampling defaults, used only when the client omits them. These are the
# values Qwen publishes for Qwen3.6; OpenCode normally sends its own.
SAMPLING=(--temp 0.6 --top-p 0.95 --top-k 20 --min-p 0.0 --presence-penalty 0 --repeat-penalty 1)

# ------------------------------------------------------------------ helpers --

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }

profile_var() { # profile_var fast PORT -> value of FAST_PORT
  local p; p="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  eval "printf '%s' \"\${${p}_$2}\""
}

pid_file() { printf '%s/%s.pid' "$STATE_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$STATE_DIR" "$1"; }

running_pid() { # prints the PID if the profile is alive, else nothing
  local f; f="$(pid_file "$1")"
  [[ -f "$f" ]] || return 0
  local pid; pid="$(cat "$f")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then printf '%s' "$pid"; else rm -f "$f"; fi
}

healthy() { curl -fsS -m 2 "http://$HOST:$(profile_var "$1" PORT)/health" >/dev/null 2>&1; }

validate_profile() {
  case "${1:-}" in fast|smart) ;; *) die "profile must be 'fast' or 'smart' (got '${1:-}')";; esac
}

mtp_args() {
  if [[ "$MTP" == "1" ]]; then
    printf '%s\n' --spec-type draft-mtp --spec-draft-n-max 2
  fi
}

build_cmd() { # build_cmd <profile> -> sets global array CMD
  local p="$1"
  CMD=("$LLAMA_SERVER"
    -hf "$(profile_var "$p" HF)"
    --alias "$(profile_var "$p" ALIAS)"
    --host "$HOST" --port "$(profile_var "$p" PORT)"
    -c "$(profile_var "$p" CTX)"
    -fa on --jinja
    --cache-type-k "$KV_TYPE" --cache-type-v "$KV_TYPE"
    --parallel 1)
  case "$p" in
    fast)  CMD+=(-ngl 999 --n-cpu-moe "$FAST_NCMOE") ;;
    smart) CMD+=(-ngl "$SMART_NGL") ;;
  esac
  local a; while IFS= read -r a; do [[ -n "$a" ]] && CMD+=("$a"); done < <(mtp_args)
  CMD+=("${SAMPLING[@]}")
  if [[ -n "${EXTRA_ARGS:-}" ]]; then
    # shellcheck disable=SC2206
    CMD+=($EXTRA_ARGS)
  fi
}

print_cmd() { printf '%q ' "${CMD[@]}"; printf '\n'; }

ram_summary() {
  if [[ -r /proc/meminfo ]]; then
    awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "RAM  total %5.1f GB   available %5.1f GB\n", t/1048576, a/1048576}' /proc/meminfo
  fi
}

vram_summary() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null |
      awk -F', ' '{printf "VRAM %s   total %5.1f GB   used %5.1f GB\n", $1, $2/1024, $3/1024}'
  fi
}

check_ram_for() { # warn if MemAvailable looks too small for the profile
  [[ -r /proc/meminfo ]] || return 0
  local need avail
  need="$(profile_var "$1" RAM_GB)"
  avail="$(awk '/MemAvailable/{printf "%d", $2/1048576}' /proc/meminfo)"
  if (( avail < need + 4 )); then
    printf 'warning: %s needs about %s GB of RAM and only %s GB is available. Leave ~4 GB for Claude Code and the OS.\n' \
      "$1" "$need" "$avail" >&2
  fi
}

# ----------------------------------------------------------------- commands --

cmd_start() {
  local p="$1"; validate_profile "$p"
  command -v "$LLAMA_SERVER" >/dev/null 2>&1 || [[ -x "$LLAMA_SERVER" ]] || die "llama-server not found. Set LLAMA_SERVER=/path/to/llama-server"
  command -v curl >/dev/null 2>&1 || die "curl is required for health checks"
  mkdir -p "$STATE_DIR" "$LLAMA_CACHE"

  local pid; pid="$(running_pid "$p")"
  if [[ -n "$pid" ]]; then info "$p already running (pid $pid) on port $(profile_var "$p" PORT)"; return 0; fi

  local other; other=$([[ "$p" == fast ]] && echo smart || echo fast)
  if [[ -n "$(running_pid "$other")" && "${FORCE:-0}" != "1" ]]; then
    die "$other is running. On 12 GB VRAM / 32 GB RAM the two profiles do not fit together. Use 'switch $p', or FORCE=1 to override."
  fi

  check_ram_for "$p"
  build_cmd "$p"
  info "starting $p on http://$HOST:$(profile_var "$p" PORT)  (log: $(log_file "$p"))"
  print_cmd
  nohup "${CMD[@]}" >"$(log_file "$p")" 2>&1 &
  pid=$!
  printf '%s' "$pid" >"$(pid_file "$p")"

  info "waiting for /health (first run downloads the model into $LLAMA_CACHE, this can take a while)"
  local waited=0
  until healthy "$p"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$(pid_file "$p")"
      printf '\n'; tail -n 30 "$(log_file "$p")" >&2
      die "$p exited before becoming healthy. If it ran out of VRAM, raise ${p^^}_NCMOE (fast) or lower SMART_NGL (smart)."
    fi
    if (( waited >= HEALTH_TIMEOUT )); then
      printf '\n'; info "still loading after ${HEALTH_TIMEOUT}s; leaving it running. Follow: tail -f $(log_file "$p")"; return 0
    fi
    sleep 5; waited=$((waited+5)); printf '.'
  done
  printf '\n'
  info "$p is ready: http://$HOST:$(profile_var "$p" PORT)/v1  model id: $(profile_var "$p" ALIAS)"
}

cmd_stop() {
  local targets=("$@"); [[ ${#targets[@]} -eq 0 || "${targets[0]}" == all ]] && targets=(fast smart)
  local p pid
  for p in "${targets[@]}"; do
    validate_profile "$p"
    pid="$(running_pid "$p")"
    if [[ -z "$pid" ]]; then info "$p not running"; continue; fi
    info "stopping $p (pid $pid)"
    kill "$pid" 2>/dev/null || true
    local i; for i in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    rm -f "$(pid_file "$p")"
  done
}

cmd_switch() {
  local p="$1"; validate_profile "$p"
  local other; other=$([[ "$p" == fast ]] && echo smart || echo fast)
  cmd_stop "$other"
  cmd_start "$p"
}

cmd_status() {
  local p pid
  for p in fast smart; do
    pid="$(running_pid "$p")"
    if [[ -n "$pid" ]]; then
      if healthy "$p"; then printf '%-5s running  pid %-7s http://%s:%s/v1  (%s)\n' "$p" "$pid" "$HOST" "$(profile_var "$p" PORT)" "$(profile_var "$p" HF)"
      else printf '%-5s loading  pid %-7s (not healthy yet, see %s)\n' "$p" "$pid" "$(log_file "$p")"; fi
    else
      printf '%-5s stopped\n' "$p"
    fi
  done
  ram_summary; vram_summary
}

cmd_cmd() { validate_profile "$1"; build_cmd "$1"; print_cmd; }

usage() { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  start)  shift; [[ $# -eq 1 ]] || die "start needs exactly one profile"; cmd_start "$1" ;;
  switch) shift; [[ $# -eq 1 ]] || die "switch needs exactly one profile"; cmd_switch "$1" ;;
  stop)   shift; cmd_stop "$@" ;;
  status) cmd_status ;;
  cmd)    shift; [[ $# -eq 1 ]] || die "cmd needs exactly one profile"; cmd_cmd "$1" ;;
  -h|--help|help|"") usage ;;
  *) die "unknown command '$1' (try --help)" ;;
esac
