import { describe, expect, it } from 'vitest'
import { validChoice } from './engine-choice'
import { endpointFor } from './engines'

describe('engine choice', () => {
  it('accepts automatic, WSL distributions, contexts and addresses, and nothing else', () => {
    for (const ok of ['auto', 'wsl://Ubuntu-24.04', 'context://staging', 'tcp://10.0.0.5:2375', 'ssh://me@box', 'unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine']) expect(validChoice(ok), ok).toBe(true)
    for (const bad of ['', 'http://x', 'wsl://Ubuntu; rm -rf /', 'context://a b', 'ftp://x', 'docker.sock']) expect(validChoice(bad), bad).toBe(false)
  })

  it('turns a choice into an endpoint', () => {
    expect(endpointFor('wsl://Ubuntu')).toMatchObject({ name: 'wsl:Ubuntu', kind: 'npipe', address: 'wsl://Ubuntu' })
    expect(endpointFor('ssh://me@box')).toMatchObject({ kind: 'ssh', address: 'ssh://me@box' })
    expect(endpointFor('tcp://10.0.0.5:2375')).toMatchObject({ kind: 'tcp', source: 'the address chosen in Settings' })
    expect(endpointFor('context://does-not-exist').source).toContain('no longer exists')
  })
})
