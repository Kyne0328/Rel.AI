#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST_NAME = 'com.relai.request_builder';
const PROTOCOL_VERSION = 7;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = args.browser || 'chrome';
  const manifestPath = getManifestPath(browser);
  if (!fs.existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.path || !fs.existsSync(manifest.path)) throw new Error(`Host path not found: ${manifest.path || '(missing)'}`);

  const child = spawn(manifest.path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const request = {
    type: 'relai.configSummary',
    protocolVersion: PROTOCOL_VERSION,
    requestId: `probe-${Date.now()}`,
    source: 'probe-script'
  };

  let stdout = Buffer.alloc(0);
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout = Buffer.concat([stdout, chunk]);
    const parsed = tryReadOne(stdout);
    if (parsed) {
      console.log(JSON.stringify({ manifestPath, hostPath: manifest.path, response: parsed.message }, null, 2));
      child.kill();
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('exit', (code) => {
    if (stdout.length === 0) {
      console.error(JSON.stringify({ manifestPath, hostPath: manifest.path, exitCode: code, stderr }, null, 2));
      process.exitCode = 1;
    }
  });

  child.stdin.write(encodeMessage(request));
  setTimeout(() => {
    console.error(JSON.stringify({ manifestPath, hostPath: manifest.path, timeout: true, stderr }, null, 2));
    child.kill();
    process.exit(2);
  }, 5000).unref();
}

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
function tryReadOne(buffer) {
  if (buffer.length < 4) return null;
  const len = buffer.readUInt32LE(0);
  if (buffer.length < 4 + len) return null;
  const body = buffer.slice(4, 4 + len).toString('utf8');
  return { message: JSON.parse(body) };
}
function getManifestPath(browser) {
  if (process.platform === 'darwin') {
    const appSupport = path.join(os.homedir(), 'Library', 'Application Support');
    return browser === 'chrome'
      ? path.join(appSupport, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`)
      : path.join(appSupport, 'Microsoft Edge', 'NativeMessagingHosts', `${HOST_NAME}.json`);
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), '.rel-ai', 'native-messaging-hosts', browser, `${HOST_NAME}.json`);
  }
  return browser === 'chrome'
    ? path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`)
    : path.join(os.homedir(), '.config', 'microsoft-edge', 'NativeMessagingHosts', `${HOST_NAME}.json`);
}
function parseArgs(argv) { const out={}; for (let i=0;i<argv.length;i++){ const a=argv[i]; if(!a.startsWith('--')) continue; const k=a.slice(2); const n=argv[i+1]; if(!n||n.startsWith('--')) out[k]=true; else { out[k]=n; i++; } } return out; }
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
