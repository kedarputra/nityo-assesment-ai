FROM node:22.23.4-bookworm

# The full (not -slim) bookworm image already has git, make, a C toolchain and
# python3. These are the rest.
RUN apt-get update && apt-get install -y \
  curl \
  jq \
  python3-venv \
  sqlite3 \
  && rm -rf /var/lib/apt/lists/*

# Issue tracker: no CLI to install. Tasks are markdown files under grilled/ in
# this repository, read and written by .sandcastle/tracker.mjs (plain Node, no
# dependencies, no auth, no network). See docs/agents/issue-tracker.md.

# The image serves whatever stack the app settles on: Node for a TypeScript app,
# Python with uv for a Python one. `make setup` (the onSandboxReady hook in
# main.mts) installs the app's own dependencies on top. Add a toolchain here
# only when the app needs one this image lacks, then rebuild:
# npm run sandcastle:build-image.

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI, pinned. An unpinned install is cached at whatever
# version the first build fetched, and a newer model then fails with "API Error:
# 400 ... does not support this model". Bumping this ARG busts the layer cache.
ARG CLAUDE_CODE_VERSION=2.1.280
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_CODE_VERSION}

# uv, for a Python app. Pinned like Claude Code, for the same reason.
ARG UV_VERSION=0.9.5
RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | sh

# Claude Code and uv install into ~/.local/bin
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at /home/agent/workspace
# and overrides the working directory to /home/agent/workspace at container start.
# Structure your Dockerfile so that /home/agent/workspace can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
