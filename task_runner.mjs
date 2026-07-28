/**
 * task_runner.mjs — 零依赖 Node.js 单文件任务执行服务
 *
 * 部署说明（Railway）：
 *   1. 新建空服务，将本文件放入仓库根目录。
 *   2. 启动命令：node task_runner.mjs
 *   3. 环境变量：
 *        TASK_TOKEN  必填，POST /exec 的 Bearer 鉴权令牌；未配置时 /exec 返回 503。
 *        PORT        可选，监听端口，默认 8080（Railway 通常自动注入）。
 *   4. 健康检查：GET /health（无需鉴权）。
 *
 * 要求：Node 20+，ESM 语法。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = parseInt(process.env.PORT ?? '8080', 10) || 8080;
const STDOUT_LIMIT = 8000;
const STDERR_LIMIT = 2000;
const TIMEOUT_MAX = 60;
const TIMEOUT_DEFAULT = 30;

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException:`, err);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection:`, reason);
});

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runCommand(cmd, timeoutSec) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let timedOut = false;
    let settled = false;

    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd: '/tmp',
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => {
      if (stdout.length < STDOUT_LIMIT) {
        stdout += d.toString('utf8');
        if (stdout.length > STDOUT_LIMIT) {
          stdout = stdout.slice(0, STDOUT_LIMIT);
          stdoutTrunc = true;
        }
      } else {
        stdoutTrunc = true;
      }
    });

    child.stderr.on('data', (d) => {
      if (stderr.length < STDERR_LIMIT) {
        stderr += d.toString('utf8');
        if (stderr.length > STDERR_LIMIT) {
          stderr = stderr.slice(0, STDERR_LIMIT);
          stderrTrunc = true;
        }
      } else {
        stderrTrunc = true;
      }
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finalStdout = stdoutTrunc ? stdout.slice(0, STDOUT_LIMIT) : stdout;
      const finalStderr = stderrTrunc ? stderr.slice(0, STDERR_LIMIT) : stderr;
      if (timedOut) {
        resolve({ ok: false, code: code ?? null, stdout: finalStdout, stderr: finalStderr, error: 'timeout' });
      } else {
        resolve({ ok: code === 0, code: code ?? null, stdout: finalStdout, stderr: finalStderr, error: null });
      }
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: err.message });
    });

    child.on('close', (code) => finish(code));
  });
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/exec') {
    const token = process.env.TASK_TOKEN;
    if (!token) {
      return sendJson(res, 503, { ok: false, error: 'TASK_TOKEN not configured' });
    }

    const auth = req.headers['authorization'] || '';
    const expected = `Bearer ${token}`;
    if (auth !== expected) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid body' });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
    }

    if (!payload || typeof payload.cmd !== 'string' || payload.cmd.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'missing cmd' });
    }

    let timeout = Number(payload.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = TIMEOUT_DEFAULT;
    if (timeout > TIMEOUT_MAX) timeout = TIMEOUT_MAX;

    const result = await runCommand(payload.cmd, timeout);

    const snippet = payload.cmd.slice(0, 80).replace(/\n/g, ' ');
    console.log(`[${new Date().toISOString()}] ${snippet} -> ${result.code}`);

    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] task_runner listening on 0.0.0.0:${PORT}`);
});
