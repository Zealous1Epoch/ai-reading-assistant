// 智能读书助手桌面壳（v3.9 打包）
// 职责：挑空闲端口 → 起 reader-server sidecar → 轮询健康检查 → 开窗口指向它；
// 退出时负责杀掉 sidecar，不留孤儿进程。界面本体仍是 FastAPI 服务的 frontend/dist。
const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
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
  dialog.showErrorBox("读书助手启动失败", `${msg}\n\n日志文件：${log}\n（把它发给慧姐即可定位问题）`);
  quitting = true;
  app.quit();
}

// ---------- window ----------

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: "读书助手",
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
