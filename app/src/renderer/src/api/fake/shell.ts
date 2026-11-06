import type { ContainerRow, ExecSession } from '../types'

// A tiny line-editing shell for the fake engine, so the terminal (S06) can
// be built and tested without a real container. Understands a handful of
// commands; anything else reports "not found" like sh would.

export function createFakeShell(c: ContainerRow, shell: string, onData: (d: string) => void, onExit: (code: number) => void): ExecSession {
  let line = ''
  let cwd = '/'
  let closed = false
  const host = c.id.slice(0, 12)
  const prompt = () => onData(`\x1b[32m${host}\x1b[0m:\x1b[34m${cwd}\x1b[0m# `)
  const fs: Record<string, string[]> = {
    '/': ['app', 'bin', 'etc', 'home', 'proc', 'root', 'tmp', 'usr', 'var'],
    '/app': ['package.json', 'server.js', 'node_modules', 'README.md'],
    '/etc': ['hostname', 'hosts', 'os-release', 'passwd'],
  }
  const files: Record<string, string> = {
    '/etc/hostname': host,
    '/etc/os-release': 'NAME="Alpine Linux"\r\nID=alpine\r\nVERSION_ID=3.22.1',
    '/app/package.json': '{\r\n  "name": "shop-api",\r\n  "version": "0.4.0"\r\n}',
  }

  const run = (cmdline: string) => {
    const [cmd, ...args] = cmdline.trim().split(/\s+/)
    const resolve = (p?: string) => (!p ? cwd : p.startsWith('/') ? p : (cwd === '/' ? '' : cwd) + '/' + p)
    switch (cmd) {
      case undefined:
      case '':
        return
      case 'ls': {
        const d = fs[resolve(args[0])]
        onData(d ? d.join('  ') + '\r\n' : `ls: ${args[0]}: No such file or directory\r\n`)
        return
      }
      case 'pwd':
        onData(cwd + '\r\n')
        return
      case 'cd': {
        const p = resolve(args[0] ?? '/')
        if (fs[p]) cwd = p
        else onData(`sh: cd: can't cd to ${args[0]}: No such file or directory\r\n`)
        return
      }
      case 'cat': {
        const f = files[resolve(args[0])]
        onData(f !== undefined ? f + '\r\n' : `cat: can't open '${args[0] ?? ''}': No such file or directory\r\n`)
        return
      }
      case 'echo':
        onData(args.join(' ') + '\r\n')
        return
      case 'env':
        onData([...c.env, `HOSTNAME=${host}`, 'HOME=/root'].join('\r\n') + '\r\n')
        return
      case 'hostname':
        onData(host + '\r\n')
        return
      case 'whoami':
        onData('root\r\n')
        return
      case 'clear':
        onData('\x1b[2J\x1b[H')
        return
      case 'exit':
        closed = true
        onData('exit\r\n')
        onExit(0)
        return
      default:
        onData(`${shell.split('/').pop()}: ${cmd}: not found\r\n`)
    }
  }

  setTimeout(() => {
    onData(`Connected to ${c.name} with ${shell}. Type "exit" to leave.\r\n`)
    prompt()
  }, 50)

  return {
    write(data) {
      if (closed) return
      for (const ch of data) {
        if (ch === '\r') {
          onData('\r\n')
          run(line)
          line = ''
          if (!closed) prompt()
        } else if (ch === '\x7f') {
          if (line) {
            line = line.slice(0, -1)
            onData('\b \b')
          }
        } else if (ch === '\x03') {
          onData('^C\r\n')
          line = ''
          prompt()
        } else if (ch >= ' ') {
          line += ch
          onData(ch)
        }
      }
    },
    resize() {},
    close() {
      closed = true
    },
  }
}
