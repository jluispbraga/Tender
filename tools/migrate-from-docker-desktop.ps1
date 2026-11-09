<#
.SYNOPSIS
  Moves images, volumes, networks and containers from Docker Desktop's engine
  to a Docker Engine installed inside a WSL distribution, the engine Tender
  uses without Docker Desktop.

.DESCRIPTION
  Two phases, because Docker Desktop's WSL integration takes over the
  distribution's /var/run/docker.sock while Docker Desktop runs:

    1. -Export  (Docker Desktop OPEN): writes everything to a folder.
    2. -Import  (Docker Desktop CLOSED, the distribution's own engine running):
                loads it into the engine inside WSL.

  Nothing is deleted from Docker Desktop. Run -Export again any time.

  What moves:
    - images: every tagged image, plus any image a container uses
    - volumes: their content (tar), driver and labels
    - networks: user-defined ones, with their labels and IPAM settings
    - containers: recreated from their full configuration through the Docker
      API, labels included, so Compose still recognises its projects; the
      ones that were running are started

  What does NOT move:
    - files a container wrote outside its volumes (commit those first if you
      need them: docker commit <name> <name>-snapshot)
    - Docker Desktop features: Kubernetes, extensions, dev environments
    - bind-mounted folders stay where they are; their Windows paths are
      rewritten to /mnt/<drive>/... so the containers still find them

.EXAMPLE
  .\migrate-from-docker-desktop.ps1 -Export
  .\migrate-from-docker-desktop.ps1 -Import

.EXAMPLE
  # Only some containers (by name or Compose project), and what they use:
  .\migrate-from-docker-desktop.ps1 -Export -Only myproject,redis-cache
#>
[CmdletBinding()]
param(
  [switch]$Export,
  [switch]$Import,
  # Where the export goes. Must be on a Windows drive the distribution can see.
  [string]$Dir = (Join-Path $env:USERPROFILE 'tender-migration'),
  # Target distribution for -Import. Default: the first running one whose engine answers.
  [string]$Distro,
  # Limit the export to these container names or Compose projects.
  [string[]]$Only,
  # Do not start the containers that were running.
  [switch]$NoStart,
  # Do not ask before writing or loading.
  [switch]$Yes
)

# Not 'Stop': in Windows PowerShell, any stderr line from a native command (docker, wsl)
# would then abort the script. Every step checks $LASTEXITCODE itself instead.
$ErrorActionPreference = 'Continue'
# Small image used to copy volume content; it travels with the export so the import needs no network.
$Helper = 'busybox:1.36'

function Say($msg) { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ""; Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Ask($question) {
  if ($Yes) { return }
  $a = Read-Host "$question [y/N]"
  if ($a -notmatch '^(y|yes|s|sim)$') { Write-Host 'Stopped, nothing changed.'; exit 0 }
}
# JSON text -> one object per array item. Windows PowerShell's ConvertFrom-Json hands
# a whole array back as a single object, which breaks filtering and counting.
function FromJson($text) {
  $o = ($text -join "`n") | ConvertFrom-Json
  if ($o -is [array]) { foreach ($x in $o) { $x } } elseif ($null -ne $o) { $o }
}
function ReadJson([string]$path) { FromJson ([System.IO.File]::ReadAllText($path)) }

function ToJson($o) { ConvertTo-Json -InputObject $o -Depth 30 -Compress }
# UTF-8 without a BOM: Windows PowerShell's Set-Content adds one, and the Docker API rejects it.
function WriteJson([string]$path, $o) { [System.IO.File]::WriteAllText($path, (ToJson $o), (New-Object System.Text.UTF8Encoding $false)) }

# A Windows path as the distribution sees it: C:\Users\me -> /mnt/c/Users/me
function WslPath([string]$p) {
  $full = [System.IO.Path]::GetFullPath($p)
  if ($full -notmatch '^([A-Za-z]):\\(.*)$') { Fail "$p must be on a drive letter (C:\...)." }
  return "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\', '/')"
}

# Bind sources as Docker Desktop reports them -> the same folder seen from WSL.
function HostPathToWsl([string]$p) {
  if ($p -match '^/run/desktop/mnt/host/([a-z])/(.*)$') { return "/mnt/$($Matches[1])/$($Matches[2])" }
  if ($p -match '^/host_mnt/([a-z])/(.*)$') { return "/mnt/$($Matches[1])/$($Matches[2])" }
  if ($p -match '^([A-Za-z]):[\\/](.*)$') { return "/mnt/$($Matches[1].ToLower())/$($Matches[2] -replace '\\', '/')" }
  return $p
}

function Has($obj, $name) { return $null -ne $obj -and $obj.PSObject.Properties.Name -contains $name }

# ---------------------------------------------------------------------------
# EXPORT: Docker Desktop -> folder
# ---------------------------------------------------------------------------
function Invoke-Export {
  Step 'Checking Docker Desktop'
  $ctx = @()
  & docker context inspect desktop-linux *> $null
  if ($LASTEXITCODE -eq 0) { $ctx = @('--context', 'desktop-linux') }
  $os = & docker @ctx info --format '{{.OperatingSystem}}' 2>$null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is not running. Open it, wait until its engine is up, and run -Export again.' }
  if ($os -notmatch 'Docker Desktop') { Fail "The current engine is '$os', not Docker Desktop. Nothing to export from." }
  Say "Source: $os"

  # What to take.
  $all = @(& docker @ctx ps -a -q)
  $inspected = @()
  if ($all.Count) { $inspected = @(FromJson (& docker @ctx inspect @all)) }
  if ($Only) {
    $inspected = @($inspected | Where-Object {
        $n = $_.Name.TrimStart('/')
        $proj = $_.Config.Labels.'com.docker.compose.project'
        ($Only -contains $n) -or ($proj -and $Only -contains $proj)
      })
    if (-not $inspected.Count) { Fail "No container or Compose project matches: $($Only -join ', ')" }
  }

  $volNames = New-Object System.Collections.Generic.HashSet[string]
  $netNames = New-Object System.Collections.Generic.HashSet[string]
  $imageRefs = New-Object System.Collections.Generic.HashSet[string]
  foreach ($c in $inspected) {
    foreach ($m in @($c.Mounts)) { if ($m.Type -eq 'volume') { [void]$volNames.Add($m.Name) } }
    foreach ($n in @($c.NetworkSettings.Networks.PSObject.Properties.Name)) { if ($n -notin 'bridge', 'host', 'none') { [void]$netNames.Add($n) } }
    # {{json}}, not a template with quotes: Windows PowerShell mangles quotes inside native arguments.
    $tagged = @(FromJson (& docker @ctx image inspect $c.Image --format '{{json .RepoTags}}' 2>$null) | Where-Object { $_ })
    if ($tagged.Count) { foreach ($t in $tagged) { [void]$imageRefs.Add($t) } } else { [void]$imageRefs.Add($c.Image) }
  }
  if (-not $Only) {
    foreach ($v in @(& docker @ctx volume ls -q)) { if ($v) { [void]$volNames.Add($v) } }
    foreach ($n in @(& docker @ctx network ls --filter type=custom --format '{{.Name}}')) { if ($n) { [void]$netNames.Add($n) } }
    foreach ($t in @(& docker @ctx image ls --format '{{.Repository}}:{{.Tag}}')) { if ($t -and $t -notmatch '<none>') { [void]$imageRefs.Add($t) } }
  }

  Step 'Plan'
  Say "$($inspected.Count) containers, $($volNames.Count) volumes, $($netNames.Count) networks, $($imageRefs.Count) images"
  if (-not $Only) {
    # Engine-wide totals; with -Only the export is a part of this.
    $size = & docker @ctx system df --format '{{.Type}}: {{.Size}}' 2>$null
    foreach ($l in $size) { Say $l }
    Say "Folder: $Dir (needs about the sizes above; volumes are compressed, build cache is not exported)"
  } else {
    Say "Folder: $Dir"
  }
  Ask 'Export now?'

  New-Item -ItemType Directory -Force -Path $Dir, (Join-Path $Dir 'volumes'), (Join-Path $Dir 'containers') | Out-Null

  # Volumes first: the helper image must exist before images are saved, so it travels too.
  if ($volNames.Count) {
    Step "Volumes ($($volNames.Count))"
    & docker @ctx image inspect $Helper *> $null
    if ($LASTEXITCODE -ne 0) { Say "pulling $Helper to copy volume content"; & docker @ctx pull -q $Helper | Out-Null }
    [void]$imageRefs.Add($Helper)
    $vols = @()
    foreach ($v in $volNames) {
      $info = FromJson (& docker @ctx volume inspect $v) | Select-Object -First 1
      $file = "$v.tgz"
      Say "$v"
      & docker @ctx run --rm -v "${v}:/v:ro" -v "$(Join-Path $Dir 'volumes'):/backup" $Helper tar -C /v -czf "/backup/$file" .
      if ($LASTEXITCODE -ne 0) { Fail "Could not copy volume $v" }
      $vols += [pscustomobject]@{ Name = $v; Driver = $info.Driver; Labels = $info.Labels; Options = $info.Options; File = $file }
    }
    WriteJson (Join-Path $Dir 'volumes.json') @($vols)
  }

  Step "Images ($($imageRefs.Count)), one archive"
  & docker @ctx save -o (Join-Path $Dir 'images.tar') @($imageRefs)
  if ($LASTEXITCODE -ne 0) { Fail 'docker save failed' }

  if ($netNames.Count) {
    Step "Networks ($($netNames.Count))"
    $nets = @()
    foreach ($n in $netNames) {
      $i = FromJson (& docker @ctx network inspect $n) | Select-Object -First 1
      Say $n
      $body = [ordered]@{ Name = $i.Name; Driver = $i.Driver; Internal = $i.Internal; Attachable = $i.Attachable; EnableIPv6 = $i.EnableIPv6; Labels = $i.Labels; Options = $i.Options }
      if ($i.IPAM -and $i.IPAM.Config) { $body.IPAM = [ordered]@{ Driver = $i.IPAM.Driver; Config = $i.IPAM.Config } }
      $nets += [pscustomobject]$body
    }
    WriteJson (Join-Path $Dir 'networks.json') @($nets)
  }

  Step "Containers ($($inspected.Count))"
  $idToName = @{}
  foreach ($c in $inspected) { $idToName[$c.Id] = $c.Name.TrimStart('/') }
  $list = @()
  foreach ($c in $inspected) {
    $name = $c.Name.TrimStart('/')
    $cfg = $c.Config
    # Keep the image name when it still points at the same image, else its ID (loaded with the archive).
    $img = $cfg.Image
    $sameId = & docker @ctx image inspect $img --format '{{.Id}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or $sameId -ne $c.Image) { $img = $c.Image }
    $cfg.Image = $img
    # The old ID as hostname would follow the container around; let the engine pick, unless it was set on purpose.
    if ($cfg.Hostname -and $c.Id.StartsWith($cfg.Hostname)) { $cfg.Hostname = '' }

    $hc = $c.HostConfig
    if ($hc.Binds) { $hc.Binds = @($hc.Binds | ForEach-Object { $parts = $_ -split ':(?=/)', 2; if ($parts.Count -eq 2) { "$(HostPathToWsl $parts[0]):$($parts[1])" } else { $_ } }) }
    if ($hc.Mounts) { foreach ($m in $hc.Mounts) { if ($m.Type -eq 'bind') { $m.Source = HostPathToWsl $m.Source } } }
    if ($hc.NetworkMode -match '^container:(.+)$' -and $idToName.ContainsKey($Matches[1])) { $hc.NetworkMode = "container:$($idToName[$Matches[1]])" }
    if (Has $hc 'ContainerIDFile') { $hc.ContainerIDFile = '' }
    # Docker Desktop answers host.docker.internal by itself; a plain engine needs it spelled out.
    $hosts = @($hc.ExtraHosts | Where-Object { $_ })
    if (-not ($hosts | Where-Object { $_ -like 'host.docker.internal:*' })) { $hosts += 'host.docker.internal:host-gateway' }
    $hc.ExtraHosts = $hosts

    # First network goes in the create call, the others are connected afterwards.
    $nets = @()
    foreach ($p in @($c.NetworkSettings.Networks.PSObject.Properties)) {
      $e = $p.Value
      $ep = [ordered]@{}
      if ($e.Aliases) { $ep.Aliases = @($e.Aliases | Where-Object { -not $c.Id.StartsWith($_) }) }
      if ($e.IPAMConfig) { $ep.IPAMConfig = $e.IPAMConfig }
      if ($e.Links) { $ep.Links = $e.Links }
      $nets += [pscustomobject]@{ Network = $p.Name; Endpoint = [pscustomobject]$ep }
    }
    $create = [ordered]@{}
    foreach ($prop in $cfg.PSObject.Properties) { $create[$prop.Name] = $prop.Value }
    $create.HostConfig = $hc
    if ($nets.Count -and $hc.NetworkMode -notmatch '^(container:|host$|none$)') {
      $first = [ordered]@{}
      $first[$nets[0].Network] = $nets[0].Endpoint
      $create.NetworkingConfig = [ordered]@{ EndpointsConfig = $first }
    }
    $file = "$name.json"
    WriteJson (Join-Path (Join-Path $Dir 'containers') $file) $create
    $extra = @()
    if ($nets.Count -gt 1 -and $create.Contains('NetworkingConfig')) { $extra = @($nets | Select-Object -Skip 1) }
    $list += [pscustomobject]@{ Name = $name; File = $file; Running = [bool]$c.State.Running; ExtraNetworks = $extra; Project = $cfg.Labels.'com.docker.compose.project' }
    Say "$name$(if ($c.State.Running) { ' (running)' })"
  }
  WriteJson (Join-Path $Dir 'containers.json') @($list)

  Step 'Done'
  Say "Exported to $Dir"
  Say 'Next: quit Docker Desktop, make sure the engine inside WSL is running, then run:'
  Say '  .\migrate-from-docker-desktop.ps1 -Import'
}

# ---------------------------------------------------------------------------
# IMPORT: folder -> Docker Engine inside WSL
# ---------------------------------------------------------------------------
function Invoke-Import {
  if (-not (Test-Path (Join-Path $Dir 'containers.json'))) { Fail "No export in $Dir. Run -Export first (with Docker Desktop open)." }

  Step 'Checking the engine inside WSL'
  if (-not $Distro) {
    $running = @((& wsl.exe --list --running --quiet) -replace "`0", '' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -notlike 'docker-desktop*' })
    foreach ($d in $running) {
      & wsl.exe -d $d --exec docker version --format '{{.Server.Version}}' *> $null
      if ($LASTEXITCODE -eq 0) { $Distro = $d; break }
    }
    if (-not $Distro) { Fail 'No running WSL distribution has a Docker Engine that answers. Start it (sudo systemctl start docker) and try again, or pass -Distro.' }
  }
  $os = & wsl.exe -d $Distro --exec docker info --format '{{.OperatingSystem}}' 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "Docker does not answer in $Distro." }
  if ($os -match 'Docker Desktop') {
    Fail "In $Distro, docker still talks to Docker Desktop (its WSL integration). Quit Docker Desktop, then restart the distribution's engine: wsl -d $Distro -- sudo systemctl restart docker.socket docker"
  }
  & wsl.exe -d $Distro --exec sh -c 'command -v curl' *> $null
  if ($LASTEXITCODE -ne 0) { Fail "curl is needed inside $Distro to recreate containers: wsl -d $Distro -- sudo apt install -y curl" }
  Say "Target: $os in $Distro"
  $wdir = WslPath $Dir

  # Flattens, so both Wsl docker ps and Wsl @('docker', 'ps') work.
  function Wsl { $a = @($args | ForEach-Object { $_ }); & wsl.exe -d $Distro --exec @a }
  # Docker API inside the distribution. Bodies are files, so no quoting through wsl.exe.
  function Api([string]$method, [string]$path, [string]$bodyFile) {
    $a = @('curl', '-sS', '--unix-socket', '/var/run/docker.sock', '-X', $method, '-w', '\n%{http_code}')
    if ($bodyFile) { $a += @('-H', 'Content-Type: application/json', '--data-binary', "@$bodyFile") }
    $out = & wsl.exe -d $Distro --exec @a "http://localhost$path"
    $lines = @($out)
    $code = [int]$lines[-1]
    return [pscustomobject]@{ Code = $code; Body = ($lines[0..($lines.Count - 2)] -join "`n") }
  }

  $containers = @(ReadJson (Join-Path $Dir 'containers.json'))
  Say "$($containers.Count) containers to recreate"
  Ask "Import into $Distro?"

  if (Test-Path (Join-Path $Dir 'images.tar')) {
    Step 'Images'
    Wsl @('docker', 'load', '-i', "$wdir/images.tar")
    if ($LASTEXITCODE -ne 0) { Fail 'docker load failed' }
  }

  $tmp = Join-Path $Dir 'tmp'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  if (Test-Path (Join-Path $Dir 'networks.json')) {
    Step 'Networks'
    foreach ($n in @(ReadJson (Join-Path $Dir 'networks.json'))) {
      Wsl @('docker', 'network', 'inspect', $n.Name) *> $null
      if ($LASTEXITCODE -eq 0) { Say "$($n.Name): already there"; continue }
      WriteJson (Join-Path $tmp 'net.json') $n
      $r = Api 'POST' '/networks/create' "$wdir/tmp/net.json"
      if ($r.Code -ge 300) { Say "$($n.Name): FAILED $($r.Body)" } else { Say "$($n.Name): created" }
    }
  }

  if (Test-Path (Join-Path $Dir 'volumes.json')) {
    Step 'Volumes'
    foreach ($v in @(ReadJson (Join-Path $Dir 'volumes.json'))) {
      Wsl @('docker', 'volume', 'inspect', $v.Name) *> $null
      if ($LASTEXITCODE -eq 0) { Say "$($v.Name): already there, content left as is"; continue }
      WriteJson (Join-Path $tmp 'vol.json') ([ordered]@{ Name = $v.Name; Driver = $v.Driver; Labels = $v.Labels; DriverOpts = $v.Options })
      $r = Api 'POST' '/volumes/create' "$wdir/tmp/vol.json"
      if ($r.Code -ge 300) { Say "$($v.Name): FAILED $($r.Body)"; continue }
      Wsl @('docker', 'run', '--rm', '-v', "$($v.Name):/v", '-v', "${wdir}/volumes:/backup:ro", $Helper, 'tar', '-C', '/v', '-xzf', "/backup/$($v.File)")
      if ($LASTEXITCODE -ne 0) { Say "$($v.Name): created, but restoring its content FAILED" } else { Say "$($v.Name): restored" }
    }
  }

  Step 'Containers'
  $toStart = @()
  foreach ($c in $containers) {
    Wsl @('docker', 'container', 'inspect', $c.Name) *> $null
    if ($LASTEXITCODE -eq 0) { Say "$($c.Name): already there"; continue }
    $r = Api 'POST' "/containers/create?name=$([uri]::EscapeDataString($c.Name))" "$wdir/containers/$($c.File)"
    if ($r.Code -ge 300) { Say "$($c.Name): FAILED $($r.Body)"; continue }
    foreach ($n in @($c.ExtraNetworks)) {
      WriteJson (Join-Path $tmp 'conn.json') ([ordered]@{ Container = $c.Name; EndpointConfig = $n.Endpoint })
      $r2 = Api 'POST' "/networks/$([uri]::EscapeDataString($n.Network))/connect" "$wdir/tmp/conn.json"
      if ($r2.Code -ge 300) { Say "$($c.Name): could not join $($n.Network): $($r2.Body)" }
    }
    Say "$($c.Name): created"
    if ($c.Running) { $toStart += $c.Name }
  }

  if ($toStart.Count -and -not $NoStart) {
    Step "Starting the $($toStart.Count) that were running"
    foreach ($n in $toStart) {
      Wsl @('docker', 'start', $n) *> $null
      if ($LASTEXITCODE -ne 0) { Say "${n}: did not start (docker logs $n)" } else { Say "${n}: started" }
    }
  }
  Remove-Item -Recurse -Force $tmp

  Step 'Done'
  Say "Everything is in the Docker Engine inside $Distro. Open Tender to see it."
  Say "The export in $Dir can be deleted once you are happy with the result."
  Say 'Docker Desktop still has its copy; uninstall it when you no longer need it.'
}

if ($Export -eq $Import) { Fail 'Pass -Export (Docker Desktop open) or -Import (Docker Desktop closed). See: Get-Help .\migrate-from-docker-desktop.ps1 -Full' }
if ($Export) { Invoke-Export } else { Invoke-Import }
