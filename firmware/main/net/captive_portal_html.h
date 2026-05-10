#pragma once

// 嵌入式 HTML:用户连了 SoftAP "Slate-XXXX" 后浏览器看到这个页面。
// 没有外网,字体只能用 system monospace fallback,配色样式纯 CSS 自定义。
// 占位 {{SERVER_URL}} 和 {{AP_SSID}} 在运行时由 captive_portal.cc 替换。

namespace slate {

constexpr const char* kCaptivePortalHtml = R"HTML(<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SLATE 配网</title>
<style>
:root {
  --ink: #0F0F0E;
  --paper: #F5F2EC;
  --rust: #7C2D12;
  --ash: #A6A09A;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 540px; margin: 0 auto; padding: 24px 16px 64px; }
.head { padding: 12px 0 8px; border-bottom: 1px solid var(--ink); }
.brand { font-size: 22px; font-weight: 700; letter-spacing: 0.05em; }
.sub { font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ash); margin-top: 4px; }
.tick {
  height: 8px;
  background-image: repeating-linear-gradient(to right, var(--ink) 0, var(--ink) 1px, transparent 1px, transparent 8px);
  margin-top: 8px;
}
section {
  margin-top: 24px;
  border: 1px solid var(--ink);
  padding: 16px;
}
section h2 {
  margin: 0 0 12px;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  font-weight: 700;
}
section h2::before { content: "━━ "; }
section h2::after  { content: " ━━"; }
label {
  display: block;
  margin-top: 12px;
}
label .lbl {
  display: block;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ash);
  margin-bottom: 4px;
}
input[type=text],
input[type=password],
input[type=url],
select {
  width: 100%;
  padding: 10px 12px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  border: 1px solid var(--ink);
  border-radius: 2px;
  outline: none;
}
input:focus, select:focus { border-width: 2px; padding: 9px 11px; }
details { margin-top: 16px; }
summary {
  cursor: pointer;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ash);
  user-select: none;
}
summary:hover { color: var(--ink); }
button.primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  background: var(--ink);
  color: var(--paper);
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border: 1px solid var(--ink);
  border-radius: 2px;
  cursor: pointer;
  width: 100%;
  margin-top: 24px;
}
button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
button.primary:hover:not(:disabled) { background: var(--paper); color: var(--ink); }
.row { display: flex; gap: 8px; align-items: stretch; }
.row > * { flex: 1; }
.row > .grow0 { flex: 0; }
.btn-secondary {
  padding: 10px 12px;
  background: var(--paper);
  color: var(--ink);
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  border: 1px solid var(--ink);
  border-radius: 2px;
  cursor: pointer;
}
.btn-secondary:hover { background: var(--ink); color: var(--paper); }
.status {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid;
  font-size: 12px;
}
.status.info { border-color: var(--ash); color: var(--ash); }
.status.ok { border-color: var(--ink); color: var(--ink); }
.status.err { border-color: var(--rust); color: var(--rust); }
.foot {
  margin-top: 32px;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ash);
  text-align: center;
}
@keyframes spin {
  0%   { content: "[ / ]"; }
  25%  { content: "[ - ]"; }
  50%  { content: "[ \\ ]"; }
  75%  { content: "[ | ]"; }
  100% { content: "[ / ]"; }
}
.spin::before { content: "[ / ]"; animation: spin 480ms steps(4) infinite; }
ul.networks { list-style: none; margin: 8px 0 0; padding: 0; max-height: 220px; overflow-y: auto; border: 1px solid var(--ash); }
ul.networks li {
  padding: 8px 12px;
  border-bottom: 1px solid var(--ash);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
ul.networks li:last-child { border-bottom: 0; }
ul.networks li:hover { background: var(--ink); color: var(--paper); }
ul.networks li.sel { background: var(--ink); color: var(--paper); }
.bars { font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<div class="wrap">
  <header class="head">
    <div class="brand">[SLATE]</div>
    <div class="sub">━━ DEVICE CONFIGURATION · {{AP_SSID}} ━━</div>
    <div class="tick"></div>
  </header>

  <form id="f">
    <section>
      <h2>① WIFI</h2>
      <ul id="nets" class="networks"><li><span>扫描中...</span><span class="spin"></span></li></ul>
      <label>
        <span class="lbl">SSID</span>
        <input id="ssid" name="ssid" type="text" required maxlength="32" placeholder="点上方列表自动填入,或手动输入">
      </label>
      <label>
        <span class="lbl">PASSWORD</span>
        <input id="password" name="password" type="password" maxlength="64" placeholder="开放网络留空即可">
      </label>
    </section>

    <section>
      <h2>② SERVER</h2>
      <label>
        <span class="lbl">URL</span>
        <input id="server_url" name="server_url" type="url" required
               value="{{SERVER_URL}}"
               placeholder="https://slate.your-domain.com 或 http://192.168.1.2:3001">
      </label>
      <p style="margin: 6px 0 0; font-size: 10px; letter-spacing: 0.05em; color: var(--ash);">
        填运行 slate 后端的地址。本地局域网调试用 http://&lt;LAN-IP&gt;:3001 即可。
      </p>
    </section>

    <button type="submit" class="primary" id="btn">配网并连接 [⏎]</button>
  </form>

  <div id="status"></div>

  <p class="foot">SLATE / v0.1.0 · 192.168.4.1</p>
</div>

<script>
const $ = (id) => document.getElementById(id);
const status = $('status');
const setStatus = (msg, kind) => {
  status.className = 'status ' + (kind || 'info');
  status.textContent = msg;
};
const rssiBars = (r) => {
  if (r >= -55) return '████';
  if (r >= -65) return '███▒';
  if (r >= -75) return '██▒▒';
  if (r >= -85) return '█▒▒▒';
  return '▒▒▒▒';
};
let scanning = false;
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const r = await fetch('/scan', { cache: 'no-store' });
    if (!r.ok) throw new Error('scan failed');
    const list = await r.json();
    const ul = $('nets');
    ul.innerHTML = '';
    if (!list.length) {
      ul.innerHTML = '<li><span>未扫到网络</span><span></span></li>';
      return;
    }
    for (const ap of list) {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = ap.ssid + (ap.authmode === 0 ? ' [OPEN]' : '');
      const right = document.createElement('span');
      right.className = 'bars';
      right.textContent = rssiBars(ap.rssi) + ' ' + ap.rssi;
      li.appendChild(left);
      li.appendChild(right);
      li.addEventListener('click', () => {
        $('ssid').value = ap.ssid;
        for (const n of ul.querySelectorAll('li')) n.classList.remove('sel');
        li.classList.add('sel');
      });
      ul.appendChild(li);
    }
  } catch (e) {
    $('nets').innerHTML = '<li><span>扫描失败 · 重试中</span><span></span></li>';
  } finally {
    scanning = false;
  }
}
scan();
const scanTimer = setInterval(scan, 5000);

function showSuccess(ssid) {
  // 隐藏 form 与扫描区,显示大块 success 提示 + 倒计时
  document.querySelector('form').style.display = 'none';
  status.style.display = 'none';
  const wrap = document.querySelector('.wrap');
  const box = document.createElement('section');
  box.style.borderColor = 'var(--ink)';
  box.style.borderWidth = '2px';
  box.style.padding = '24px';
  box.style.marginTop = '24px';
  box.innerHTML =
    '<h2 style="font-size:20px;letter-spacing:0;text-transform:none;margin:0 0 16px;">' +
    '✓ 配网成功</h2>' +
    '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">' +
    '设备将连接到 <strong>' + ssid + '</strong> 并自动重启。</p>' +
    '<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">' +
    '设备屏幕也会显示"配网成功"和重启倒计时。</p>' +
    '<p style="margin:0;font-size:12px;color:var(--ash);">' +
    '本页将在 <span id="cd">5</span> 秒后失联,可直接关闭。</p>';
  wrap.appendChild(box);
  let n = 5;
  const t = setInterval(() => {
    n--;
    const cd = document.getElementById('cd');
    if (cd) cd.textContent = n;
    if (n <= 0) clearInterval(t);
  }, 1000);
}

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    ssid: $('ssid').value.trim(),
    password: $('password').value,
    server_url: $('server_url').value.trim(),
  };
  if (!body.ssid) { setStatus('SSID 不能空', 'err'); return; }
  if (!body.server_url) { setStatus('服务端 URL 不能空', 'err'); return; }
  $('btn').disabled = true;
  setStatus('正在试连 ' + body.ssid + ' …(最多 10 秒)', 'info');
  try {
    const r = await fetch('/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok || !data.success) {
      setStatus('[ERROR] ' + (data.error || ('HTTP ' + r.status)) + ' · 请改密码后重试', 'err');
      $('btn').disabled = false;
      return;
    }
    clearInterval(scanTimer);
    showSuccess(body.ssid);
  } catch (err) {
    setStatus('[ERROR] 网络错误: ' + (err && err.message || '未知') + ' · 请重试', 'err');
    $('btn').disabled = false;
  }
});
</script>
</body>
</html>
)HTML";

}  // namespace slate
