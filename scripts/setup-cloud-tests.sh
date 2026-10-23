#!/bin/sh
# Optional, rootless test tooling for the Debian 13 cloud environment.
# Official signed APT metadata and package checksums remain enabled.
set -eu
. /etc/os-release
if [ "$ID" != debian ] || [ "${VERSION_CODENAME:-}" != trixie ]; then
  echo 'This optional helper targets Debian 13. Use your system coturn or a configured TURN service elsewhere.' >&2
  exit 1
fi
tools_dir=/workspace/.cache/closer-apt
mkdir -p "$tools_dir/etc" "$tools_dir/lists/partial" "$tools_dir/cache/archives/partial" "$tools_dir/log" "$tools_dir/packages"
cat > "$tools_dir/sources.list" <<'SOURCES'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main
SOURCES
cat > "$tools_dir/config" <<'CONFIG'
Dir::Etc::parts "/workspace/.cache/closer-apt/etc";
Dir::Etc::main "/dev/null";
Dir::Etc::sourcelist "/workspace/.cache/closer-apt/sources.list";
Dir::Etc::sourceparts "/workspace/.cache/closer-apt/etc";
Dir::State::lists "/workspace/.cache/closer-apt/lists";
Dir::Cache "/workspace/.cache/closer-apt/cache";
Dir::Log "/workspace/.cache/closer-apt/log";
Acquire::Retries "0";
CONFIG
export APT_CONFIG="$tools_dir/config"
apt-get update
cd "$tools_dir/packages"
apt-get download coturn libhiredis1.1.0 libevent-extra-2.1-7t64 libevent-openssl-2.1-7t64
for package in ./*.deb; do dpkg-deb -x "$package" /workspace/.cache/closer-turn; done
echo 'Local TCP relay installed for browser tests. No system services or browser policies changed.'
