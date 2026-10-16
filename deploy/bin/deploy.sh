#!/usr/bin/env bash
# Zero-downtime blue/green deploy for treelogy-ab on the VPS. Runs as root.
#
#   deploy.sh [all|app|dash] [git-ref]   build <git-ref> (default: main) and make it live;
#                                        `all` (the default) builds both from one SHA
#   deploy.sh rollback [app|dash]        make the previous release live again (no rebuild)
#   deploy.sh restart  [app|dash|all]    re-launch the live release on the other slot, e.g.
#                                        to pick up a changed env file — no rebuild, no downtime
#   deploy.sh status                     show the live slot and the available releases
#
# Two components, each with two slots behind its own nginx upstream:
#   app   Shopify app (react-router)  127.0.0.1:3300/3301  ab.treelogy-services.my.id
#   dash  dashboard (Next.js)         127.0.0.1:3310/3311  dash.treelogy-services.my.id
# Each slot is a <unit>@<port> systemd instance running the release its
# slots/<port> symlink points at. A deploy builds a new release, starts it on
# the idle slot, and only once that slot answers its health probe does nginx
# switch to it — via a graceful reload, so in-flight requests finish on the old
# slot. A release that fails anywhere before the switch never takes traffic;
# one that misbehaves right after it is switched back while the old slot is
# still running.
#
# `all` builds the app and the dashboard from the same commit: lib/stats.ts and
# friends are copied from the app into the dashboard, and one SHA guarantees
# both sides compute results with the same formulas.
set -Eeuo pipefail

readonly REPO_URL=https://github.com/kemasghanitreelogy/A-B-Test-App-Shopify.git
readonly MIRROR=/opt/treelogy-ab/repo.git
readonly KEEP_RELEASES=5
readonly DRAIN_SECONDS=10

# Per-component settings, selected with use_component.
APP= BASE= RELEASES= SLOTS= CURRENT= ENV_FILE= UPSTREAM= UPSTREAM_CONF= SLOT_VAR= DOMAIN=
RUN_DIR= HEALTH_PATH=
PORTS=() SMOKE_PATHS=()

use_component() {
  case $1 in
    app)
      APP=treelogy-ab UPSTREAM=treelogy_ab DOMAIN=ab.treelogy-services.my.id
      PORTS=(3300 3301) RUN_DIR=. HEALTH_PATH=/healthz
      # /healthz proves the process and the database; it can't see a route
      # that breaks on its own. Smoke the pages Shopify loads.
      SMOKE_PATHS=(/ /auth/login) ;;
    dash)
      APP=treelogy-ab-dash UPSTREAM=treelogy_ab_dash DOMAIN=dash.treelogy-services.my.id
      PORTS=(3310 3311) RUN_DIR=dashboard/.next/standalone HEALTH_PATH=/api/healthz
      SMOKE_PATHS=(/login) ;;
    *) die "unknown component: $1 (app|dash)" ;;
  esac
  BASE=/opt/$APP RELEASES=/opt/$APP/releases SLOTS=/opt/$APP/slots CURRENT=/opt/$APP/current
  ENV_FILE=/etc/$APP/env UPSTREAM_CONF=/etc/nginx/conf.d/$APP-upstream.conf
  SLOT_VAR=${UPSTREAM}_slot
}

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 $*)"

# One deploy at a time: two builds racing for the same slot is how you get a
# release nobody built.
exec 9>/run/lock/treelogy-ab-deploy.lock
flock -n 9 || die "another deploy is already running"

# Build steps run as the service user so nothing it produces is root-owned.
as_app() { runuser -u "$APP" -- env HOME="$BASE" npm_config_cache="$BASE/.npm" "$@"; }
# The git mirror belongs to the app user whichever component is being built.
as_git() { runuser -u treelogy-ab -- env HOME=/opt/treelogy-ab "$@"; }

# prisma reads DATABASE_URL from the environment; load the env file into a
# subshell only, so secrets never land in this script's own environment.
# Parsed literally, the way systemd's EnvironmentFile reads it — sourcing it
# with bash would treat the `&` in a Neon URL as a background operator.
with_env() {
  as_app bash -c '
    q=$'"'"'\x27'"'"'
    while IFS= read -r line; do
      [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
      k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
      if [[ $v == \"*\" || $v == "$q"*"$q" ]]; then v=${v:1:${#v}-2}; fi
      export "$k=$v"
    done < "$0"
    exec "$@"' "$ENV_FILE" "$@"
}

live_port() { sed -nE 's/^[[:space:]]*server 127\.0\.0\.1:([0-9]+);.*/\1/p' "$UPSTREAM_CONF" 2>/dev/null | head -1; }
idle_port() { local live; live=$(live_port); [[ $live == "${PORTS[0]}" ]] && echo "${PORTS[1]}" || echo "${PORTS[0]}"; }

previous_release() {
  local live
  live=$(readlink -f "$CURRENT" 2>/dev/null || true)
  # Newest release that has served production before and isn't the live one.
  # A release that failed to build, migrate or come up never earns the marker,
  # so it can never become a rollback target.
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r |
    while read -r r; do
      [[ $RELEASES/$r != "$live" && -f $RELEASES/$r/.deployable ]] && { echo "$RELEASES/$r"; break; }
    done
}

# Poll a slot's health probe for up to 60s (a cold Next.js server or a slow
# first DB connection). A slot that keeps crashing is given up on at its second
# automatic restart instead.
slot_healthy() {
  local port=$1 unit=$APP@$1 restarts
  restarts=$(systemctl show -p NRestarts --value "$unit")
  for _ in $(seq 1 30); do
    curl -fsS --max-time 5 "http://127.0.0.1:$port$HEALTH_PATH" >/dev/null 2>&1 && return 0
    (( $(systemctl show -p NRestarts --value "$unit") - restarts >= 2 )) && return 1
    sleep 2
  done
  return 1
}

# Smoke the component's key pages on the idle slot directly, before it gets
# any traffic.
slot_smoke() {
  local port=$1 path code
  for path in "${SMOKE_PATHS[@]}"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port$path")
    [[ $code == 200 ]] || { echo "smoke: GET $path on :$port → $code" >&2; return 1; }
  done
}

start_slot() {
  local port=$1 rel=$2
  ln -sfn "$rel/$RUN_DIR" "$SLOTS/$port.next" && mv -T "$SLOTS/$port.next" "$SLOTS/$port"
  # A slot that crash-looped earlier is left "failed" by StartLimitBurst and
  # would refuse a plain start.
  systemctl reset-failed "$APP@$port" 2>/dev/null || true
  systemctl restart "$APP@$port" || true   # whether it came up is slot_healthy's call
}

# The release a slot runs: its symlink points at RUN_DIR inside the release.
slot_release() {
  local d
  d=$(readlink -f "$SLOTS/$1" 2>/dev/null) || return 0
  if [[ $RUN_DIR == . ]]; then echo "$d"; else echo "${d%/"$RUN_DIR"}"; fi
}

stop_slot() {
  systemctl stop "$APP@$1" 2>/dev/null || true
  systemctl disable --quiet "$APP@$1" 2>/dev/null || true
  systemctl reset-failed "$APP@$1" 2>/dev/null || true
}

write_upstream() {
  cat <<EOF
# Managed by $APP-deploy — the live blue/green slot. Do not edit by hand.
upstream $UPSTREAM {
    server 127.0.0.1:$1;
    keepalive 16;
}

# Which slot served a request, echoed as X-Upstream to loopback clients only,
# so the deploy can tell the new slot is really taking traffic.
map \$remote_addr \$$SLOT_VAR {
    127.0.0.1 \$upstream_addr;
    default   "";
}
EOF
}

# Point nginx at a slot. The old file is restored if `nginx -t` rejects the new
# one, so a bad write can never leave nginx unloadable.
route_to() {
  local port=$1 prev
  prev=$(cat "$UPSTREAM_CONF" 2>/dev/null || true)
  write_upstream "$port" > "$UPSTREAM_CONF.next"
  mv -f "$UPSTREAM_CONF.next" "$UPSTREAM_CONF"
  if ! nginx -t -q 2>/dev/null; then
    if [[ -n $prev ]]; then printf '%s\n' "$prev" > "$UPSTREAM_CONF"; else rm -f "$UPSTREAM_CONF"; fi
    return 1
  fi
  systemctl reload nginx
}

# End to end through nginx and TLS, the way Shopify reaches the app. Only a
# response that X-Upstream proves came from the new slot counts: `nginx
# reload` returns before the new workers take over, and a check answered by an
# old worker (still routing to the old slot) would pass a broken release.
edge_healthy() {
  local port=$1 path hdr seen=0
  for _ in $(seq 1 20); do
    local all_ok=1 from_new=1
    for path in "${SMOKE_PATHS[@]}"; do
      hdr=$(curl -s -D - -o /dev/null --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" \
            "https://$DOMAIN$path" | tr -d '\r')
      grep -qi "^x-upstream: 127.0.0.1:$port\$" <<<"$hdr" || from_new=0
      grep -qE '^HTTP/[0-9.]+ 200' <<<"$hdr" || all_ok=0
    done
    if (( from_new )); then
      (( all_ok )) && return 0
      (( ++seen >= 3 )) && return 1   # the new slot itself is answering wrongly
    fi
    sleep 1
  done
  return 1
}

# The heart of deploy and rollback: bring <rel> up on the idle slot, switch
# nginx to it, then retire the old slot.
go_live() {
  local rel=$1 old new
  old=$(live_port); new=$(idle_port)
  log "starting $(basename "$rel") on idle slot :$new"
  start_slot "$new" "$rel"
  if ! slot_healthy "$new" || ! slot_smoke "$new"; then
    journalctl -u "$APP@$new" -n 30 --no-pager -q >&2 || true
    stop_slot "$new"
    die "$(basename "$rel") never became healthy on :$new; live slot :${old:-none} untouched"
  fi

  log "switching nginx :${old:-none} → :$new"
  route_to "$new" || { stop_slot "$new"; die "nginx rejected the new upstream; live slot untouched"; }
  if ! edge_healthy "$new"; then
    if [[ -n $old ]]; then
      log "edge check failed — switching nginx back to :$old"
      route_to "$old" || true
    fi
    stop_slot "$new"
    die "$(basename "$rel") failed behind nginx; traffic is back on :${old:-none}"
  fi

  ln -sfn "$rel" "$CURRENT.next" && mv -T "$CURRENT.next" "$CURRENT"
  as_app touch "$rel/.deployable"   # proven in production: a valid rollback target
  systemctl enable --quiet "$APP@$new"
  if [[ -n $old && $old != "$new" ]]; then
    # nginx's old workers finish their in-flight requests to the old slot.
    sleep "$DRAIN_SECONDS"
    stop_slot "$old"
  fi
  log "live: $(basename "$rel") on :$new"
}

# Each step is checked explicitly: `set -e` is suspended inside a subshell
# whose status is tested with `||`, so a failing build would otherwise fall
# through to the next command and report success.
build_app() {
  cd "$1" || return 1
  export NODE_OPTIONS=--max-old-space-size=1536
  as_app npm ci --no-audit --no-fund --loglevel=error || return 1
  as_app npx prisma generate || return 1
  as_app npm run build || return 1
  [[ -f build/server/index.js ]] || { echo "build produced no build/server/index.js" >&2; return 1; }
  as_app npm prune --omit=dev --no-audit --no-fund --loglevel=error || return 1
}

# The dashboard runs from Next's standalone output, which carries its own traced
# node_modules but not the static assets. The build reads the env file because
# NEXT_SERVER_ACTIONS_ENCRYPTION_KEY and NEXT_PUBLIC_* are baked in at build time.
build_dash() {
  local sha=$2
  cd "$1/dashboard" || return 1
  export NODE_OPTIONS=--max-old-space-size=1536
  as_app npm ci --no-audit --no-fund --loglevel=error || return 1   # postinstall: prisma generate
  with_env env NEXT_DEPLOYMENT_ID="${sha:0:12}" NEXT_TELEMETRY_DISABLED=1 npm run build || return 1
  [[ -f .next/standalone/server.js ]] || { echo "build produced no .next/standalone/server.js" >&2; return 1; }
  as_app cp -R .next/static .next/standalone/.next/static || return 1
  as_app cp -R public .next/standalone/public || return 1
  # Everything the server needs is inside standalone/ now; the rest is ~1 GB per release.
  rm -rf -- node_modules .next/cache
}

status_component() {
  echo "[$1] live: $(readlink -f "$CURRENT" 2>/dev/null || echo none) on :$(live_port)"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort -r |
    while read -r r; do
      printf '  %s%s\n' "$r" "$([[ -f $RELEASES/$r/.deployable ]] || echo '  (never went live — not a rollback target)')"
    done
  for p in "${PORTS[@]}"; do echo "  slot :$p  $(systemctl is-active "$APP@$p" || true)"; done
}

cmd_status() {
  local c
  for c in app dash; do
    use_component "$c"
    [[ -d $BASE ]] && status_component "$c"
  done
}

cmd_restart() {
  local live; live=$(readlink -f "$CURRENT" 2>/dev/null || true)
  [[ -n $live && -d $live ]] || die "[$APP] no live release to restart"
  log "[$APP] re-launching $(basename "$live") on the other slot"
  go_live "$live"
}

cmd_rollback() {
  local target
  target=$(previous_release)
  [[ -n $target ]] || die "[$APP] no previous release to roll back to"
  log "[$APP] rolling back to $(basename "$target")"
  go_live "$target"
}

# Build every requested component before any of them goes live, so a broken
# dashboard build can't leave the app on a commit the dashboard never reached.
cmd_deploy() {
  local target=$1 ref=$2 sha c
  local -a comps
  local -A rel
  [[ $target == all ]] && comps=(app dash) || comps=("$target")

  if [[ ! -d $MIRROR ]]; then
    log "cloning $REPO_URL"
    as_git git clone --mirror --quiet "$REPO_URL" "$MIRROR"
  fi
  log "fetching"
  as_git git --git-dir="$MIRROR" fetch --prune --quiet origin
  sha=$(as_git git --git-dir="$MIRROR" rev-parse --verify "$ref^{commit}") || die "unknown ref: $ref"

  for c in "${comps[@]}"; do
    use_component "$c"
    [[ -r $ENV_FILE ]] || die "$ENV_FILE missing"
    rel[$c]=$RELEASES/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:7}
    log "[$c] building ${sha:0:7} ($ref) in $(basename "${rel[$c]}")"
    as_app mkdir -p "${rel[$c]}"
    if [[ $c == dash ]]; then
      as_git git --git-dir="$MIRROR" archive "$sha" dashboard | as_app tar -x -C "${rel[$c]}"
    else
      as_git git --git-dir="$MIRROR" archive "$sha" | as_app tar -x -C "${rel[$c]}"
    fi
    echo "$sha" | as_app tee "${rel[$c]}/REVISION" >/dev/null
    # A failed build leaves its directory behind for inspection but never goes live.
    ( "build_$c" "${rel[$c]}" "$sha" ) || die "[$c] build failed; nothing switched (${rel[$c]} left for inspection)"
  done

  # Migrations belong to the app and run before the switch, against the
  # database the old release is still serving from — so they must stay
  # backward compatible (expand, deploy, then contract in a later release).
  if [[ -n ${rel[app]:-} ]]; then
    use_component app
    log "[app] applying migrations"
    ( cd "${rel[app]}" && with_env npx prisma migrate deploy ) || die "migration failed; nothing switched"
  fi

  for c in "${comps[@]}"; do
    use_component "$c"
    go_live "${rel[$c]}"
    prune_releases
  done
}

# Keep the newest KEEP_RELEASES proven releases as rollback targets, plus only
# the newest failed one for inspection. Failed builds must not count toward the
# quota: a run of bad deploys would otherwise push every rollback target out.
prune_releases() {
  local in_use proven=0 failed=0 r
  in_use=$(for p in "${PORTS[@]}"; do slot_release "$p"; done; readlink -f "$CURRENT")
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r |
    while read -r r; do
      grep -qxF "$RELEASES/$r" <<<"$in_use" && continue
      if [[ -f $RELEASES/$r/.deployable ]]; then
        (( ++proven < KEEP_RELEASES )) && continue    # the live one is the KEEP_RELEASES-th
      else
        (( ++failed <= 1 )) && continue
      fi
      rm -rf -- "${RELEASES:?}/$r"
    done
}

case ${1:-} in
  rollback) use_component "${2:?usage: rollback app|dash}"; cmd_rollback ;;
  restart)
    if [[ ${2:-all} == all ]]; then
      for c in app dash; do use_component "$c"; cmd_restart; done
    else
      use_component "$2"; cmd_restart
    fi ;;
  status)   cmd_status ;;
  -h|--help) sed -n '2,10p' "$0" ;;
  all|app|dash) cmd_deploy "$1" "${2:-main}" ;;
  *)        cmd_deploy all "${1:-main}" ;;   # deploy.sh <git-ref>, as before components
esac
