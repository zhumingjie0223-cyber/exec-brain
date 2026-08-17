// 网卡执行脑自测：起真服务、走真 HTTP、打真接口（不 mock）
// 跑法：node --test test/nic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeCaps } from '../nic_runner.mjs';

const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function post(path, body = {}, token = TOKEN) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
}

test.before(async () => {
  child = spawn(process.execPath, [new URL('../nic_runner.mjs', import.meta.url).pathname], {
    env: { ...process.env, TASK_TOKEN: TOKEN, PORT: String(PORT), NIC_RUNNER_NO_LISTEN: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {}
    await sleep(100);
  }
  throw new Error('服务未能启动');
});

test.after(() => { try { child.kill('SIGKILL'); } catch {} });

test('capability 位解码正确（CAP_NET_RAW=13 / CAP_NET_ADMIN=12）', () => {
  assert.deepEqual(decodeCaps('0'), { net_admin: false, net_raw: false });
  assert.deepEqual(decodeCaps('2000'), { net_admin: false, net_raw: true });   // 位13
  assert.deepEqual(decodeCaps('1000'), { net_admin: true, net_raw: false });   // 位12
  assert.deepEqual(decodeCaps('3000'), { net_admin: true, net_raw: true });
  assert.deepEqual(decodeCaps('乱码'), { net_admin: false, net_raw: false });   // 坏输入不炸
});

test('/health 不鉴权可访问，并报网卡级别', async () => {
  const r = await fetch(BASE + '/health');
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.ok(typeof j.网卡级别 === 'string' && j.网卡级别.length > 0);
});

test('无令牌 / 错令牌一律 401', async () => {
  assert.equal((await post('/nic/probe', {}, '')).status, 401);
  assert.equal((await post('/nic/probe', {}, 'wrong-token')).status, 401);
});

test('/nic/probe 如实报告本机能力', async () => {
  const j = await (await post('/nic/probe')).json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.capabilities.net_raw, 'boolean');
  assert.equal(typeof j.capabilities.net_admin, 'boolean');
  assert.equal(typeof j.tun设备, 'boolean');
  assert.ok(j.网卡 && Object.keys(j.网卡).length > 0, '至少应看到 lo 网卡');
});

test('/exec 协议与神枢远程执行脑一致（cmd → ok/code/stdout）', async () => {
  const j = await (await post('/exec', { cmd: 'echo 神枢在线', timeout: 5 })).json();
  assert.equal(j.ok, true);
  assert.equal(j.code, 0);
  assert.match(j.stdout, /神枢在线/);
});

test('/exec 非零退出码如实回报', async () => {
  const j = await (await post('/exec', { cmd: 'exit 3', timeout: 5 })).json();
  assert.equal(j.ok, false);
  assert.equal(j.code, 3);
});

test('/exec 超时被掐断且标记 timeout', async () => {
  const j = await (await post('/exec', { cmd: 'sleep 10', timeout: 1 })).json();
  assert.equal(j.ok, false);
  assert.equal(j.error, 'timeout');
});

test('/nic/ping：装了 ping 就真通，没装就优雅报错（不崩）', async () => {
  const probe = await (await post('/nic/probe')).json();
  const j = await (await post('/nic/ping', { host: '127.0.0.1', count: 2 })).json();
  if (probe.可用工具?.ping) {
    assert.equal(j.ok, true, 'ping 本机应当通：' + JSON.stringify(j).slice(0, 200));
    assert.match(j.output, /127\.0\.0\.1/);
  } else {
    assert.equal(j.ok, false);
    assert.match(j.error, /未安装/);
  }
});

test('/nic/ping 拒绝注入型 host', async () => {
  for (const bad of ['127.0.0.1; rm -rf /', '$(whoami)', '127.0.0.1 -f', '']) {
    const j = await (await post('/nic/ping', { host: bad })).json();
    assert.equal(j.ok, false, `应拒绝: ${bad}`);
  }
});

test('/nic/ping 次数被硬上限截住（不许当压测用）', async () => {
  const j = await (await post('/nic/ping', { host: '127.0.0.1', count: 9999 })).json();
  assert.ok(j.count <= 20, '次数上限应为 20，实际 ' + j.count);
});

test('/nic/capture 过滤表达式挡住 shell 元字符', async () => {
  const j = await (await post('/nic/capture', { filter: 'tcp; rm -rf /' })).json();
  assert.equal(j.ok, false);
  assert.match(j.error, /非法/);
});

test('/nic/capture 时长与包数被硬上限截住', async () => {
  const j = await (await post('/nic/capture', { iface: 'lo', seconds: 9999, packets: 999999 })).json();
  assert.ok(j.seconds === undefined || j.seconds <= 20, '时长上限 20 秒');
  assert.ok(j.上限包数 === undefined || j.上限包数 <= 200, '包数上限 200');
});

test('/nic/ifaces 列出本机网卡', async () => {
  const j = await (await post('/nic/ifaces')).json();
  assert.equal(j.ok, true);
  assert.ok(j.网卡.lo, '应当看到 lo');
});

test('/nic/tun 非法 action 与非法名字被拒', async () => {
  assert.equal((await (await post('/nic/tun', { action: '乱来' })).json()).ok, false);
  assert.equal((await (await post('/nic/tun', { action: 'create', name: 'a b;c' })).json()).ok, false);
});

test('未知路径回 404 并列出可用接口', async () => {
  const r = await post('/不存在');
  assert.equal(r.status, 404);
  const j = await r.json();
  assert.ok(Array.isArray(j.可用接口) && j.可用接口.includes('/exec'));
});
