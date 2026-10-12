# LifeOS overlay on this fork's app image: adds the runtimes the stdio MCP wrappers need.
# Built by .github/workflows/publish-server-image.yml (job `lifeos`) from the app image of the
# same commit; deploy pins the result by digest. Not offered upstream.
#
# The wrapper scripts are not in the image. They are bind-mounted read-only at /opt/lifeos/mcp,
# and secrets come from a mounted file, so nothing private is baked into this public image.
ARG BASE
FROM ${BASE}
USER root
# mcp 1.30.0 is the newest release that still ships mcp.server.fastmcp, which the wrappers use.
# @paperclipai/mcp-server 0.1.0 has no Node engine floor; 2026.1005.0 needs Node >= 24.11 and the
# base image is Node 22.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/lifeos/venv \
 && /opt/lifeos/venv/bin/pip install --no-cache-dir "mcp==1.30.0" "convex==0.8.1" "google-auth==2.61.0" \
 && mkdir -p /opt/lifeos/node \
 && cd /opt/lifeos/node \
 && npm init -y >/dev/null \
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund "@paperclipai/mcp-server@0.1.0" \
 && chown -R root:root /opt/lifeos
USER node
