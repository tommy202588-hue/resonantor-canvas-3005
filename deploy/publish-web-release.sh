#!/usr/bin/env bash
set -euo pipefail
umask 077

release_id=${1:?Release id required}
expected_digest=${2:?Archive SHA256 required}
previous_id=${3:?Expected current release required}
mode=${4:-full}
[[ "$mode" == full || "$mode" == csp-only || "$mode" == frontend-only ]]
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ "$previous_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]
[[ "$expected_digest" =~ ^[a-f0-9]{64}$ ]]
[[ $(id -u) == 0 ]]

base=/opt/web/resonantor-canvas
archive="$base/incoming/$release_id.tar.gz"
target="$base/releases/$release_id"
previous="$base/releases/$previous_id"
service=resonantor-canvas-test
[[ -L "$base/current" ]]
[[ $(readlink -f "$base/current") == "$previous" ]]
[[ -d "$previous" && ! -L "$target" ]]
printf '%s  %s\n' "$expected_digest" "$archive" | sha256sum -c -
nginx -t
systemctl is-active --quiet "$service"
original_api_pid=$(systemctl show "$service" --property=MainPID --value)

backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-before-$release_id"
mkdir -p "$backup"
printf '%s\n' "$previous" > "$backup/previous-release.txt"
systemctl show "$service" --property=MainPID,ExecStart,User,WorkingDirectory > "$backup/service-before.txt"
backup_paths=(var/lib/resonantor-canvas-test etc/nginx etc/systemd/system/resonantor-canvas-test.service)
if [[ -f /etc/resonantor-canvas-test.env ]]; then backup_paths+=(etc/resonantor-canvas-test.env); fi
tar -czf "$backup/state-and-config.tar.gz" -C / "${backup_paths[@]}"
sha256sum /var/lib/resonantor-canvas-test/model-settings.json /var/lib/resonantor-canvas-test/session.key /var/lib/resonantor-canvas-test/gpu-server-settings.json > "$backup/preserved-settings.sha256"
curl --fail --silent --show-error https://www.resonantor.cn/ | sha256sum > "$backup/home-before.sha256"

if [[ -e "$target" ]]; then
    [[ -d "$target" ]]
    tar -xOf "$archive" ./SHA256SUMS | cmp - "$target/SHA256SUMS"
else
    mkdir -m 0755 "$target"
    tar -xzf "$archive" -C "$target" --no-same-owner --no-same-permissions
fi
find "$target" -type d -exec chmod 0755 {} +
find "$target" -type f -exec chmod 0644 {} +
(cd "$target" && sha256sum -c SHA256SUMS)
test -f "$target/server/generated-image-downloads.mjs"
if [[ "$mode" == csp-only ]]; then
    diff -qr "$previous/server" "$target/server"
    while read -r digest filename; do
        if [[ "$filename" == dist/* ]]; then
            printf '%s  %s\n' "$digest" "$previous/$filename" | sha256sum -c -
        fi
    done < "$target/SHA256SUMS"
elif [[ "$mode" == frontend-only ]]; then
    diff -qr "$previous/server" "$target/server"
    if [[ -d "$previous/services" || -d "$target/services" ]]; then diff -qr "$previous/services" "$target/services"; fi
    diff -qr "$previous/deploy" "$target/deploy"
    cmp "$previous/package.json" "$target/package.json"
else
    cmp "$previous/deploy/web-test-static-security.conf" "$target/deploy/web-test-static-security.conf"
fi
while IFS= read -r source; do /opt/node-v22.14.0/bin/node --check "$source"; done < <(find "$target/server" -name '*.mjs' -type f)
cp -an "$previous/dist/assets/." "$target/dist/assets/"
[[ $(readlink -f "$base/current") == "$previous" ]]

switched=false
rollback() {
    status=$?
    if [[ "$switched" == true ]]; then
        ln -s "$previous" "$base/rollback-$release_id"
        mv -Tf "$base/rollback-$release_id" "$base/current"
        if [[ "$mode" == csp-only ]]; then nginx -t && nginx -s reload; elif [[ "$mode" == full ]]; then systemctl restart "$service"; fi
        printf 'ROLLED_BACK=%s\n' "$previous" >&2
    fi
    exit "$status"
}
trap rollback ERR
ln -s "$target" "$base/next-$release_id"
mv -Tf "$base/next-$release_id" "$base/current"
switched=true
if [[ "$mode" == csp-only ]]; then nginx -t; nginx -s reload; elif [[ "$mode" == full ]]; then systemctl restart "$service"; fi
for attempt in {1..15}; do
    if curl --fail --silent http://127.0.0.1:5113/healthz > "$backup/health-after.json"; then break; fi
    sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:5113/healthz
systemctl is-active --quiet "$service"
if [[ "$mode" == frontend-only ]]; then
    [[ $(systemctl show "$service" --property=MainPID --value) == "$original_api_pid" ]]
fi
if [[ "$mode" == csp-only ]]; then
    [[ $(systemctl show "$service" --property=MainPID --value) == "$original_api_pid" ]]
    for attempt in {1..15}; do
        if curl --fail --silent --show-error -I https://www.resonantor.cn/resonantor-canvas/ > "$backup/headers-after.txt" && grep -qi 'content-security-policy:.*connect-src.*data:.*blob:' "$backup/headers-after.txt"; then break; fi
        sleep 1
    done
    grep -i 'content-security-policy:.*connect-src.*data:.*blob:' "$backup/headers-after.txt"
fi
curl --fail --silent --show-error https://www.resonantor.cn/resonantor-canvas/ -o "$backup/published-index.html"
cmp "$target/dist/index.html" "$backup/published-index.html"
sha256sum -c "$backup/preserved-settings.sha256"
curl --fail --silent --show-error https://www.resonantor.cn/ | sha256sum > "$backup/home-after.sha256"
cmp "$backup/home-before.sha256" "$backup/home-after.sha256"
nginx -t
trap - ERR
printf '\nRELEASE=%s\nPREVIOUS=%s\nBACKUP=%s\n' "$target" "$previous" "$backup"
