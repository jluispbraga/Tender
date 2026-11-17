import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError, type RegistryLogin } from '../../renderer/src/api/types'

// Registry logins Tender keeps for pull and push. The password (or token) is
// encrypted with Electron's safeStorage: DPAPI on Windows, the keyring on
// Linux. It never sits on disk in plain text and never goes back to the
// renderer, which only ever sees the server and the user name.

const HUB = 'docker.io'
/** What the engine expects as serveraddress for Docker Hub. */
const HUB_ADDRESS = 'https://index.docker.io/v1/'

type Stored = Record<string, { username: string; secret: string; savedAt: string }>

const file = () => join(app.getPath('userData'), 'registries.json')

function read(): Stored {
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Stored
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const write = (s: Stored) => writeFileSync(file(), JSON.stringify(s, null, 2), { mode: 0o600 })

/** docker.io, ghcr.io, myregistry:5000 … from what someone typed or from an image reference. */
export function normaliseServer(server: string): string {
  const s = server.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  return !s || s === 'index.docker.io' || s === 'registry-1.docker.io' || s === 'hub.docker.com' ? HUB : s
}

/** The registry an image reference lives on: the first path part if it looks like a host. */
export function registryOf(ref: string): string {
  const first = ref.split('/')[0]
  return ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? normaliseServer(first) : HUB
}

export function listLogins(): RegistryLogin[] {
  return Object.entries(read())
    .map(([server, v]) => ({ server, username: v.username, savedAt: v.savedAt }))
    .sort((a, b) => (a.server === HUB ? -1 : b.server === HUB ? 1 : a.server.localeCompare(b.server)))
}

export function saveLogin(server: string, username: string, password: string): RegistryLogin {
  if (!safeStorage.isEncryptionAvailable()) throw new ApiError('This system has no secure place to keep the password, so Tender won’t store it.', 503)
  const key = normaliseServer(server)
  const all = read()
  const savedAt = new Date().toISOString()
  all[key] = { username, secret: safeStorage.encryptString(password).toString('base64'), savedAt }
  write(all)
  return { server: key, username, savedAt }
}

export function removeLogin(server: string) {
  const all = read()
  delete all[normaliseServer(server)]
  write(all)
}

/** Credentials for the engine, in the shape dockerode passes as X-Registry-Auth. */
export function authFor(server: string): { username: string; password: string; serveraddress: string } | undefined {
  const key = normaliseServer(server)
  const v = read()[key]
  if (!v) return undefined
  try {
    return { username: v.username, password: safeStorage.decryptString(Buffer.from(v.secret, 'base64')), serveraddress: key === HUB ? HUB_ADDRESS : key }
  } catch {
    // Encrypted by another Windows user or machine: as good as not logged in.
    return undefined
  }
}

export const engineAddress = (server: string) => (normaliseServer(server) === HUB ? HUB_ADDRESS : normaliseServer(server))
