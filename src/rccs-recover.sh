#!/bin/sh
set -eu

PROGRAM=${0##*/}
BACKUP_ROOT=${RCCS_SNAPSHOT_ROOT:-"$HOME/.rcc/state/backups/rcc-snapshots"}
BIN_DIR=${RCCS_BIN_DIR:-"$HOME/.local/bin"}
RCC_HOME=${RCC_HOME:-"$HOME/.rcc"}
CONFIG_PATH=${RCCS_CONFIG_PATH:-"$RCC_HOME/config.toml"}
PROVIDER_DIR=${RCCS_PROVIDER_DIR:-"$RCC_HOME/provider"}
SECRETS_DIR=${RCCS_SECRETS_DIR:-"$RCC_HOME/secrets"}
ROLLBACK_ROOT=${RCCS_ROLLBACK_ROOT:-"$RCC_HOME/state/backups/rcc-rollback"}
RCCV3=${RCCS_RCCV3_BIN:-"$BIN_DIR/rccv3"}

usage() {
  cat <<EOF
usage:
  $PROGRAM backup [--id <snapshot-id>]
  $PROGRAM list
  $PROGRAM restore [latest|<snapshot-id>]

environment:
  RCCS_SNAPSHOT_ROOT  snapshot directory (default: \$HOME/.rcc/state/backups/rcc-snapshots)
  RCCS_BIN_DIR        installed binary directory (default: \$HOME/.local/bin)
  RCC_HOME            RouteCodex home (default: \$HOME/.rcc)
EOF
}

fail() {
  printf '%s: %s\n' "$PROGRAM" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

if command -v shasum >/dev/null 2>&1; then
  HASH_TOOL=shasum
elif command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL=sha256sum
else
  HASH_TOOL=
fi

sha256_file() {
  if [ "$HASH_TOOL" = shasum ]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

hash_tree() {
  directory=$1
  (
    cd "$directory"
    find bin config aliases -type f ! -name manifest.sha256 -print | LC_ALL=C sort | while IFS= read -r file; do
      relative=${file#./}
      printf '%s  %s\n' "$(sha256_file "$file")" "$relative"
    done
  )
}

snapshot_dir() {
  case $1 in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$BACKUP_ROOT" "$1" ;;
  esac
}

latest_snapshot() {
  [ -L "$BACKUP_ROOT/latest" ] || fail "no latest snapshot"
  id=$(basename "$(readlink "$BACKUP_ROOT/latest")")
  [ -n "$id" ] || fail "latest snapshot link is empty"
  printf '%s\n' "$id"
}

resolve_snapshot() {
  id=${1:-latest}
  if [ "$id" = latest ]; then
    id=$(latest_snapshot)
  fi
  directory=$(snapshot_dir "$id")
  [ -f "$directory/manifest.sha256" ] || fail "snapshot not found: $id"
  [ -f "$directory/metadata" ] || fail "snapshot metadata missing: $id"
  printf '%s\n' "$directory"
}

copy_file() {
  [ -f "$1" ] || return 0
  mkdir -p "$(dirname "$2")"
  cp -p "$1" "$2"
}

copy_alias() {
  [ -L "$BIN_DIR/$1" ] || return 0
  printf '%s\n' "$(readlink "$BIN_DIR/$1")" > "$2"
}

copy_tree() {
  [ -d "$1" ] || return 0
  mkdir -p "$2"
  cp -R "$1/." "$2/"
}

backup_command() {
  [ "$#" -le 2 ] || fail "usage: $PROGRAM backup [--id <snapshot-id>]"
  id=
  if [ "$#" -gt 0 ]; then
    [ "$1" = "--id" ] || fail "unsupported backup argument: $1"
    [ "$#" -eq 2 ] || fail "--id requires a value"
    id=$2
  fi
  [ -f "$CONFIG_PATH" ] || fail "config not found: $CONFIG_PATH"
  [ -x "$RCCV3" ] || fail "rccv3 not executable: $RCCV3"

  if [ -z "$id" ]; then
    id=$(date -u '+%Y%m%dT%H%M%SZ')
  fi
  case $id in
    */*|.|..|'') fail "invalid snapshot id: $id" ;;
  esac

  _dst="$BACKUP_ROOT/$id"
  if [ -e "$_dst" ]; then
    base=$id
    suffix=1
    while [ -e "$_dst" ]; do
      id="$base-$suffix"
      _dst="$BACKUP_ROOT/$id"
      suffix=$((suffix + 1))
    done
  fi
  mkdir -p "$_dst/bin" "$_dst/config" "$_dst/aliases"

  for name in rccv3 rccv3-admin rccv3-hooksd rccv3-codexapp; do
    copy_file "$BIN_DIR/$name" "$_dst/bin/$name"
  done
  copy_alias rcc "$_dst/aliases/rcc"
  copy_alias routecodex "$_dst/aliases/routecodex"
  cp -p "$CONFIG_PATH" "$_dst/config/config.toml"
  copy_tree "$PROVIDER_DIR" "$_dst/config/provider"
  copy_tree "$SECRETS_DIR" "$_dst/config/secrets"

  {
    printf 'schema=1\n'
    printf 'id=%s\n' "$id"
    printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'rcc_home=%s\n' "$RCC_HOME"
    printf 'config_path=%s\n' "$CONFIG_PATH"
    printf 'bin_dir=%s\n' "$BIN_DIR"
    version=$("$RCCV3" --version 2>/dev/null | head -n 1 || true)
    printf 'rccv3_version=%s\n' "$version"
  } > "$_dst/metadata"

  {
    hash_tree "$_dst"
  } > "$_dst/manifest.sha256"

  ln -sfn "$id" "$BACKUP_ROOT/latest"
  printf 'snapshot=%s\npath=%s\n' "$id" "$_dst"
}

verify_snapshot() {
  directory=$1
  if [ "$HASH_TOOL" = shasum ]; then
    (cd "$directory" && shasum -a 256 -c manifest.sha256) >/dev/null || fail "snapshot hash verification failed: $directory"
  else
    (cd "$directory" && sha256sum -c manifest.sha256) >/dev/null || fail "snapshot hash verification failed: $directory"
  fi
}

list_command() {
  [ "$#" -eq 0 ] || fail "usage: $PROGRAM list"
  [ -d "$BACKUP_ROOT" ] || return 0
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | LC_ALL=C sort | while IFS= read -r directory; do
    id=$(basename "$directory")
    marker=
    if [ -L "$BACKUP_ROOT/latest" ] && [ "$(basename "$(readlink "$BACKUP_ROOT/latest")")" = "$id" ]; then
      marker=' latest'
    fi
    printf '%s%s\n' "$id" "$marker"
  done
}

save_rollback() {
  id=$1
  _dst="$ROLLBACK_ROOT/$id"
  mkdir -p "$_dst/bin" "$_dst/config" "$_dst/aliases"
  for name in rccv3 rccv3-admin rccv3-hooksd rccv3-codexapp; do
    copy_file "$BIN_DIR/$name" "$_dst/bin/$name"
  done
  copy_alias rcc "$_dst/aliases/rcc"
  copy_alias routecodex "$_dst/aliases/routecodex"
  copy_file "$CONFIG_PATH" "$_dst/config/config.toml"
  copy_tree "$PROVIDER_DIR" "$_dst/config/provider"
  copy_tree "$SECRETS_DIR" "$_dst/config/secrets"
  printf '%s\n' "$_dst"
}

replace_tree() {
  __rccs_src=$1
  __rccs_dst=$2
  __rccs_parent=$(dirname "$__rccs_dst")
  __rccs_name=$(basename "$__rccs_dst")
  __rccs_staging="$__rccs_parent/.$__rccs_name.rccs-recover.$$"
  __rccs_previous="$__rccs_parent/.$__rccs_name.rccs-recover-previous.$$"
  rm -rf "$__rccs_staging" "$__rccs_previous"
  __rccs_has_source=0
  if [ -d "$__rccs_src" ]; then
    __rccs_has_source=1
    mkdir -p "$__rccs_staging"
    cp -R "$__rccs_src/." "$__rccs_staging/"
  fi
  if [ -d "$__rccs_dst" ]; then
    mv "$__rccs_dst" "$__rccs_previous"
  fi
  if [ "$__rccs_has_source" -eq 1 ] && ! mv "$__rccs_staging" "$__rccs_dst"; then
    if [ -d "$__rccs_previous" ]; then
      mv "$__rccs_previous" "$__rccs_dst"
    fi
    return 1
  fi
  rm -rf "$__rccs_previous"
}

restore_tree() {
  source_root=$1
  for name in rccv3 rccv3-admin rccv3-hooksd rccv3-codexapp; do
    if [ -f "$source_root/bin/$name" ]; then
      temporary="$BIN_DIR/.$name.rccs-recover.$$"
      cp -p "$source_root/bin/$name" "$temporary"
      chmod 755 "$temporary"
      mv -f "$temporary" "$BIN_DIR/$name"
    else
      rm -f "$BIN_DIR/$name"
    fi
  done
  if [ -f "$source_root/config/config.toml" ]; then
    mkdir -p "$(dirname "$CONFIG_PATH")"
    temporary="$(dirname "$CONFIG_PATH")/.config.toml.rccs-recover.$$"
    cp -p "$source_root/config/config.toml" "$temporary"
    mv -f "$temporary" "$CONFIG_PATH"
  else
    rm -f "$CONFIG_PATH"
  fi
  replace_tree "$source_root/config/provider" "$PROVIDER_DIR"
  replace_tree "$source_root/config/secrets" "$SECRETS_DIR"
  for name in rcc routecodex; do
    if [ -f "$source_root/aliases/$name" ]; then
      target=$(cat "$source_root/aliases/$name")
      ln -sfn "$target" "$BIN_DIR/$name"
    else
      rm -f "$BIN_DIR/$name"
    fi
  done
}

runtime_restart() {
  if ! "$RCCV3" restart -c "$CONFIG_PATH"; then
    server_status=$("$RCCV3" server status -c "$CONFIG_PATH" 2>&1 || true)
    case $server_status in
      *stopped*|*inactive*|*not\ running*) "$RCCV3" server start -c "$CONFIG_PATH" ;;
      *) return 1 ;;
    esac
  fi
  "$RCCV3" status -c "$CONFIG_PATH"
}

restore_command() {
  [ "$#" -le 1 ] || fail "usage: $PROGRAM restore [latest|<snapshot-id>]"
  directory=$(resolve_snapshot "${1:-latest}")
  verify_snapshot "$directory"
  [ -x "$directory/bin/rccv3" ] || fail "snapshot does not contain executable rccv3"

  "$directory/bin/rccv3" config check -c "$directory/config/config.toml" >/dev/null ||
    fail "snapshot config check failed"

  rollback=$(save_rollback "$(date -u '+%Y%m%dT%H%M%SZ').$$")
  if ! restore_tree "$directory"; then
    restore_tree "$rollback" || true
    fail "restore failed; previous files were reapplied"
  fi
  if ! "$RCCV3" config check -c "$CONFIG_PATH" >/dev/null; then
    restore_tree "$rollback" || true
    fail "restored config check failed; previous files were reapplied"
  fi
  if ! runtime_restart; then
    restore_tree "$rollback" || true
    runtime_restart >/dev/null 2>&1 || true
    fail "restored runtime failed to restart; previous files were reapplied"
  fi

  printf 'restored=%s\npath=%s\nrollback=%s\n' "$(basename "$directory")" "$directory" "$rollback"
}

[ -n "$HASH_TOOL" ] || fail "required SHA-256 command not found: shasum or sha256sum"
require_command find
require_command sort
require_command awk
require_command cp
require_command mv
require_command date

command=${1:-}
[ -n "$command" ] || {
  usage
  exit 2
}
shift

case $command in
  backup) backup_command "$@" ;;
  list) list_command "$@" ;;
  restore) restore_command "$@" ;;
  --help|-h|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
