# Leaving Docker Desktop on Windows

Tender works with a Docker Engine installed straight into WSL 2, so you do not need Docker Desktop.

Your containers, images and volumes, though, live inside Docker Desktop's own engine. Only Docker Desktop can open them, so moving them out is a one-time job. This guide does it with [`tools/migrate-from-docker-desktop.ps1`](../tools/migrate-from-docker-desktop.ps1).

Nothing is deleted from Docker Desktop at any point. If something goes wrong, your old setup is still there.

## 1. Install Docker Engine inside WSL

Skip this if `docker version` inside your distribution already shows a **Server** section that does not mention Docker Desktop.

In Ubuntu (or Debian), follow Docker's official guide for your distribution ("Install Docker Engine on Ubuntu"). Then let your user run it without sudo:

```bash
sudo usermod -aG docker $USER
```

Close the distribution (`wsl --terminate Ubuntu` from Windows) and open it again.

> **Keep the two apart.** While Docker Desktop runs with WSL integration on for this distribution, Docker Desktop takes over the distribution's `/var/run/docker.sock`. After quitting Docker Desktop, give the socket back to the distribution's own engine:
>
> ```bash
> wsl -d Ubuntu -- sudo systemctl restart docker.socket docker
> ```
>
> To stop this from happening, turn integration off in Docker Desktop › Settings › Resources › WSL integration. It stops for good once Docker Desktop is uninstalled.

## 2. Export from Docker Desktop

Open Docker Desktop and wait until its engine is running. Then, in PowerShell, from the folder where you cloned Tender:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\migrate-from-docker-desktop.ps1 -Export
```

The script first shows how much there is (containers, volumes, networks, images and their sizes) and asks before writing. By default it writes to `%USERPROFILE%\tender-migration`; pick another drive with `-Dir D:\tender-migration`.

It writes:

| File | What it is |
|---|---|
| `images.tar` | Every tagged image, plus any image a container uses, in one archive. |
| `volumes\*.tgz`, `volumes.json` | Each volume's content, driver and labels. |
| `networks.json` | Your own networks (not `bridge`, `host`, `none`). |
| `containers\*.json`, `containers.json` | Each container's full configuration, ready to recreate it. |

To move only part of it, name containers or Compose projects:

```powershell
.\tools\migrate-from-docker-desktop.ps1 -Export -Only shop,redis-cache
```

## 3. Switch engines

1. Quit Docker Desktop: right-click its tray icon, then **Quit Docker Desktop**.
2. Give the socket back to the engine inside WSL (see the note in step 1):
   ```bash
   wsl -d Ubuntu -- sudo systemctl restart docker.socket docker
   ```
3. Check that it answers, and that it is not Docker Desktop:
   ```bash
   wsl -d Ubuntu -- docker info --format "{{.OperatingSystem}}"
   ```
   This should print something like `Ubuntu 24.04 LTS`, not `Docker Desktop`.

## 4. Import into WSL

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\migrate-from-docker-desktop.ps1 -Import
```

It finds the running distribution whose engine answers (or use `-Distro Ubuntu`), then works in this order:

1. loads the images;
2. recreates the networks;
3. recreates the volumes and restores their content;
4. recreates the containers with their full configuration and labels, so `docker compose` still recognises its projects;
5. starts the containers that were running. Pass `-NoStart` to skip this.

Anything already present in the target (same name) is left alone, so running `-Import` twice is safe.

## 5. Open Tender

Tender finds the engine inside WSL by itself. If you set `DOCKER_HOST` earlier for a workaround, remove it first:

```powershell
setx DOCKER_HOST ""
```

When everything looks right, you can:

- delete the export folder;
- uninstall Docker Desktop;
- switch the Docker CLI on Windows back to the default context, if you still use it: `docker context use default`.

## What changes for your containers

- **Files written outside volumes** are not moved, because a recreated container starts from its image. If a container keeps data in its own filesystem, snapshot it before exporting with `docker commit <name> <name>-snapshot`, and point the container at that image.
- **Bind mounts** keep pointing at the same Windows folders, now through `/mnt/c/...`. Access across the Windows/WSL boundary is slower than files inside the distribution; for heavy I/O, move those folders into WSL (`~/projects`).
- **`host.docker.internal`** is answered by Docker Desktop on its own. The script adds `host.docker.internal:host-gateway` to each container so it keeps working.
- **Published ports** still reach Windows on `localhost`, through WSL's localhost forwarding.
- **Not covered:** Docker Desktop's Kubernetes, extensions and dev environments.
