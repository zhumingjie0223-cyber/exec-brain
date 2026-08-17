/**
 * nic_runner.mjs — 神枢「网卡执行脑」（零依赖 Node 20+ 单文件服务）
 *
 * 为什么有这东西：
 *   神枢主体跑在 Cloudflare Workers + Containers 上，那套环境只给「出站请求」能力，
 *   拿不到真网卡（没有 CAP_NET_RAW / CAP_NET_ADMIN、没有 /dev/net/tun），
 *   所以抓包、原始 ICMP、建虚拟网卡这类事在云端一律做不了。
 *   本服务装在一台真 Linux 机器上，把那台机器的真网卡借给神枢用；
 *   协议与神枢内建的「远程执行脑」完全一致（POST /exec + Bearer 令牌），
 *   神枢侧只需配 NEXUS_EXEC_URL / NEXUS_EXEC_TOKEN，无需改一行代码。
 *
 * 安全：
 *   - 全部接口（/health 除外）强制 Bearer 鉴权；未配 TASK_TOKEN 一律 503，绝不裸奔。
 *   - 神枢侧的危险命令二次确认闸在派发前生效，本服务不绕过、不削弱。
 *   - 网卡类操作只针对本机自己的网络栈，且逐项设硬上限（抓包时长/包数、ping 次数、跳数）。
 *
 * 环境变量：
 *   TASK_TOKEN  必填，Bearer 鉴权令牌；未配置时除 /health 外全部 503。
 *   PORT        可选，默认 8080。
 *   NIC_IFACE   可选，抓包默认网卡名；不配则自动选默认路由所在网卡。
 */

import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PORT = parseInt(process.env.PORT ?? '8080', 10) || 8080;
const STDOUT_LIMIT = 8000;
const STDERR_LIMIT = 2000;
const TIMEOUT_MAX = 60;
const TIMEOUT_DEFAULT = 30;

// 网卡类操作硬上限（防跑飞：抓包不许无限抓、ping 不许当压测用）
const CAP_MAX_SECONDS = 20;
const CAP_MAX_PACKETS = 200;
const PING_MAX_COUNT = 20;
const TRACE_MAX_HOPS = 20;

// Linux capability 位：CAP_NET_ADMIN=12（建网卡/改路由）、CAP_NET_RAW=13（原始套接字/抓包）
const CAP_NET_ADMIN_BIT = 12n;
const CAP_NET_RAW_BIT = 13n;

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

// 统一执行：不过 shell，参数数组直传，避免命令拼接注入
function runArgv(file, args, timeoutSec) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let child;
    try {
      child = spawn(file, args, { cwd: '/tmp', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: err.message });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
      // 给 tcpdump 之类留一点收尾时间落盘，再补刀
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
    }, timeoutSec * 1000);

    child.stdout.on('data', (d) => { if (stdout.length < STDOUT_LIMIT) stdout = (stdout + d.toString('utf8')).slice(0, STDOUT_LIMIT); });
    child.stderr.on('data', (d) => { if (stderr.length < STDERR_LIMIT) stderr = (stderr + d.toString('utf8')).slice(0, STDERR_LIMIT); });

    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      // 抓包类命令被计时器正常收尾时，超时不算失败（拿到包就算成功）
      resolve({ ok: code === 0, code: code ?? null, stdout, stderr, error: timedOut ? 'timeout' : null, timedOut });
    });
  });
}

// 走 shell 的通用执行（/exec 主链路，神枢的危险闸已在派发前把关）
function runCommand(cmd, timeoutSec) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const child = spawn('/bin/sh', ['-c', cmd], { cwd: '/tmp', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { if (stdout.length < STDOUT_LIMIT) stdout = (stdout + d.toString('utf8')).slice(0, STDOUT_LIMIT); });
    child.stderr.on('data', (d) => { if (stderr.length < STDERR_LIMIT) stderr = (stderr + d.toString('utf8')).slice(0, STDERR_LIMIT); });
    child.on('error', (err) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code: code ?? null, stdout, stderr, error: timedOut ? 'timeout' : null, exitCode: code ?? null });
    });
  });
}

// ═══════════════════════ 网卡能力自检 ═══════════════════════
// 如实报告这台机器到底有没有真网卡能力，不猜不吹：直接读内核给本进程的 capability 位。
export function decodeCaps(capEffHex) {
  let bits;
  try { bits = BigInt('0x' + String(capEffHex || '0').trim()); } catch { return { net_admin: false, net_raw: false }; }
  return {
    net_admin: ((bits >> CAP_NET_ADMIN_BIT) & 1n) === 1n,
    net_raw: ((bits >> CAP_NET_RAW_BIT) & 1n) === 1n,
  };
}

async function probeNic() {
  let caps = { net_admin: false, net_raw: false };
  try {
    const status = await readFile('/proc/self/status', 'utf8');
    const m = status.match(/CapEff:\s*([0-9a-fA-F]+)/);
    if (m) caps = decodeCaps(m[1]);
  } catch {}

  let tun = false;
  try { await access('/dev/net/tun'); tun = true; } catch {}

  const ifaces = {};
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
    ifaces[name] = (addrs || []).map((a) => ({ family: a.family, address: a.address, internal: a.internal, mac: a.mac }));
  }

  const tools = {};
  for (const t of ['tcpdump', 'ip', 'ping', 'traceroute', 'ss']) {
    const r = await runArgv('/bin/sh', ['-c', `command -v ${t}`], 5);
    tools[t] = r.ok && r.stdout.trim().length > 0;
  }

  const level = caps.net_raw && caps.net_admin && tun ? '完整真网卡（可抓包 / 可建虚拟网卡 / 可原始套接字）'
    : caps.net_raw ? '半真网卡（可抓包与原始套接字，但不能建虚拟网卡或改路由）'
    : '仅普通出站（连不上真网卡层，与 Cloudflare 容器同级）';

  return {
    级别: level,
    capabilities: caps,
    tun设备: tun,
    可用工具: tools,
    网卡: ifaces,
    内核: `${os.type()} ${os.release()}`,
    主机: os.hostname(),
  };
}

// ═══════════════════════ 网卡能力实现 ═══════════════════════
// 一律只操作本机自己的网络栈；每项都有硬上限，防跑飞。

function badTarget(host) {
  // 只允许主机名/IP 字面量，挡住任何试图带参数或拼命令的输入
  return typeof host !== 'string' || !/^[A-Za-z0-9._:-]{1,253}$/.test(host);
}
function badIface(name) {
  return typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(name);
}

async function defaultIface() {
  if (process.env.NIC_IFACE && !badIface(process.env.NIC_IFACE)) return process.env.NIC_IFACE;
  const r = await runArgv('/bin/sh', ['-c', "ip route show default 2>/dev/null | awk '{print $5; exit}'"], 5);
  const name = (r.stdout || '').trim();
  return badIface(name) ? 'any' : name;
}

async function nicPing(p) {
  const host = p.host;
  if (badTarget(host)) return { ok: false, error: 'host 非法（只接受主机名或 IP）' };
  const count = Math.min(PING_MAX_COUNT, Math.max(1, parseInt(p.count, 10) || 4));
  const r = await runArgv('ping', ['-c', String(count), '-w', '15', host], 20);
  if (/ENOENT/.test(String(r.error)) || /not found/i.test(r.stderr || '')) {
    return { ok: false, host, count, error: 'ping 未安装（apt install iputils-ping）' };
  }
  return { ok: r.ok, host, count, output: r.stdout || r.stderr, error: r.error };
}

async function nicTrace(p) {
  const host = p.host;
  if (badTarget(host)) return { ok: false, error: 'host 非法（只接受主机名或 IP）' };
  const hops = Math.min(TRACE_MAX_HOPS, Math.max(1, parseInt(p.hops, 10) || 15));
  const r = await runArgv('traceroute', ['-m', String(hops), '-w', '2', host], 45);
  if (r.error === 'ENOENT' || /not found/i.test(r.stderr || '')) return { ok: false, error: 'traceroute 未安装（apt install traceroute）' };
  return { ok: r.ok, host, hops, output: r.stdout || r.stderr, error: r.error };
}

// 抓包：只抓本机自己网卡上的流量，时长与包数双上限，输出纯文本包摘要（不落磁盘）
async function nicCapture(p) {
  const iface = p.iface ? String(p.iface) : await defaultIface();
  if (badIface(iface)) return { ok: false, error: 'iface 非法' };
  const seconds = Math.min(CAP_MAX_SECONDS, Math.max(1, parseInt(p.seconds, 10) || 5));
  const packets = Math.min(CAP_MAX_PACKETS, Math.max(1, parseInt(p.packets, 10) || 50));
  // 过滤表达式做白名单校验：只放行 BPF 常见字面量，挡住 shell 元字符
  const filter = typeof p.filter === 'string' ? p.filter.trim() : '';
  if (filter && !/^[A-Za-z0-9 .:_()\[\]/-]{0,120}$/.test(filter)) {
    return { ok: false, error: 'filter 含非法字符（只接受 BPF 表达式字面量）' };
  }
  const args = ['-i', iface, '-n', '-c', String(packets), '-tttt', '-l'];
  if (filter) args.push(...filter.split(/\s+/));
  const r = await runArgv('tcpdump', args, seconds + 2);
  if (/not found|ENOENT/i.test(String(r.error) + r.stderr)) {
    return { ok: false, error: 'tcpdump 未安装（apt install tcpdump），或本机无 CAP_NET_RAW' };
  }
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  return { ok: lines.length > 0, iface, seconds, 上限包数: packets, 抓到: lines.length, 包: lines.slice(0, 200), stderr: r.stderr?.slice(0, 400) };
}

async function nicIfaces() {
  const r = await runArgv('ip', ['-o', 'addr'], 10);
  return { ok: true, 网卡: os.networkInterfaces(), ip_addr: (r.stdout || r.stderr || '').split('\n').filter(Boolean) };
}

// 虚拟网卡（TUN）：建/删/看。需要 CAP_NET_ADMIN，没有就如实报错，不假装成功。
async function nicTun(p) {
  const action = String(p.action || 'list');
  const name = p.name ? String(p.name) : 'nexus0';
  if (badIface(name)) return { ok: false, error: 'name 非法' };
  if (action === 'list') {
    const r = await runArgv('/bin/sh', ['-c', 'ip -o link show type tun 2>/dev/null'], 10);
    return { ok: true, 虚拟网卡: (r.stdout || '').split('\n').filter(Boolean) };
  }
  if (action === 'create') {
    const addr = p.addr ? String(p.addr) : '10.66.0.1/24';
    if (!/^[0-9.]{7,18}\/\d{1,2}$/.test(addr)) return { ok: false, error: 'addr 非法（形如 10.66.0.1/24）' };
    const a = await runArgv('ip', ['tuntap', 'add', 'dev', name, 'mode', 'tun'], 10);
    if (!a.ok) return { ok: false, error: '建虚拟网卡失败（多半缺 CAP_NET_ADMIN）', 详情: a.stderr || a.error };
    await runArgv('ip', ['addr', 'add', addr, 'dev', name], 10);
    const up = await runArgv('ip', ['link', 'set', name, 'up'], 10);
    return { ok: up.ok, name, addr, 说明: '虚拟网卡已建立并启用' };
  }
  if (action === 'delete') {
    const r = await runArgv('ip', ['tuntap', 'del', 'dev', name, 'mode', 'tun'], 10);
    return { ok: r.ok, name, error: r.ok ? null : (r.stderr || r.error) };
  }
  return { ok: false, error: 'action 仅支持 list / create / delete' };
}

// ═══════════════════════ 路由 ═══════════════════════
const NIC_ROUTES = {
  '/nic/probe': async () => ({ ok: true, ...(await probeNic()) }),
  '/nic/ifaces': nicIfaces,
  '/nic/ping': nicPing,
  '/nic/trace': nicTrace,
  '/nic/capture': nicCapture,
  '/nic/tun': nicTun,
};

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health') {
    const nic = await probeNic().catch(() => null);
    return sendJson(res, 200, { ok: true, 服务: 'nexus-nic-brain', 网卡级别: nic?.级别 ?? '未知' });
  }

  const token = process.env.TASK_TOKEN;
  if (!token) return sendJson(res, 503, { ok: false, error: 'TASK_TOKEN not configured' });
  if ((req.headers['authorization'] || '') !== `Bearer ${token}`) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (method !== 'POST') return sendJson(res, 404, { ok: false, error: 'not found' });

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
  }
  if (!payload || typeof payload !== 'object') return sendJson(res, 400, { ok: false, error: 'invalid body' });

  // 主链路：与神枢内建远程执行脑协议完全一致
  if (url === '/exec') {
    const cmd = typeof payload.cmd === 'string' ? payload.cmd : payload.command;
    if (typeof cmd !== 'string' || !cmd.length) return sendJson(res, 400, { ok: false, error: 'missing cmd' });
    let timeout = Number(payload.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) timeout = TIMEOUT_DEFAULT;
    if (timeout > TIMEOUT_MAX) timeout = TIMEOUT_MAX;
    const result = await runCommand(cmd, timeout);
    console.log(`[${new Date().toISOString()}] exec: ${cmd.slice(0, 80).replace(/\n/g, ' ')} -> ${result.code}`);
    return sendJson(res, 200, result);
  }

  const handler = NIC_ROUTES[url];
  if (handler) {
    const result = await handler(payload).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));
    console.log(`[${new Date().toISOString()}] ${url} -> ok=${result.ok}`);
    return sendJson(res, 200, result);
  }

  return sendJson(res, 404, { ok: false, error: 'not found', 可用接口: ['/exec', ...Object.keys(NIC_ROUTES)] });
});

// 只有被直接运行（node nic_runner.mjs）时才监听；被 import（如测试取用 decodeCaps）时不起服务，
// 否则测试进程会被自己起的服务挂住不退出。
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  server.listen(PORT, '0.0.0.0', () => {
    probeNic().then((n) => {
      console.log(`[${new Date().toISOString()}] nic_runner 监听 0.0.0.0:${PORT}`);
      console.log(`[${new Date().toISOString()}] 网卡能力：${n.级别}`);
      if (!process.env.TASK_TOKEN) console.warn('⚠ 未配 TASK_TOKEN：除 /health 外所有接口返回 503。');
    });
  });
}

export { probeNic, server };
