# LifeOS image overlay

Fork-only layer on top of this fork's `app` image. It adds what the LifeOS stdio MCP wrappers
need inside the `api` and `worker` containers, and nothing else:

| Path | Contents |
| --- | --- |
| `/opt/lifeos/venv` | Python venv with `mcp==1.30.0`, `convex==0.8.1`, `google-auth==2.61.0` |
| `/opt/lifeos/node/node_modules/.bin/paperclip-mcp-server` | `@paperclipai/mcp-server@0.1.0` |

Not in the image, mounted at run time instead:

- the wrapper scripts, read-only at `/opt/lifeos/mcp`, so a wrapper fix is a git change and not
  an image rebuild;
- secrets, from a mounted file the wrappers read. Never put them in `McpServer.env`: that column
  is plain JSON in the database.

## Build

CI builds it in the `lifeos` job of `.github/workflows/publish-server-image.yml`, from the app
image of the same commit, one image per architecture:

```text
ghcr.io/<owner>/rakazo/app-lifeos:sha-<commit>-amd64
ghcr.io/<owner>/rakazo/app-lifeos:sha-<commit>-arm64
```

Deploy pins the arm64 image by digest. A local build needs the base image passed in:

```bash
docker build -f infra/lifeos/Dockerfile \
  --build-arg BASE=ghcr.io/<owner>/rakazo/app:sha-<commit> \
  -t rakazo-app-lifeos:local .
```

## Version pins

Pinned by hand on the day; bump them deliberately:

- `mcp` stays on 1.x: the wrappers import `mcp.server.fastmcp`, which 2.x no longer ships.
- `@paperclipai/mcp-server` stays on 0.1.0 while the base image is Node 22; 2026.1005.0
  declares `node >= 24.11.0`.
