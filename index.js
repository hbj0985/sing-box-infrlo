// wisp-node: runs sing-box (VLESS + WebSocket) inside a WispByte Node.js container.
// The panel starts this file with: node /home/container/index.js
// First run downloads sing-box, writes config, spawns it, and keeps the process alive.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

const VERSION = '1.14.4';
const UUID = '489d5e0d-f1a0-4f3a-9e76-860a0176f61b';
const WS_PATH = '/wisp';
const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '8080', 10);
const DIR = __dirname;
const BIN = path.join(DIR, 'sing-box');
const CFG = path.join(DIR, 'config.json');
const TARBALL = path.join(DIR, 'sing-box.tar.gz');

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log.apply(console, [new Date().toISOString()].concat(args));
}

function download(url, dest) {
  return new Promise(function (resolve, reject) {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'wisp-node' } }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, function () {});
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error('download HTTP ' + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on('finish', function () { file.close(resolve); });
    });
    req.on('error', function (e) { file.close(); reject(e); });
  });
}

function sh(cmd, args) {
  return new Promise(function (resolve, reject) {
    execFile(cmd, args, { cwd: DIR }, function (err, stdout, stderr) {
      if (err) return reject(new Error(cmd + ' failed: ' + (stderr || err.message)));
      resolve(stdout);
    });
  });
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) { log('sing-box binary already exists'); return; }
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const name = 'sing-box-' + VERSION + '-linux-' + arch + '.tar.gz';
  const url = 'https://github.com/SagerNet/sing-box/releases/download/v' + VERSION + '/' + name;
  log('downloading', url);
  await download(url, TARBALL);
  log('downloaded, extracting...');
  await sh('tar', ['-xzf', TARBALL, '--strip-components=1']);
  await sh('chmod', ['+x', BIN]);
  fs.unlink(TARBALL, function () {});
  log('sing-box ready:', fs.existsSync(BIN));
}

function writeConfig() {
  const config = {
    log: { level: 'info' },
    inbounds: [
      {
        type: 'vless',
        tag: 'vless-in',
        listen: '0.0.0.0',
        listen_port: PORT,
        users: [{ uuid: UUID }],
        transport: { type: 'ws', path: WS_PATH }
      }
    ],
    outbounds: [{ type: 'direct', tag: 'direct' }]
  };
  fs.writeFileSync(CFG, JSON.stringify(config, null, 2));
  log('config written, port', PORT, 'ws path', WS_PATH);
}

let child = null;
let restarts = 0;
function start() {
  log('starting sing-box...');
  child = spawn(BIN, ['run', '-c', CFG], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', function (d) { process.stdout.write('[sb] ' + d); });
  child.stderr.on('data', function (d) { process.stderr.write('[sb] ' + d); });
  child.on('exit', function (code, signal) {
    restarts += 1;
    log('sing-box exited code=' + code + ' signal=' + signal + ', restarting in 5s (#' + restarts + ')');
    setTimeout(start, 5000);
  });
  child.on('error', function (e) { log('spawn error', e.message); });
}

(async function main() {
  try {
    log('wisp-node starting, port', PORT, 'arch', process.arch);
    await ensureBinary();
    writeConfig();
    start();
    setInterval(function () {
      log('heartbeat, sing-box pid', child && child.pid);
    }, 60000);
  } catch (e) {
    log('FATAL', e && e.message);
    setInterval(function () {
      log('waiting after fatal error:', e && e.message);
    }, 30000);
  }
})();
