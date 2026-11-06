# Tender

Tender is a desktop application for managing Docker environments through a focused graphical interface. It brings container workflows, image management, named volumes, live logs, resource statistics, and an interactive terminal into one place.

Instead of replacing the Docker Engine or Docker CLI, Tender connects to an existing Docker Engine and provides a visual way to inspect and operate it.

> **Project status:** This repository contains the application source code. Check the repository's Releases section for packaged installers; a release/build distribution process is not defined in the supplied project configuration.

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
- A running Docker Engine and permission to access its socket or endpoint when using the real desktop application.
- Windows is the default connection target in the current configuration (`npipe:////./pipe/docker_engine`). The endpoint resolver also supports Docker TCP, SSH, and Unix socket endpoints.

On Windows, any Docker Engine that exposes a compatible endpoint can be used, for example Docker Engine running in WSL 2. Make sure the current Windows user has permission to access the engine.

## Getting started

Clone the repository and install its dependencies:

```bash
git clone https://github.com/jluispbraga/Harbor.git
cd Harbor
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

To preview the built Electron application:

```bash
npm run start
```

## Docker connection

Tender resolves the Docker endpoint using the following order:

1. `DOCKER_HOST`, when set.
2. `DOCKER_CONTEXT`, or the current Docker context configured in `~/.docker/config.json`.
3. The default Windows named pipe: `npipe:////./pipe/docker_engine`.

The resolver reads Docker's existing context configuration; it does not modify it.

### Environment variables

Copy `.env.example` as a starting point when configuring local development. All variables are optional.

| Variable | Purpose |
|---|---|
| `DOCKER_HOST` | Explicit Docker Engine endpoint. |
| `DOCKER_CONTEXT` | Docker context name to use when `DOCKER_HOST` is not set. |
| `DOCKER_TLS_VERIFY` | Set to `1` to enable TLS verification for TCP connections. |
| `DOCKER_CERT_PATH` | Directory containing `ca.pem`, `cert.pem`, and `key.pem` for TLS. |
| `TENDER_DB_PATH` | Custom path for Tender's SQLite database. Defaults to `%APPDATA%\\tender\\tender.db` on Windows. |
| `TENDER_SMOKE` | Development-only script executed against `window.tender` before the app exits. |
| `TENDER_SHOTS` | Development-only output directory for route screenshots generated by smoke runs. |
| `TENDER_SHOT_ROUTES` | Comma-separated route hashes to capture during a smoke run. |

Example for a TCP endpoint:

```powershell
$env:DOCKER_HOST = "tcp://127.0.0.1:2375"
npm run dev
```

Only expose an unauthenticated Docker TCP endpoint on a trusted local environment. Access to a Docker Engine can provide powerful control over the host.

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
