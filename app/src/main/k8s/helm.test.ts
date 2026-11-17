import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeRelease, maskValues } from './helm'

/** What a Secret's data.release holds: base64 (Kubernetes) of base64 (Helm) of gzipped JSON. */
const encode = (o: unknown) => Buffer.from(gzipSync(Buffer.from(JSON.stringify(o))).toString('base64')).toString('base64')

describe('helm releases', () => {
  it('decodes a release the way Helm 3 stores it', () => {
    const r = decodeRelease(encode({ name: 'web', namespace: 'shop', version: 3, info: { status: 'deployed' }, chart: { metadata: { name: 'nginx', version: '15.4.2' } } }))
    expect(r).toMatchObject({ name: 'web', version: 3, info: { status: 'deployed' }, chart: { metadata: { name: 'nginx' } } })
  })

  it('masks values that look like credentials, at any depth', () => {
    const v = maskValues({ replicas: 2, auth: { enabled: true, password: 'hunter2' }, db: { url: 'postgres://db', apiKey: 'k' }, tokens: ['a', 'b'], image: { tag: '1.2' } })
    expect(v).toEqual({ replicas: 2, auth: { enabled: true, password: '••••' }, db: { url: 'postgres://db', apiKey: '••••' }, tokens: ['••••', '••••'], image: { tag: '1.2' } })
  })
})
