#!/bin/sh
# Buckets + one least-privilege MinIO user per service. Uses root creds from
# env (MINIO_ROOT_USER / MINIO_ROOT_PASSWORD) only to bootstrap everything.
set -e
until mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do sleep 1; done

mc mb --ignore-existing local/uploads
mc mb --ignore-existing local/converted
echo 'buckets ok'

make_user() {
  # $1 user, $2 password env var value; policy file mounted at /init/policy-$1.json
  mc admin user add local "$1" "$2" >/dev/null 2>&1 || true
  mc admin policy remove local "p-$1" >/dev/null 2>&1 || true
  mc admin policy create local "p-$1" "/init/policy-$1.json" || true
  mc admin policy attach local "p-$1" --user "$1" || true
  echo "user $1 scoped"
}

make_user api "$MINIO_API_PASSWORD"
make_user worker "$MINIO_WORKER_PASSWORD"
make_user notifier "$MINIO_NOTIFIER_PASSWORD"
echo 'storage ready'
tail -f /dev/null
