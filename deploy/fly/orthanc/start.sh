#!/bin/bash
# Start Orthanc + a socat IPv6→IPv4 bridge so Fly's 6PN can reach it.
#
# Why: Orthanc's mongoose web server only binds IPv4 (0.0.0.0:8042),
# even when `HttpHost: "::"` is set. Fly app-to-app traffic over
# .internal is IPv6-only, so a direct connection fails with "connection
# refused" despite the host being up. socat forwards [::]:8042 → 127.0.0.1:8042
# bridging the gap.
set -euo pipefail

# 1. Boot Orthanc in the background on port 8043 (set via orthanc.json).
#    The upstream entrypoint expects one arg (config directory); it
#    handles env-var → JSON substitution and exec's Orthanc itself.
/docker-entrypoint.sh /etc/orthanc/ &

# 2. Wait for Orthanc to bind on 8043 (max 30s) so socat doesn't accept
#    connections before there's anything to forward to.
for i in $(seq 1 30); do
    if (echo > /dev/tcp/127.0.0.1/8043) 2>/dev/null; then
        echo "[start.sh] orthanc listening on 127.0.0.1:8043 (after ${i}s)"
        break
    fi
    sleep 1
done

# 3. Run socat in the foreground — its lifetime IS the container's.
#    `fork` spawns a child per accepted connection; `reuseaddr` lets
#    Fly health-check probes reconnect cleanly. `ipv6only=0` makes the
#    socket dual-stack so IPv4-mapped IPv6 clients also work.
echo "[start.sh] starting socat [::]:8042 -> 127.0.0.1:8043"
exec socat \
    TCP6-LISTEN:8042,fork,reuseaddr,ipv6only=0 \
    TCP4:127.0.0.1:8043
