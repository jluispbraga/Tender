# Tender

Tender is a desktop application for managing Docker environments through a focused graphical interface. It brings container workflows, image management, named volumes, live logs, resource statistics, and an interactive terminal into one place.

Instead of replacing the Docker Engine or Docker CLI, Tender connects to an existing Docker Engine and provides a visual way to inspect and operate it.

Tender runs on **Windows** and **Linux** (macOS builds from source).

## Install

Download the latest build from [Releases](https://github.com/jluispbraga/Tender/releases):

| Platform | File |
|---|---|
| Windows | `Tender-Setup-<version>.exe` (installer) or `Tender-<version>-portable.exe` |
| Linux | `Tender-<version>-x86_64.AppImage` (any distribution) or `tender_<version>_amd64.deb` (Debian, Ubuntu) |

The builds are not code-signed yet, so Windows SmartScreen may warn on first run. Each release lists SHA-256 checksums in `SHA256SUMS.txt`.

On Linux, make the AppImage executable first: `chmod +x Tender-*.AppImage`.

## Features

### Containers
- Browse containers and inspect their configuration.
- Start, stop, restart, pause, unpause, and remove containers.
- Follow container logs in real time, search log output, and jump to the latest entries.
- View resource statistics, including CPU, memory, network, block I/O, and process counts.
- Open an interactive terminal session inside a container.
- Inspect ports, mounts, environment variables, labels, and container details.
- Group and operate Docker Compose projects.

### Images
- Browse and inspect local images, tags, layers, and metadata.
- Pull images from a registry with layer-level progress and cancellation.
- Create containers from images, including port mappings, volume mounts, and environment variables.
- Identify images that are in use, unused, or dangling.
- Remove images and prune dangling or unused images while showing reclaimable disk space.

### Volumes
- List and inspect named volumes and their container usage.
- Create and remove volumes.
- See which containers are using a volume before deleting it.

### Beyond Docker Desktop
- **Kubernetes:** pods, deployments, services, StatefulSets, jobs, CronJobs, ingresses, ConfigMaps and secrets (key names only) for every context in your kubeconfig (kind, k3d, minikube, any cluster kubectl reaches). Live pod logs you can search and save, pod details and events, a terminal in a pod and port forwarding. Restart or scale a deployment or StatefulSet, run or pause a CronJob, delete anything; deletes always ask first and name the context, and production clusters ask before every change.
- **Debug shell:** a BusyBox shell that joins a running container's processes and network, for images with no shell of their own (distroless, scratch). The container is not changed.
- **Checkup:** WSL, the engine, DNS and Windows tools checked in one place, each problem with its fix.
- **Memory and disk (Windows):** what WSL holds, memory reclaim and a cap, sparse virtual disks that give space back, build cache.

### Desktop experience
- Light, dark, and system theme options.
- System-tray integration and configurable startup behavior.
- Persistent application preferences, recent items, notifications, and table-column visibility.
- Engine connection status, reconnect action, and troubleshooting guidance.

## Tech stack

| Area | Technologies |
|---|---|
| Desktop runtime | Electron 44 |
| Frontend | React 18, TypeScript, Vite |
| UI and styling | Tailwind CSS 4, Radix UI, Lucide |
| Data fetching and tables | TanStack Query, TanStack Table |
| Docker integration | Dockerode |
| Local persistence | SQLite (`node:sqlite`) |
| Validation | Zod |
| Terminal | xterm.js |
| Charts | uPlot |
| End-to-end tests | Playwright |

## Architecture

Tender separates the desktop process from the user interface:

- **Main process (`src/main`)** — owns the Docker Engine connection, Docker operations, application lifecycle, and local SQLite store.
- **Preload (`src/preload`)** — exposes a limited, typed API to the renderer through Electron IPC.
- **Renderer (`src/renderer`)** — contains the React interface and communicates through the application API abstraction.
- **Fake engine (`src/renderer/src/api/fake`)** — supplies deterministic sample data for browser-based UI development and tests without requiring a live Docker Engine.
- **End-to-end tests (`e2e`, `e2e-electron`)** — cover browser workflows and Electron integration.

Docker objects remain managed by the Docker Engine. Tender's SQLite database stores application state and preferences, rather than duplicating container or image data.

## Requirements

- Node.js compatible with the versions required by Electron 44 and the project dependencies.
- npm.
- A running Docker Engine and permission to use it. Tender never installs, starts or reconfigures the engine.

| Where the engine runs | What to do |
|---|---|
| Linux (system service) | Nothing, as long as your user is in the `docker` group. |
| Linux (rootless Docker) | Nothing: Tender finds `$XDG_RUNTIME_DIR/docker.sock`. |
| Windows, Docker Engine installed inside WSL 2 | Nothing: keep the distribution running and Tender bridges to it (see below). |
| Windows, WSL 2 without Docker yet | **Set up Docker in WSL** in Tender installs Docker Engine in a Debian or Ubuntu distribution, following Docker's own instructions: systemd, Docker's apt repository, your user in the `docker` group. |
| Windows, Docker Desktop or dockerd as a service | Nothing: Tender uses the default named pipe. |
| Another machine | Set `DOCKER_HOST` (for example `ssh://user@host`) or a Docker context. |

## Getting started

Clone the repository and install its dependencies:

```bash
git clone https://github.com/jluispbraga/Tender.git
cd Tender/app
npm install
```

### Run the desktop application

```bash
npm run dev
```

This starts the Electron application in development mode. For Docker-backed features, make sure the Docker Engine is running and reachable.

### Run the renderer in a browser

```bash
npm run dev:design
```

This starts the renderer at `http://localhost:5174` using the fake engine implementation. It is intended for UI development and browser-based workflows; it does not manage the host's real Docker resources.

### Build

```bash
npm run build
```

The build command runs TypeScript checks and then builds the Electron application.

To package it for the current platform (output in `app/release`):

```bash
npm run dist
```

`npm run dist:win` builds the Windows installer and portable exe; `npm run dist:linux` builds the AppImage and `.deb` and must run on Linux. Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds both on GitHub Actions and attaches them to a draft release.

To preview the built Electron application:

```bash
npm run start
```

## Docker connection

Tender resolves the Docker endpoint using the following order:

1. `DOCKER_HOST`, when set.
2. `DOCKER_CONTEXT`, or the current Docker context configured in `~/.docker/config.json`.
3. The platform's default local endpoint:
   - **Linux:** `/var/run/docker.sock`, then rootless `$XDG_RUNTIME_DIR/docker.sock`, then Docker Desktop for Linux.
   - **macOS:** Docker Desktop, `/var/run/docker.sock`, Colima, OrbStack, Rancher Desktop.
   - **Windows:** the named pipe `npipe:////./pipe/docker_engine`.
4. **Windows only:** if that pipe does not exist, a Docker Engine inside a running WSL distribution.

The resolver reads Docker's existing context configuration; it does not modify it.

### Docker Engine inside WSL (Windows)

If you installed Docker Engine straight into a WSL distribution (no Docker Desktop), Windows programs cannot open its Unix socket. Tender bridges it for you:

- It looks only at distributions that are **already running** (`wsl --list --running`), so it never boots one.
- It uses the first one where `docker version` answers.
- Every connection goes through `docker system dial-stdio` inside that distribution, the same relay the Docker CLI uses over SSH, behind a private named pipe on the Windows side.

There is no TCP port, no root and no change to the distribution. You do not need to set `DOCKER_HOST`; if you set one, it still wins.

**Moving away from Docker Desktop?** Your existing containers, images and volumes live inside Docker Desktop's engine. Tender moves them to the engine inside WSL: the installer offers it when it finds Docker Desktop, and the **Move from Docker Desktop** page is always in Settings. [docs/migrate-from-docker-desktop.md](docs/migrate-from-docker-desktop.md) explains it, and also covers a command-line script.

**Docker tools on Windows.** While Tender runs, it serves the standard pipe `//./pipe/docker_engine` from the engine inside WSL, unless Docker Desktop already serves it. With that pipe, `docker.exe`, the VS Code Docker extension, Testcontainers and JetBrains IDEs work without Docker Desktop. Settings › Docker on Windows can also install the official Docker CLI, Compose and Buildx for your user, with no admin rights; Compose and Buildx are checked against the SHA-256 that GitHub records for each release file. Keep Tender in the notification area and start it at sign-in, so the pipe is always there.

If your user is not in the distribution's `docker` group, the connection error says so. Fix it with `sudo usermod -aG docker $USER` inside WSL, then `wsl --terminate <distro>` and start the distribution again.

### Environment variables

Copy `.env.example` as a starting point when configuring local development. All variables are optional.

| Variable | Purpose |
|---|---|
| `DOCKER_HOST` | Explicit Docker Engine endpoint. |
| `DOCKER_CONTEXT` | Docker context name to use when `DOCKER_HOST` is not set. |
| `DOCKER_TLS_VERIFY` | Set to `1` to enable TLS verification for TCP connections. |
| `DOCKER_CERT_PATH` | Directory containing `ca.pem`, `cert.pem`, and `key.pem` for TLS. |
| `TENDER_DB_PATH` | Custom path for Tender's SQLite database. Defaults to `%APPDATA%\\tender\\tender.db` on Windows and `~/.config/tender/tender.db` on Linux. |
| `TENDER_SMOKE` | Development-only script executed against `window.tender` before the app exits. |
| `TENDER_SHOTS` | Development-only output directory for route screenshots generated by smoke runs. |
| `TENDER_SHOT_ROUTES` | Comma-separated route hashes to capture during a smoke run. |

Example for a TCP endpoint:

```powershell
$env:DOCKER_HOST = "tcp://127.0.0.1:2375"
npm run dev
```

Only expose an unauthenticated Docker TCP endpoint on a trusted local environment. Access to a Docker Engine can provide powerful control over the host. For an engine inside WSL you do not need TCP at all (see above).

## Testing

The repository includes Playwright end-to-end tests.

Run the browser-based suite:

```bash
npx playwright test --config playwright.config.ts
```

The browser suite starts the renderer in design mode and uses the fake engine. It is useful for validating UI behavior without changing real Docker resources.

The repository also contains Electron integration tests:

```bash
npx playwright test --config playwright.electron.config.ts
```

The Electron suite exercises the application against a real engine, so use a development machine and Docker environment where test operations are safe.

## Project structure

```text
.
├── e2e/                         # Browser end-to-end tests
├── e2e-electron/                # Electron integration tests
├── resources/                   # Application and tray icons
├── scripts/                     # Development smoke scripts
├── src/
│   ├── main/                    # Electron main process, Docker engine, SQLite
│   ├── preload/                 # Secure renderer bridge
│   └── renderer/
│       └── src/
│           ├── api/             # API types and fake implementation
│           ├── app/             # App shell and routing
│           ├── components/      # Reusable UI components
│           └── pages/           # Containers, images, volumes, settings, etc.
└── package.json
```

## Security notes

- The renderer runs with context isolation and sandboxing enabled; Node integration is disabled.
- Renderer-to-main communication is exposed through a constrained preload API.
- IPC requests are accepted only from the trusted application window.
- Tender does not request browser permissions for camera, microphone, or notifications.
- Docker access is inherently privileged. Connect only to Docker endpoints you trust, and protect any remote endpoint appropriately.

## Contributing

Contributions, bug reports, and suggestions are welcome. Before opening a pull request:

1. Install dependencies with `npm install`.
2. Run `npm run build` to check types and build the application.
3. Run the relevant Playwright tests.
4. Include clear reproduction steps for bug fixes and screenshots for UI changes when useful.

## License

Tender is released under the [MIT License](LICENSE).
