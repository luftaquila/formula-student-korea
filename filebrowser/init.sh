#!/bin/sh
set -e

# Ensure writable directories
chmod -R 777 /data /srv/files 2>/dev/null || true

if [ ! -f /data/filebrowser.db ]; then
  filebrowser config init --database=/data/filebrowser.db
  filebrowser config set --database=/data/filebrowser.db \
    --address=0.0.0.0 --port=8080 --baseURL=/files \
    --root=/srv/files --auth.method=proxy --auth.header=X-Forwarded-User \
    --log=stdout
fi

exec filebrowser --database=/data/filebrowser.db
