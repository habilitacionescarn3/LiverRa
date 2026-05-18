# LiverRa staging Orthanc image — slim wrapper over the upstream
# `orthancteam/orthanc` distribution with our pinned config + a socat
# IPv6→IPv4 bridge for Fly internal networking.
#
# Why socat: Orthanc's bundled mongoose HTTP server binds IPv4 only on
# the orthancteam image, ignoring `HttpHost: "::"`. Fly's 6PN routes
# inter-app traffic over IPv6 exclusively (`liverra-orthanc.internal`
# resolves to an IPv6 address only). socat listens on `[::]:8042` and
# forwards to `127.0.0.1:8042` where Orthanc is happily IPv4-listening,
# closing the gap with zero changes to Orthanc itself.
#
# Version pin: 24.10.1 ships DICOMweb 1.18 with multipart-related
# STOW-RS streaming, which our `dicomwebClient.ts` frontend requires.

FROM orthancteam/orthanc:24.10.1

# socat — cheap, audited, single-purpose. ~250 KB installed.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*

# Orthanc config (env-var substitution happens at start time via the
# orthancteam entrypoint).
COPY orthanc.json /etc/orthanc/orthanc.json

# Bridge starter — runs Orthanc on 127.0.0.1:8042 (its native bind),
# then socat exposes [::]:8042 for the Fly internal network.
COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 8042

ENTRYPOINT ["/usr/local/bin/start.sh"]
