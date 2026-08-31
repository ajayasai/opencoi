# Backup and restore

The `/app/data` volume is the complete durable unit for the standard Docker Compose deployment. It includes the SQLite database, its journal files, uploaded certificates, and generated storage artifacts. Back up and restore the directory as one unit; a database-only backup can leave document records without their files.

The safest portable procedure stops the application before copying the volume. Do not copy a live SQLite database and its uploads independently.

## Backup with Docker Compose

Run these commands from the deployment directory on a POSIX shell. They briefly stop OpenCOI so SQLite can close cleanly.

```sh
set -euo pipefail
mkdir -p backups
docker compose stop opencoi
container_id="$(docker compose ps --all --quiet opencoi)"
test -n "$container_id"
data_volume="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')"
test -n "$data_volume"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
docker run --rm \
  --volume "$data_volume:/data:ro" \
  --volume "$PWD/backups:/backups" \
  alpine:3.22 \
  tar -czf "/backups/opencoi-${timestamp}.tar.gz" -C /data .
docker compose start opencoi
sha256sum "backups/opencoi-${timestamp}.tar.gz" > "backups/opencoi-${timestamp}.tar.gz.sha256"
tar -tzf "backups/opencoi-${timestamp}.tar.gz" >/dev/null
```

If any command fails after the stop, start the service explicitly with `docker compose start opencoi` after investigating. Confirm `docker compose ps` reports the service as healthy.

The helper image is operational tooling and should be pinned to an approved digest in controlled environments. An infrastructure snapshot is also acceptable when it atomically captures the stopped volume.

## Protect and retain backups

- Encrypt backups before copying them off-host; COIs and account data are sensitive.
- Store at least one copy in a separate failure domain with access logging and deletion protection.
- Keep the checksum beside the encrypted archive and verify it after transfer.
- Use a documented retention schedule and securely expire old copies.
- Record the OpenCOI release tag or commit, backup time, and restoration test result.
- Test restoration periodically on an isolated host using synthetic notification endpoints.

A backup is not proven until a restore test can open the application, authenticate, retrieve a synthetic document, and produce a consistent compliance result.

## Restore a backup

Restore into a deployment running the same OpenCOI release that created the backup, then upgrade normally. The following operation replaces every file in the selected Compose data volume. Verify the deployment directory, archive path, container ID, and volume name before continuing.

1. Stop the service.
2. Verify the archive checksum and list its contents.
3. Take a separate pre-restore backup if the current data may be needed.
4. Clear only the resolved OpenCOI data volume and extract the archive.
5. Start the service and verify it before reconnecting users or outbound mail.

```sh
set -euo pipefail
backup_file="$PWD/backups/opencoi-YYYYMMDDTHHMMSSZ.tar.gz"
test -f "$backup_file"
sha256sum --check "${backup_file}.sha256"
if tar -tzf "$backup_file" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Refusing an archive containing an unsafe path" >&2
  exit 1
fi
tar -tzf "$backup_file" | sed -n '1,40p'

docker compose stop opencoi
container_id="$(docker compose ps --all --quiet opencoi)"
test -n "$container_id"
data_volume="$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}')"
test -n "$data_volume"
printf 'Restoring into Docker volume: %s\n' "$data_volume"

backup_name="$(basename "$backup_file")"
docker run --rm \
  --volume "$data_volume:/data" \
  --volume "$PWD/backups:/backups:ro" \
  alpine:3.22 \
  sh -eu -c 'test -f "/backups/$1"; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf "/backups/$1" -C /data' \
  sh "$backup_name"

docker compose start opencoi
docker compose ps
curl --fail --silent --show-error http://127.0.0.1:4174/api/health
```

The archive preserves the container user's numeric ownership. If a storage driver or external restore tool changes ownership, `/app/data` must be writable by UID/GID 1000 before startup.

## Post-restore validation

- Confirm the container becomes healthy without schema or permission errors.
- Run `node dist/server/cli/migrate.js --check` in the restored release and
  confirm every checksummed migration is recorded and structurally present.
- Sign in with an administrator account.
- Open several synthetic vendor and certificate records and confirm their files are retrievable.
- Verify requirement evaluations, exception history, exports, and audit events.
- Confirm the expected reminder schedule before re-enabling SMTP delivery.
- Review timestamps and row counts against the backup record.

Keep the failed or replaced volume isolated until validation is complete. Do not run the old and restored instances against the same volume or allow both to send reminders.

## Non-Docker installations

Stop the OpenCOI process and archive the configured `DATA_DIR` as one unit. Restore it to the same absolute paths, permissions, OpenCOI version, and Node.js major version. If `DATABASE_PATH` or `UPLOAD_DIR` points outside `DATA_DIR`, include those targets in the same quiesced backup set and document the mapping.
