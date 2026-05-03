#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOST_NAME = 'com.relai.request_builder';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = args.browser || 'chrome';
  if (!['chrome', 'edge'].includes(browser)) throw new Error('--browser must be chrome or edge.');
  const expectedManifestPath = getManifestPath(browser);
  const registryManifestPath = process.platform === 'win32' ? readWindowsRegistryManifestPath(browser) : '';
  const manifestPath = registryManifestPath || expectedManifestPath;
  const localRoot = path.resolve(__dirname, '../../..');
  const localPkg = readPackage(path.join(localRoot, 'package.json'));

  const report = {
    hostName: HOST_NAME,
    browser,
    platform: process.platform,
    localProjectRoot: localRoot,
    localProjectVersion: localPkg.version || 'unknown',
    expectedManifestPath,
    registryManifestPath: registryManifestPath || null,
    effectiveManifestPath: manifestPath,
    manifestExists: fs.existsSync(manifestPath)
  };

  if (report.manifestExists) {
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    report.manifest = safeJson(manifestRaw);
    report.manifestRaw = manifestRaw;
    const hostPath = report.manifest && report.manifest.path;
    report.hostPath = hostPath || '';
    report.hostPathExists = Boolean(hostPath && fs.existsSync(hostPath));
    if (report.hostPathExists) {
      const wrapperText = fs.readFileSync(hostPath, 'utf8');
      report.wrapperText = wrapperText;
      const scriptPath = extractScriptPath(wrapperText);
      report.inferredHostScript = scriptPath || null;
      report.inferredHostScriptExists = Boolean(scriptPath && fs.existsSync(scriptPath));
      if (scriptPath) {
        const root = path.resolve(path.dirname(scriptPath), '../../..');
        report.inferredProjectRoot = root;
        report.inferredProjectVersion = readPackage(path.join(root, 'package.json')).version || 'unknown';
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));

  if (!report.manifestExists) {
    process.exitCode = 2;
  } else if (report.inferredProjectVersion && report.inferredProjectVersion !== report.localProjectVersion) {
    process.exitCode = 3;
  }
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

function readWindowsRegistryManifestPath(browser) {
  const key = browser === 'chrome'
    ? `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`
    : `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;
  const result = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8' });
  if (result.status !== 0) return '';
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = text.match(/REG_SZ\s+(.+)$/mi);
  return match ? match[1].trim() : '';
}

function extractScriptPath(wrapperText) {
  const cmdMatch = wrapperText.match(/node(?:\.exe)?"?\s+"([^"]+index\.js)"/i) || wrapperText.match(/"[^"]*node[^"]*"\s+"([^"]+index\.js)"/i);
  if (cmdMatch) return cmdMatch[1];
  const shMatch = wrapperText.match(/exec\s+"[^"]+"\s+"([^"]+index\.js)"/);
  if (shMatch) return shMatch[1];
  const any = wrapperText.match(/"([^"]+index\.js)"/);
  return any ? any[1] : '';
}

function safeJson(raw) { try { return JSON.parse(raw); } catch (_e) { return null; } }
function readPackage(packagePath) { try { return JSON.parse(fs.readFileSync(packagePath, 'utf8')); } catch (_e) { return {}; } }
function parseArgs(argv) { const out={}; for (let i=0;i<argv.length;i++){ const a=argv[i]; if(!a.startsWith('--')) continue; const k=a.slice(2); const n=argv[i+1]; if(!n||n.startsWith('--')) out[k]=true; else { out[k]=n; i++; } } return out; }

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
