import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const projectRoot = resolve(import.meta.dirname, '..')
const pidFile = resolve(projectRoot, '.tietiezhi-dev.pid')
const electronVite = resolve(projectRoot, 'node_modules/electron-vite/bin/electron-vite.js')

async function readPreviousPid() {
  try {
    const pid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function waitForExit(pid) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
}

async function stopPreviousDevServer() {
  const pid = await readPreviousPid()
  if (pid === undefined) return

  try {
    if (process.platform === 'win32') {
      await new Promise((resolveTaskkill) => {
        const taskkill = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
        taskkill.once('exit', resolveTaskkill)
        taskkill.once('error', resolveTaskkill)
      })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
    await waitForExit(pid)
  } catch {
    // The saved process is already gone or cannot be signalled.
  }
}

async function stopUnmanagedDevServers() {
  if (process.platform === 'win32') return

  const processList = await new Promise((resolveProcessList) => {
    const ps = spawn('ps', ['-axo', 'pid=,pgid=,command='])
    let output = ''
    ps.stdout.on('data', (chunk) => {
      output += chunk
    })
    ps.once('error', () => resolveProcessList(''))
    ps.once('exit', () => resolveProcessList(output))
  })

  for (const line of processList.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (match === null) continue

    const [, pid, processGroupId, command] = match
    if (!command.includes(projectRoot) || !command.includes('electron-vite') || !command.includes(' dev')) continue

    try {
      process.kill(-Number(processGroupId), 'SIGTERM')
    } catch {
      try {
        process.kill(Number(pid), 'SIGTERM')
      } catch {
        // The process exited while the list was being inspected.
      }
    }
  }
}

await stopPreviousDevServer()
await stopUnmanagedDevServers()

const child = spawn(process.execPath, [electronVite, 'dev'], {
  cwd: projectRoot,
  detached: process.platform !== 'win32',
  stdio: 'inherit'
})

await writeFile(pidFile, `${child.pid}\n`)

let stopping = false
async function cleanup() {
  if (stopping) return
  stopping = true
  try {
    if (child.pid !== undefined) {
      if (process.platform === 'win32') {
        child.kill('SIGTERM')
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    }
  } catch {
    // The child process has already exited.
  }
}

process.once('SIGINT', cleanup)
process.once('SIGTERM', cleanup)

child.once('exit', async () => {
  const savedPid = await readPreviousPid()
  if (savedPid === child.pid) await rm(pidFile, { force: true })
  process.exitCode = 0
})
