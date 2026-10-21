/**
 * dev 前置清理：杀掉占用 3000/3001 端口的孤儿 node 进程。
 *
 * 背景：Windows 上 tsx watch / next dev 被强杀或异常重启时，
 * SIGINT/SIGTERM 处理器不执行，子进程成为孤儿继续占着端口，
 * 导致下次 dev 启动报 EADDRINUSE。
 *
 * 跨平台实现：用 node:net 尝试监听端口判断占用（不依赖 lsof/netstat），
 * 占用时通过进程查询定位 PID 并终止。查不到属主时只警告不强杀。
 */
const { createServer } = require('node:net')
const { execFile } = require('node:child_process')

const PORTS = [3000, 3001]

/** 端口是否被占用（尝试 bind，立即释放） */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(true))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port)
  })
}

/** 查询占用端口的 PID（win32: netstat；其他平台: lsof） */
function findPid(port) {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? { file: 'netstat', args: ['-ano', '-p', 'TCP'] }
        : { file: 'lsof', args: ['-t', '-i', `:${port}`, '-s', 'TCP:LISTEN'] }

    execFile(cmd.file, cmd.args, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      if (process.platform === 'win32') {
        // 行格式: TCP  0.0.0.0:3000  0.0.0.0:0  LISTENING  12345
        for (const line of stdout.split('\n')) {
          const cols = line.trim().split(/\s+/)
          if (
            cols.length >= 5 &&
            cols[0] === 'TCP' &&
            cols[1]?.endsWith(`:${port}`) &&
            cols[3] === 'LISTENING'
          ) {
            const pid = Number.parseInt(cols[4], 10)
            if (Number.isFinite(pid) && pid > 0) return resolve(pid)
          }
        }
        resolve(null)
      } else {
        const pid = Number.parseInt(stdout.trim().split('\n')[0], 10)
        resolve(Number.isFinite(pid) && pid > 0 ? pid : null)
      }
    })
  })
}

/** 进程名（用于日志确认是 node 孤儿，避免误杀） */
function findProcessName(pid) {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? { file: 'powershell', args: ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).ProcessName`] }
        : { file: 'ps', args: ['-p', String(pid), '-o', 'comm='] }
    execFile(cmd.file, cmd.args, { windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

function killPid(pid) {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'win32'
        ? { file: 'taskkill', args: ['/F', '/PID', String(pid)] }
        : { file: 'kill', args: ['-9', String(pid)] }
    execFile(cmd.file, cmd.args, { windowsHide: true }, () => resolve())
  })
}

async function main() {
  let cleaned = 0
  for (const port of PORTS) {
    if (!(await isPortInUse(port))) continue
    const pid = await findPid(port)
    if (pid == null) {
      console.warn(`[predev] 端口 ${port} 被占用但查不到属主进程，请手动处理`)
      continue
    }
    const name = await findProcessName(pid)
    if (name && name.toLowerCase() !== 'node') {
      console.warn(`[predev] 端口 ${port} 被 ${name} (PID ${pid}) 占用，非 node 进程不处理`)
      continue
    }
    console.log(`[predev] 清理占用端口 ${port} 的孤儿进程 PID ${pid}`)
    await killPid(pid)
    cleaned++
  }
  if (cleaned === 0) console.log('[predev] 端口干净，无需清理')
}

main()
