#!/bin/sh
set -e

# Fly mounts the volume at /data owned by root:root, so `forma` cannot write state.db or the
# audit log until ownership is fixed. This runs as root on every boot (the mount replaces
# whatever the image had at /data), then drops privileges before starting the server.
chown -R forma:forma /data

exec gosu forma "$@"
