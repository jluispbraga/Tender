# Security policy

Tender talks to a Docker Engine and to Kubernetes clusters, and both give whoever controls them a lot of power over a machine. Security reports are welcome and taken seriously.

## Supported versions

Only the latest release gets fixes. Tender checks for updates itself (Settings › Updates), so updating is the fix.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: [Security › Report a vulnerability](https://github.com/jluispbraga/Tender/security/advisories/new). Include:

- the Tender version and the platform (Windows, Linux, and how the engine runs: WSL 2, system service, remote);
- what an attacker can do, and what they need first (local access, a malicious image, a crafted kubeconfig, ...);
- steps to reproduce, or a proof of concept.

You should get a first answer within 7 days. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## In scope

- The renderer escaping its sandbox, or reaching IPC routes it should not.
- IPC input that the main process trusts without validating.
- Secret values (Kubernetes Secrets, registry credentials, environment variables marked as secret) leaking into the UI, logs, files or the SQLite database.
- The WSL bridge or the shared `//./pipe/docker_engine` pipe being reachable by another user on the same machine.
- Downloads Tender makes (Docker CLI, Compose, Buildx, updates) that could be swapped for something else.

## Out of scope

- Anything that requires control of the Docker Engine or the cluster in the first place: that access already means full control.
- Running Tender against an unauthenticated TCP Docker endpoint you exposed yourself.
- Windows SmartScreen warnings: the builds are not code-signed yet. Check the file against `SHA256SUMS.txt` in the release.
