# The repository's contract with sandcastle and CI. The runner knows no stack:
#
#   make setup                          install dependencies (each sandbox, before an agent starts)
#   make verify BASE=<branch> CHANGED=<file>  the checks for one ticket's change; <file> lists
#                                       the changed paths, one per line
#   make check                          the full check: every test and the build; CI runs it too
#
# NOT SET UP YET: `verify` and `check` pass with a warning until the first scaffold ticket
# replaces them with the app's real lint, typecheck, tests and build. A check that passes on
# nothing proves nothing, so do not let a second ticket merge before that one.

.PHONY: help setup verify check docker

help:
	@echo "make setup    install dependencies"
	@echo "make verify   the checks for one change (BASE=<branch> CHANGED=<file>)"
	@echo "make check    the full check, as CI runs it"
	@echo "make docker   start Docker if it is not running (npm run sandcastle calls it)"

setup:
	npm install --prefer-offline --no-audit --no-fund

verify:
	@echo "WARNING: make verify has no checks yet (see the Makefile's header)."

check:
	@echo "WARNING: make check has no checks yet (see the Makefile's header)."

# How long `make docker` waits for Docker to come up before giving up, in seconds.
# Override per run: `make docker DOCKER_WAIT=300`, or `DOCKER_WAIT=300 npm run sandcastle`.
DOCKER_WAIT ?= 120

# Check if Docker is running, if not, start Docker
docker:
	@if docker info > /dev/null 2>&1; then \
		echo "[+] Docker is running"; \
	else \
		echo "[!] Docker is not running. Starting Docker..."; \
		OS=$$(uname -s); \
		if [ "$$OS" = "Darwin" ]; then \
			echo "[>] Detected macOS. Starting Docker Desktop..."; \
			open --background -a Docker > /dev/null 2>&1; \
		elif [ "$$OS" = "Linux" ]; then \
			echo "[>] Detected Linux. Starting Docker Desktop..."; \
			if command -v systemctl > /dev/null 2>&1; then \
				systemctl --user start docker-desktop > /dev/null 2>&1 || \
				sudo systemctl start docker > /dev/null 2>&1 || \
				echo "[x] Unable to start Docker automatically. Please start Docker manually."; \
			else \
				echo "[x] systemctl not found. Please start Docker manually."; \
			fi; \
		elif echo "$$OS" | grep -q "MINGW\|MSYS\|CYGWIN"; then \
			echo "[>] Detected Windows. Starting Docker Desktop..."; \
			powershell.exe -Command "Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'" > /dev/null 2>&1 || \
			cmd.exe /c "start \"\" \"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe\"" > /dev/null 2>&1 || \
			echo "[x] Unable to start Docker automatically. Please start Docker Desktop manually."; \
		else \
			echo "[?] Unknown OS: $$OS. Please start Docker manually."; \
		fi; \
		waited=0; \
		while ! docker info > /dev/null 2>&1; do \
			if [ $$waited -ge $(DOCKER_WAIT) ]; then \
				echo "[x] Docker did not start within $(DOCKER_WAIT) seconds. Please start Docker manually."; \
				exit 1; \
			fi; \
			echo "[~] Waiting for Docker to start... ($${waited}s of $(DOCKER_WAIT)s)"; \
			sleep 1; \
			waited=$$((waited + 1)); \
		done; \
		echo "[+] Docker has started"; \
	fi
