import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contexts, fileStem, guessEnv, setKubeSources, sourceReport } from './kube'

describe('fileStem: the name an added kubeconfig file gives its cluster', () => {
  it.each([
    // Built with this OS's separator: the app only ever sees its own platform's paths.
    [join('home', 'you', '.kube', 'prod', 'flake-prod-kubeconfig'), 'flake-prod'],
    ['/home/you/.kube/kubeconfig-qa.yaml', 'qa'],
    ['/home/you/.kube/shop_kubeconfig.yml', 'shop'],
    ['/home/you/.kube/eks-staging.yaml', 'eks-staging'],
    ['/home/you/.kube/team.kubeconfig.json', 'team'],
    ['/home/you/.kube/my-cluster', 'my-cluster'],
  ])('%s → %s', (file, stem) => expect(fileStem(file)).toBe(stem))
})

describe('guessEnv: what a cluster is for, from its names', () => {
  it.each([
    [['flake-prod', 'microk8s'], 'prod'],
    [['payments-prd'], 'prod'],
    [['shop', 'production'], 'prod'],
    [['flake-qa', 'microk8s'], 'qa'],
    [['eks-staging'], 'qa'],
    [['app-hml'], 'qa'],
    [['homologacao'], 'qa'],
    [['team-dev'], 'dev'],
    [['minikube'], 'local'],
    [['kind-dev-cluster'], 'dev'],
    [['kind-shop'], 'local'],
    [['microk8s', 'https://127.0.0.1:16443'], 'local'],
    [['docker-desktop'], 'local'],
  ] as const)('%j → %s', (hints, env) => expect(guessEnv(...hints)).toBe(env))

  it('does not see "prod" inside other words', () => {
    expect(guessEnv('product-catalog')).toBeUndefined()
    expect(guessEnv('reproduce')).toBeUndefined()
    expect(guessEnv('devops-tools')).toBeUndefined()
  })

  it('production wins over everything else', () => {
    expect(guessEnv('prod', 'https://127.0.0.1:6443')).toBe('prod')
    expect(guessEnv('dev', 'prod')).toBe('prod')
  })

  it('has no guess for a plain name', () => expect(guessEnv('microk8s', 'microk8s-cluster', 'https://10.0.0.12:16443')).toBeUndefined())
})

// Two clusters set up with microk8s defaults, as people get them from a VM: the same
// context name in each file. Only the file names tell them apart.
const microk8s = (server: string) => `apiVersion: v1
kind: Config
clusters:
- name: microk8s-cluster
  cluster:
    server: ${server}
    insecure-skip-tls-verify: true
users:
- name: admin
  user:
    token: not-a-real-token
contexts:
- name: microk8s
  context:
    cluster: microk8s-cluster
    user: admin
current-context: microk8s
`

describe('kubeconfig sources', () => {
  let home: string
  const saved = { KUBECONFIG: process.env.KUBECONFIG, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tender-kube-'))
    process.env.USERPROFILE = home
    process.env.HOME = home
    delete process.env.KUBECONFIG
    setKubeSources([])
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v))
    setKubeSources([])
    rmSync(home, { recursive: true, force: true })
  })

  it('reads only what was added, and names same-named contexts after their files', () => {
    const prod = join(home, 'prod')
    mkdirSync(prod)
    writeFileSync(join(prod, 'flake-prod-kubeconfig'), microk8s('https://10.0.0.12:16443'))
    writeFileSync(join(prod, 'flake-qa-kubeconfig'), microk8s('https://10.0.0.21:16443'))
    writeFileSync(join(prod, 'flake-old-kubeconfig.bak'), microk8s('https://10.0.0.9:16443'))
    writeFileSync(join(prod, 'notes.txt'), 'not a kubeconfig')
    writeFileSync(join(prod, 'payments'), microk8s('https://10.0.0.40:16443'))

    expect(contexts()).toEqual([])
    setKubeSources([prod])
    const cs = contexts()
    expect(cs.map((c) => [c.defaultLabel, c.context, c.guessedEnv])).toEqual([
      ['flake-prod', 'microk8s', 'prod'],
      // A QA file kept in a folder called prod is still QA: the file name wins.
      ['flake-qa', 'microk8s', 'qa'],
      // A file whose own names say nothing takes the folder's hint.
      ['payments', 'microk8s', 'prod'],
    ])
    // Unique ids for the API, stable keys for the user's names.
    expect(new Set(cs.map((c) => c.name)).size).toBe(3)
    expect(new Set(cs.map((c) => c.key)).size).toBe(3)
    expect(sourceReport().added[0].files.map((f) => f.contexts)).toEqual([['microk8s'], ['microk8s'], ['microk8s']])
  })

  it('picks up a file dropped into an added folder without a restart', () => {
    const dir = join(home, 'clusters')
    mkdirSync(dir)
    setKubeSources([dir])
    expect(contexts()).toEqual([])
    writeFileSync(join(dir, 'shop-staging.yaml'), microk8s('https://10.0.0.30:16443'))
    expect(contexts().map((c) => c.defaultLabel)).toEqual(['shop-staging'])
  })

  it('says so when an added path is gone', () => {
    setKubeSources([join(home, 'nowhere')])
    expect(sourceReport().added[0].error).toBe('Not there any more.')
  })
})
