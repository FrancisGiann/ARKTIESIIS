#!/usr/bin/env bash
set -euo pipefail
umask 077

system_user="$(id -un)"
user_home="$(getent passwd "$system_user" | cut -d: -f6)"
if [[ -z "$user_home" ]]; then
  echo 'Could not determine the current user home directory.' >&2
  exit 1
fi

data_home="${XDG_DATA_HOME:-$user_home/.local/share}"
if [[ "$data_home" != /* ]]; then
  echo 'XDG_DATA_HOME must be an absolute path.' >&2
  exit 1
fi

data_dir="${ARKTIESIIS_LOCAL_MARIADB_DIR:-$data_home/arktiesiis/local-mariadb}"
if [[ "$data_dir" != /* ]]; then
  echo 'ARKTIESIIS_LOCAL_MARIADB_DIR must be an absolute path.' >&2
  exit 1
fi

socket_file="$data_dir/mariadb.sock"
pid_file="$data_dir/mariadb.pid"
error_log="$data_dir/mariadb.log"
port=3307
command_name="${1:-status}"

case "$command_name" in
  start|stop|status) ;;
  *)
    echo 'Usage: scripts/local-mariadb.sh {start|stop|status}' >&2
    exit 2
    ;;
esac

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required MariaDB tool is unavailable: $1" >&2
    exit 1
  fi
}

is_running() {
  mariadb-admin --no-defaults --protocol=socket --socket="$socket_file" --user="$system_user" ping >/dev/null 2>&1
}

ensure_data_directory() {
  mkdir -p "$data_dir"
  if [[ "$(stat -c '%u' "$data_dir")" != "$(id -u)" ]]; then
    echo 'The local MariaDB data directory must be owned by the current OS user.' >&2
    exit 1
  fi
  chmod 700 "$data_dir"
}

clear_stale_runtime_files() {
  [[ -e "$pid_file" || -e "$socket_file" ]] || return 0
  if is_running; then
    echo "Local MariaDB is running on 127.0.0.1:$port."
    return 2
  fi

  if [[ -e "$pid_file" ]]; then
    local recorded_pid
    recorded_pid="$(<"$pid_file")"
    if [[ ! "$recorded_pid" =~ ^[0-9]+$ ]] || kill -0 "$recorded_pid" 2>/dev/null; then
      echo 'A MariaDB PID file exists but cannot be confirmed stale. Inspect the private data directory.' >&2
      exit 1
    fi
  fi
  if [[ -e "$socket_file" ]]; then
    if [[ ! -S "$socket_file" || "$(stat -c '%u' "$socket_file")" != "$(id -u)" ]]; then
      echo 'A MariaDB socket file exists but cannot be confirmed stale and private.' >&2
      exit 1
    fi
  fi

  rm -f -- "$pid_file" "$socket_file"
}

start_server() {
  require_tool mariadb-admin
  require_tool mariadb-install-db
  require_tool mariadbd-safe
  require_tool setsid
  ensure_data_directory

  if is_running; then
    echo "Local MariaDB is running on 127.0.0.1:$port."
    return
  fi
  if ! clear_stale_runtime_files; then
    if is_running; then return 0; fi
    exit 1
  fi

  if [[ ! -d "$data_dir/mysql" ]]; then
    if [[ -n "$(find "$data_dir" -mindepth 1 -maxdepth 1 ! -name lifecycle.lock -print -quit)" ]]; then
      echo 'The local MariaDB data directory is non-empty but not initialized. It was left unchanged.' >&2
      exit 1
    fi
    mariadb-install-db --no-defaults --datadir="$data_dir" --user="$system_user" \
      --auth-root-authentication-method=socket --auth-root-socket-user="$system_user" --skip-test-db
  fi

  nohup setsid --fork mariadbd-safe --no-defaults --datadir="$data_dir" --user="$system_user" \
    --socket="$socket_file" --pid-file="$pid_file" --log-error="$error_log" \
    --port="$port" --bind-address=127.0.0.1 --skip-name-resolve --skip-networking=0 \
    9>&- </dev/null >/dev/null 2>&1 &

  for ((attempt = 0; attempt < 60; attempt += 1)); do
    if is_running; then
      echo "Local MariaDB is running on 127.0.0.1:$port."
      return
    fi
    sleep 0.25
  done

  echo 'Local MariaDB did not start. Inspect the private MariaDB log file.' >&2
  exit 1
}

stop_server() {
  require_tool mariadb-admin
  if ! is_running; then
    if [[ -e "$pid_file" || -e "$socket_file" ]]; then
      echo 'A MariaDB PID or socket file exists but the server did not answer. Inspect the private data directory before removing anything.' >&2
      exit 1
    fi
    echo 'Local MariaDB is already stopped.'
    return
  fi

  mariadb-admin --no-defaults --protocol=socket --socket="$socket_file" --user="$system_user" shutdown
  for ((attempt = 0; attempt < 60; attempt += 1)); do
    if ! is_running; then
      echo 'Local MariaDB stopped.'
      return
    fi
    sleep 0.25
  done

  echo 'Local MariaDB did not stop within 15 seconds.' >&2
  exit 1
}

status_server() {
  require_tool mariadb-admin
  if is_running; then
    echo "Local MariaDB is running on 127.0.0.1:$port."
    return
  fi
  if [[ -e "$pid_file" || -e "$socket_file" ]]; then
    echo 'A MariaDB PID or socket file exists but the server did not answer. Inspect the private data directory.' >&2
    exit 1
  fi
  echo 'Local MariaDB is stopped.'
}

require_tool flock
ensure_data_directory
exec 9>>"$data_dir/lifecycle.lock"
chmod 600 "$data_dir/lifecycle.lock"
if ! flock -n 9; then
  echo 'Another local MariaDB lifecycle operation is in progress. Try again shortly.' >&2
  exit 1
fi

case "$command_name" in
  start) start_server ;;
  stop) stop_server ;;
  status) status_server ;;
esac
