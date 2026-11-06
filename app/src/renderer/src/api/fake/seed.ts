import type { ContainerRow, ImageLayer, ImageRow, VolumeRow } from '../types'

// Invented sample data for the fake engine. Shapes follow the public Docker
// Engine API; every name and value here is made up.

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString()
const MB = 1_000_000

export const seedImages: ImageRow[] = [
  { id: 'sha256:7f1e2a9c4b3d', tags: ['nginx:1.27'], size: 72 * MB, createdAt: ago(60 * 24 * 21), arch: 'amd64', emulated: false, inUse: true, dangling: false },
  { id: 'sha256:2b8d0c6e1f4a', tags: ['node:22-alpine'], size: 161 * MB, createdAt: ago(60 * 24 * 9), arch: 'amd64', emulated: false, inUse: true, dangling: false },
  { id: 'sha256:9a4c3e7d2b1f', tags: ['postgres:17'], size: 438 * MB, createdAt: ago(60 * 24 * 14), arch: 'amd64', emulated: false, inUse: true, dangling: false },
  { id: 'sha256:5e6f7a8b9c0d', tags: ['redis:7'], size: 117 * MB, createdAt: ago(60 * 24 * 30), arch: 'amd64', emulated: false, inUse: true, dangling: false },
  { id: 'sha256:c0ffee112233', tags: ['shop/migrate:latest'], size: 168 * MB, createdAt: ago(60 * 5), arch: 'amd64', emulated: false, inUse: true, dangling: false },
  { id: 'sha256:b0a7d4e5f6a1', tags: ['shop/worker:dev'], size: 174 * MB, createdAt: ago(60 * 3), arch: 'amd64', emulated: false, inUse: true, dangling: false },
  { id: 'sha256:d00dfeed4455', tags: [], size: 166 * MB, createdAt: ago(60 * 26), arch: 'amd64', emulated: false, inUse: false, dangling: true },
  { id: 'sha256:1b2c3d4e5f60', tags: ['busybox:1.37'], size: 4.3 * MB, createdAt: ago(60 * 24 * 60), arch: 'arm64', emulated: true, inUse: false, dangling: false },
  { id: 'sha256:aa11bb22cc33', tags: ['python:3.13-slim', 'python:3.13'], size: 152 * MB, createdAt: ago(60 * 24 * 40), arch: 'amd64', emulated: false, inUse: false, dangling: false },
  { id: 'sha256:a-very-long', tags: ['registry.example.internal/platform-team/observability/collector-with-a-long-name:2026.11.1'], size: 233 * MB, createdAt: ago(60 * 24 * 2), arch: 'amd64', emulated: false, inUse: true, dangling: false },
]

const label = (project: string, service: string) => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
  'com.docker.compose.project.working_dir': `C:\\code\\${project}`,
})

export const seedContainers: ContainerRow[] = [
  {
    id: 'a1f3c2d4e5b6a7c8', name: 'shop-web-1', image: 'nginx:1.27', imageId: 'sha256:7f1e2a9c4b3d', command: 'nginx -g "daemon off;"',
    state: 'running', createdAt: ago(130), startedAt: ago(128),
    ports: [{ privatePort: 80, publicPort: 8080, hostIp: '0.0.0.0', protocol: 'tcp' }],
    mounts: [{ type: 'bind', source: 'C:\\code\\shop\\nginx.conf', destination: '/etc/nginx/nginx.conf', rw: false }],
    env: ['NGINX_VERSION=1.27.3'], labels: label('shop', 'web'), project: 'shop', service: 'web',
  },
  {
    id: 'b7c2e9f0a1b2c3d4', name: 'shop-api-1', image: 'node:22-alpine', imageId: 'sha256:2b8d0c6e1f4a', command: 'node server.js',
    state: 'running', createdAt: ago(130), startedAt: ago(127),
    ports: [{ privatePort: 3000, publicPort: 3000, hostIp: '0.0.0.0', protocol: 'tcp' }],
    mounts: [
      { type: 'bind', source: 'C:\\code\\shop\\api', destination: '/app', rw: true },
      { type: 'volume', source: 'shop-node-modules', destination: '/app/node_modules', rw: true },
    ],
    env: ['NODE_ENV=development', 'DATABASE_URL=postgres://shop@db:5432/shop', 'PORT=3000'], labels: label('shop', 'api'), project: 'shop', service: 'api',
  },
  {
    id: 'c9d8b7a6f5e4d3c2', name: 'shop-db-1', image: 'postgres:17', imageId: 'sha256:9a4c3e7d2b1f', command: 'docker-entrypoint.sh postgres',
    state: 'running', createdAt: ago(130), startedAt: ago(129),
    ports: [{ privatePort: 5432, publicPort: 5432, hostIp: '127.0.0.1', protocol: 'tcp' }],
    mounts: [{ type: 'volume', source: 'shop-data', destination: '/var/lib/postgresql/data', rw: true }],
    env: ['POSTGRES_USER=shop', 'POSTGRES_DB=shop', 'PGDATA=/var/lib/postgresql/data'], labels: label('shop', 'db'), project: 'shop', service: 'db',
  },
  {
    id: 'e0f1a2b3c4d5e6f7', name: 'shop-worker-1', image: 'shop/worker:dev', imageId: 'sha256:b0a7d4e5f6a1', command: 'node worker.js',
    state: 'restarting', exitCode: 1, createdAt: ago(130), startedAt: ago(0.2),
    // Exposed but not published, like a Compose service reachable only on the project network.
    ports: [
      { privatePort: 8080, protocol: 'tcp' },
      { privatePort: 9090, protocol: 'tcp' },
    ],
    mounts: [], env: ['QUEUE_URL=redis://cache:6379'], labels: label('shop', 'worker'), project: 'shop', service: 'worker',
  },
  {
    id: 'd4e5f6a7b8c9d0e1', name: 'cache', image: 'redis:7', imageId: 'sha256:5e6f7a8b9c0d', command: 'redis-server --appendonly yes',
    state: 'paused', createdAt: ago(60 * 24 * 3), startedAt: ago(60 * 24 * 3),
    ports: [{ privatePort: 6379, publicPort: 6379, hostIp: '0.0.0.0', protocol: 'tcp' }],
    mounts: [{ type: 'volume', source: 'cache-data', destination: '/data', rw: true }],
    env: [], labels: {},
  },
  {
    id: 'e2a7b8c9d0e1f2a3', name: 'migrate-once', image: 'shop/migrate:latest', imageId: 'sha256:c0ffee112233', command: 'npm run migrate',
    state: 'exited', exitCode: 1, createdAt: ago(60 * 5), startedAt: ago(60 * 5),
    ports: [], mounts: [], env: ['DATABASE_URL=postgres://shop@db:5432/shop'], labels: {},
  },
  {
    id: 'f00dbabe12345678', name: 'telemetry-collector-for-the-platform-observability-stack-01', image: 'registry.example.internal/platform-team/observability/collector-with-a-long-name:2026.11.1', imageId: 'sha256:a-very-long', command: '/collector --config /etc/collector.yaml',
    state: 'running', createdAt: ago(60 * 30), startedAt: ago(60 * 30),
    ports: [
      { privatePort: 4317, publicPort: 4317, hostIp: '0.0.0.0', protocol: 'tcp' },
      { privatePort: 4318, publicPort: 4318, hostIp: '0.0.0.0', protocol: 'tcp' },
      { privatePort: 8125, publicPort: 8125, hostIp: '0.0.0.0', protocol: 'udp' },
    ],
    mounts: [], env: ['OTEL_LOG_LEVEL=info'], labels: {},
  },
]

export const seedVolumes: VolumeRow[] = [
  { name: 'shop-data', driver: 'local', createdAt: ago(60 * 24 * 14), size: 212 * MB, usedBy: [] },
  { name: 'shop-node-modules', driver: 'local', createdAt: ago(60 * 24 * 9), size: 388 * MB, usedBy: [] },
  { name: 'cache-data', driver: 'local', createdAt: ago(60 * 24 * 30), size: 3.1 * MB, usedBy: [] },
  { name: 'old-scratch', driver: 'local', createdAt: ago(60 * 24 * 120), size: 61 * MB, usedBy: [] },
]

export function seedLayers(image: ImageRow): ImageLayer[] {
  const base = image.tags[0]?.split(':')[0] ?? 'image'
  const steps = [
    ['ADD rootfs.tar.xz / # buildkit', 0.45],
    ['RUN apt-get update && apt-get install -y ca-certificates # buildkit', 0.2],
    [`ENV ${base.toUpperCase().replace(/[^A-Z]/g, '_')}_HOME=/opt/${base}`, 0],
    ['COPY entrypoint.sh /usr/local/bin/ # buildkit', 0.01],
    [`RUN /bin/sh -c set -eux; install-${base}.sh # buildkit`, 0.34],
    ['EXPOSE map[80/tcp:{}]', 0],
    ['CMD ["/usr/local/bin/entrypoint.sh"]', 0],
  ] as const
  return steps.map(([createdBy, share], i) => ({
    id: i === 0 ? image.id : '<missing>',
    createdBy,
    size: Math.round(image.size * share),
    createdAt: image.createdAt,
  }))
}

// Lines each service writes while running, picked at random by the fake.
export const chatter: Record<string, { stream: 'stdout' | 'stderr'; text: string }[]> = {
  nginx: [
    { stream: 'stdout', text: '172.18.0.1 - - "GET / HTTP/1.1" 200 615' },
    { stream: 'stdout', text: '172.18.0.1 - - "GET /assets/app.js HTTP/1.1" 200 48211' },
    { stream: 'stdout', text: '172.18.0.1 - - "GET /favicon.ico HTTP/1.1" 404 153' },
  ],
  node: [
    { stream: 'stdout', text: 'GET /api/orders 200 41ms' },
    { stream: 'stdout', text: 'GET /health 200 2ms' },
    { stream: 'stdout', text: 'POST /api/cart 201 18ms' },
    { stream: 'stderr', text: 'warn: slow query (812ms) select * from orders where status = $1' },
  ],
  postgres: [
    { stream: 'stdout', text: 'LOG:  checkpoint starting: time' },
    { stream: 'stdout', text: 'LOG:  checkpoint complete: wrote 12 buffers (0.1%)' },
  ],
  worker: [
    { stream: 'stdout', text: 'worker booting, connecting to redis://cache:6379' },
    { stream: 'stderr', text: 'Error: connect ETIMEDOUT cache:6379 (is the cache paused?)' },
    { stream: 'stderr', text: 'worker exited with code 1, restarting in 2s' },
  ],
  collector: [
    { stream: 'stdout', text: 'exporter: sent 128 spans, 0 dropped' },
    { stream: 'stdout', text: 'receiver: otlp/grpc accepted 64 metrics' },
  ],
  redis: [{ stream: 'stdout', text: 'Background saving started by pid 21' }],
  default: [{ stream: 'stdout', text: 'tick' }],
}

export const bootLines: Record<string, string[]> = {
  nginx: ['/docker-entrypoint.sh: Configuration complete; ready for start up', 'start worker processes'],
  node: ['> shop-api@0.4.0 start', 'listening on 0.0.0.0:3000', 'connected to database shop on db:5432'],
  postgres: ['PostgreSQL init process complete; ready for start up.', 'LOG:  database system is ready to accept connections'],
  worker: ['worker booting, connecting to redis://cache:6379'],
  redis: ['Server initialized', 'Ready to accept connections tcp'],
  migrate: ['> shop-migrate@0.4.0 migrate', 'applying 0007_add_order_index.sql', 'error: relation "orders" does not exist', 'migration failed, exiting with code 1'],
  collector: ['collector starting, config /etc/collector.yaml', 'receivers ready: otlp/grpc :4317, otlp/http :4318, statsd :8125'],
  default: ['started'],
}

export function flavour(image: string): string {
  if (image.startsWith('nginx')) return 'nginx'
  if (image.startsWith('node')) return 'node'
  if (image.startsWith('postgres')) return 'postgres'
  if (image.startsWith('redis')) return 'redis'
  if (image.includes('worker')) return 'worker'
  if (image.includes('migrate')) return 'migrate'
  if (image.includes('collector')) return 'collector'
  return 'default'
}
