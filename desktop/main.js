// PageOn 桌面壳（v3.9 打包）
// 职责：挑空闲端口 → 起 reader-server sidecar → 轮询健康检查 → 开窗口指向它；
// 退出时负责杀掉 sidecar，不留孤儿进程。界面本体仍是 FastAPI 服务的 frontend/dist。
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const fs = require("fs");

let serverProc = null;
let mainWindow = null;
let quitting = false;
let serverPort = 0;

// ---------- sidecar ----------

function serverBinPath() {
  // 打包态：electron-builder extraResources 把冻结目录整体拷到 Resources/backend/
  // 开发态（npm start 直跑未冻结后端时可用 READER_BACKEND_DIR 覆盖）
  const dir = process.env.READER_BACKEND_DIR ||
    (app.isPackaged ? path.join(process.resourcesPath, "backend") : path.join(__dirname, "..", "build", "reader-dist", "reader-server"));
  return process.platform === "win32" ? path.join(dir, "reader-server.exe") : path.join(dir, "reader-server");
}

function serverLogFile() {
  const p = path.join(app.getPath("logs"), "reader-server.log");
  try {
    if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) fs.rotateSync ? fs.rotateSync(p, 1) : fs.rmSync(p);
  } catch (_) { /* 轮转失败就算了，别拖死启动 */ }
  return p;
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startServer(port) {
  const bin = serverBinPath();
  const out = fs.openSync(serverLogFile(), "a");
  serverProc = spawn(bin, ["--port", String(port)], {
    cwd: path.dirname(bin),
    stdio: ["ignore", out, out],
    env: { ...process.env },
  });
  serverProc.on("exit", (code, signal) => {
    if (!quitting) showServerError(`后端进程意外退出（code=${code} signal=${signal}）`);
    serverProc = null;
  });
  serverProc.on("error", (err) => {
    if (!quitting) showServerError(`无法启动后端进程：${err.message}\n路径：${bin}`);
  });
}

function waitForHealth(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() > deadline ? reject(new Error("启动超时")) : setTimeout(tick, 400));
    tick();
  });
}

function showServerError(msg) {
  const log = serverLogFile();
  dialog.showErrorBox("PageOn 启动失败", `${msg}\n\n日志文件：${log}\n（把它发给慧姐即可定位问题）`);
  quitting = true;
  app.quit();
}

// ---------- 更新检查（方案 A：查 GitHub Releases → 弹窗跳下载页）----------
// 不做自动安装：mac 无开发者证书时 Squirrel 验签必失败，全自动是死路；
// 且 GitHub API 未认证限 60 次/小时/IP，对个人分发绰绰有余。
const UPDATE_REPO = "Zealous1Epoch/ai-reading-assistant";
let updateCheckDone = false;

function dismissPath() {
  return path.join(app.getPath("userData"), "update-dismiss.json");
}
function readDismissed() {
  try { return String(JSON.parse(fs.readFileSync(dismissPath(), "utf8")).dismissedFor || ""); }
  catch (_) { return ""; }
}
function writeDismissed(version) {
  try {
    fs.mkdirSync(path.dirname(dismissPath()), { recursive: true });
    fs.writeFileSync(dismissPath(), JSON.stringify({ dismissedFor: version }));
  } catch (_) { /* 写失败顶多下次多弹一次 */ }
}

function cmpSemver(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      { headers: { "User-Agent": "pageon-desktop" }, timeout: 5000 },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function checkForUpdate() {
  if (updateCheckDone) return;
  updateCheckDone = true;
  try {
    const rel = await fetchLatestRelease();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    console.log(`[update] latest=${latest || "?"} current=${current}`);
    if (!latest || cmpSemver(latest, current) <= 0) return; // 无新版/解析失败（含 403 限流）都静默
    if (readDismissed() === latest) return;                 // 这个版本已经说过"下次再说"
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: "info",
      title: "PageOn 更新",
      message: `发现新版本 ${latest}（当前 ${current}）`,
      detail: "藏书、划线、笔记都在本机，覆盖安装不会丢。\n点“前往下载”打开浏览器到发布页。",
      buttons: ["前往下载", "下次再说"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0 && rel.html_url) shell.openExternal(rel.html_url);
    else writeDismissed(latest);
  } catch (e) {
    console.log(`[update] check skipped: ${e.message}`); // 断网/被墙/限流——绝不打扰用户
  }
}

// ---------- window ----------

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "PageOn",
    backgroundColor: "#fafaf9",
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  // 页面里万一有外链，交给系统浏览器，别在壳里开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  // 启动 5 秒后再查更新，不与首屏加载抢资源；每次进程生命周期只查一次
  setTimeout(checkForUpdate, 5000);
}

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });

  const boot = async () => {
    try {
      serverPort = await pickFreePort();
      startServer(serverPort);
      await waitForHealth(serverPort);
      createWindow(serverPort);
    } catch (e) {
      showServerError(e.message);
    }
  };
  app.whenReady().then(boot);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (serverPort) createWindow(serverPort); else boot();
    }
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

  app.on("before-quit", () => {
    quitting = true;
    if (serverProc) {
      try { serverProc.kill(process.platform === "win32" ? undefined : "SIGTERM"); } catch (_) {}
    }
  });
}
