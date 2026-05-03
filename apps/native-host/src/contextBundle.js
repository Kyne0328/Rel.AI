const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_CONTEXT_FILES = 25;
const DEFAULT_MAX_CONTEXT_CHARS = 120000;
const DEFAULT_MAX_FILE_BYTES = 80000;
const MAX_ZIP_UPLOAD_BASE64_CHARS = 250000;
const MAX_ZIP_UPLOAD_BYTES = 25 * 1024 * 1024;

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env($|[./-])/i,
  /(^|\/)\.ssh($|\/)/i,
  /(^|\/)(id_rsa|id_ed25519|known_hosts)$/i,
  /(^|\/).*\.(pem|key|p12|pfx)$/i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc)$/i
];

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor"
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".exe", ".dll", ".so",
  ".dylib", ".class", ".jar", ".woff", ".woff2", ".ttf", ".otf", ".mp3",
  ".mp4", ".mov", ".avi", ".mkv", ".sqlite", ".db"
]);

function buildContextBundle(contextRequest, workspace, config) {
  const maxFiles = getInteger(contextRequest.maxFiles, getInteger(config.maxContextFiles, DEFAULT_MAX_CONTEXT_FILES));
  const maxChars = getInteger(contextRequest.maxChars, getInteger(config.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS));
  const maxFileBytes = getInteger(config.maxContextFileBytes, DEFAULT_MAX_FILE_BYTES);
  const contextMode = normalizeContextMode(contextRequest.contextMode || contextRequest.bundleMode || "readable");

  const include = Array.isArray(contextRequest.include) ? contextRequest.include : [];
  if (include.length === 0) {
    throw new Error("Context request must include explicit files or safe globs. Refusing to dump the entire workspace.");
  }

  const resolution = resolveRequestedFiles(workspace.path, include, contextRequest.exclude || [], {
    maxFiles,
    maxFileBytes,
    prompt: contextRequest.prompt || ""
  });
  const files = resolution.files;

  if (files.length === 0) {
    throw new Error("No readable context files matched the request.");
  }

  const collected = collectReadableFiles(files, workspace.path, maxFileBytes);
  if (collected.included.length === 0) {
    throw new Error("All matched context files were skipped due to size, binary detection, or context limits.");
  }

  if (contextMode === "zip") {
    return buildZipContextBundle(contextRequest, workspace, collected, maxChars, config, resolution.taskMentionedFiles);
  }

  return buildReadableContextBundle(contextRequest, workspace, collected, maxChars, resolution.taskMentionedFiles);
}

function collectReadableFiles(files, workspacePath, maxFileBytes) {
  const included = [];
  const skipped = [];
  let totalChars = 0;

  for (const relativePath of files) {
    const absolutePath = path.join(workspacePath, relativePath);
    const stat = fs.statSync(absolutePath);
    if (stat.size > maxFileBytes) {
      skipped.push({ path: relativePath, reason: `larger than ${maxFileBytes} bytes` });
      continue;
    }

    const raw = fs.readFileSync(absolutePath);
    if (looksBinary(raw)) {
      skipped.push({ path: relativePath, reason: "binary-looking file" });
      continue;
    }

    const content = raw.toString("utf8");
    included.push({ path: relativePath, content, byteLength: raw.length, charLength: content.length });
    totalChars += content.length;
  }

  return { included, skipped, totalChars };
}

function buildReadableContextBundle(contextRequest, workspace, collected, maxChars, taskMentionedFiles) {
  const included = [];
  const skipped = [...collected.skipped];
  let totalChars = 0;
  let bundle = makeBundleHeader(contextRequest, workspace);
  bundle += "Use only the provided files as context. If more files are needed, ask for another rel-ai-context request. Do not assume unseen files.\n";
  bundle += makeTaskMentionedFilesSection(taskMentionedFiles);
  bundle += "\n";

  for (const file of collected.included) {
    const chunk = makeFileChunk(file.path, file.content);
    if (bundle.length + chunk.length > maxChars) {
      skipped.push({ path: file.path, reason: `context bundle limit ${maxChars} chars reached` });
      continue;
    }

    bundle += chunk;
    totalChars += file.content.length;
    included.push(file.path);
  }

  if (included.length === 0) {
    throw new Error("All matched context files were skipped due to size, binary detection, or context limits.");
  }

  if (skipped.length > 0) {
    bundle += makeSkippedSection(skipped);
  }

  bundle += "\nNext step: use this readable context to reason, then output a rel-ai-apply block with a unified diff when ready.\n";

  return {
    ok: true,
    type: "relai.context",
    contextMode: "readable",
    workspace: workspace.alias,
    fileCount: included.length,
    totalChars,
    files: included,
    skipped,
    taskMentionedFiles,
    bundle
  };
}

function buildZipContextBundle(contextRequest, workspace, collected, maxChars, config, taskMentionedFiles) {
  const archiveFiles = collected.included.map((file) => ({
    path: file.path,
    data: Buffer.from(file.content, "utf8")
  }));

  const zip = createZipArchive(archiveFiles);
  const maxZipBytes = getInteger(config && config.maxZipUploadBytes, MAX_ZIP_UPLOAD_BYTES);
  if (zip.length > maxZipBytes) {
    throw new Error(`ZIP upload is too large (${zip.length} bytes). Limit is ${maxZipBytes}. Select fewer files/folders or use narrower globs.`);
  }
  const base64 = zip.toString("base64");
  const maxArchiveBase64Chars = getInteger(config && config.maxZipUploadBase64Chars, MAX_ZIP_UPLOAD_BASE64_CHARS);
  const includeArchiveBase64 = base64.length <= maxArchiveBase64Chars;

  const manifest = collected.included.map((file) => ({
    path: file.path,
    bytes: file.byteLength,
    chars: file.charLength,
    language: languageForPath(file.path) || "text"
  }));

  const originalChars = collected.totalChars;
  const compressionRatio = originalChars > 0 ? zip.length / originalChars : 0;
  const safeTask = slugify(contextRequest.prompt || workspace.alias || "workspace").slice(0, 80) || "workspace";
  const archiveName = `rel-ai-${safeTask}.zip`;
  const archivePath = writeTempArchive(archiveName, zip);

  let bundle = makeBundleHeader(contextRequest, workspace);
  bundle += "The selected workspace context is attached as a real ZIP file named `" + archiveName + "`.\n";
  bundle += "Use the uploaded ZIP contents as the source context. Do not ask the user to paste the archive contents unless the upload is unavailable.\n";
  bundle += "If you cannot inspect the attached ZIP, ask the user to resend in Readable text mode or select a narrower file list. Do not invent code from the manifest alone.\n\n";
  bundle += "Attached ZIP manifest:\n";
  bundle += "```json\n";
  bundle += JSON.stringify({
    format: "rel-ai-context-zip-upload",
    workspace: workspace.alias,
    archiveName,
    fileCount: manifest.length,
    originalChars,
    zipBytes: zip.length,
    compressionRatio: Number(compressionRatio.toFixed(4)),
    files: manifest,
    taskMentionedFiles
  }, null, 2);
  bundle += "\n```\n";
  bundle += makeTaskMentionedFilesSection(taskMentionedFiles);

  if (collected.skipped.length > 0) {
    bundle += makeSkippedSection(collected.skipped);
  }

  bundle += "\nNext step: inspect the attached ZIP, then output a rel-ai-apply block plus a separate unified diff block when ready.\n";

  if (bundle.length > maxChars) {
    throw new Error(`ZIP request instructions are too large (${bundle.length} chars). Select fewer files/folders or raise maxChars.`);
  }

  return {
    ok: true,
    type: "relai.context",
    contextMode: "zip",
    archiveEncoding: "zip-upload",
    archiveName,
    archivePath,
    archiveMimeType: "application/zip",
    ...(includeArchiveBase64 ? { archiveBase64: base64 } : {}),
    archiveBase64Omitted: !includeArchiveBase64,
    workspace: workspace.alias,
    fileCount: collected.included.length,
    totalChars: originalChars,
    zipBytes: zip.length,
    base64Chars: base64.length,
    compressionRatio,
    files: collected.included.map((file) => file.path),
    skipped: collected.skipped,
    taskMentionedFiles,
    bundle
  };
}


function writeTempArchive(archiveName, buffer) {
  const root = path.join(os.tmpdir(), "rel-ai-archives");
  fs.mkdirSync(root, { recursive: true });
  const safeName = slugify(archiveName.replace(/\.zip$/i, "")).slice(0, 80) || "context";
  const fileName = `${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`;
  const archivePath = path.join(root, fileName);
  fs.writeFileSync(archivePath, buffer);
  return archivePath;
}

function makeBundleHeader(contextRequest, workspace) {
  let header = `Rel.AI workspace context
Workspace alias: ${workspace.alias}
`;
  if (contextRequest.prompt) {
    header += `Task:
${contextRequest.prompt}
`;
  }
  return `${header}
`;
}
function makeSkippedSection(skipped) {
  let text = "\nSkipped files:\n";
  for (const item of skipped.slice(0, 50)) {
    text += `- ${item.path}: ${item.reason}\n`;
  }
  return text;
}

function resolveRequestedFiles(workspacePath, include, exclude, options) {
  const realWorkspace = fs.realpathSync(workspacePath);
  const gitFiles = listGitVisibleFiles(realWorkspace);
  const pool = gitFiles.length > 0 ? gitFiles : walkWorkspace(realWorkspace);
  const excludedMatchers = exclude.map(makeMatcher);
  const selected = new Set();

  for (const pattern of include) {
    const normalized = normalizeRequestPath(pattern);
    const matcher = makeMatcher(normalized);
    const isGlob = hasGlob(normalized) || normalized.endsWith("/") || normalized.endsWith("/**");

    if (isGlob) {
      for (const candidate of pool) {
        if (matcher(candidate) && !isExcluded(candidate, excludedMatchers)) {
          selected.add(candidate);
        }
      }
      continue;
    }

    const absolute = path.resolve(realWorkspace, normalized);
    ensureInsideWorkspace(realWorkspace, absolute, normalized);

    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      const dirPrefix = normalized.replace(/\/+$/g, "") + "/";
      for (const candidate of pool) {
        if (candidate.startsWith(dirPrefix) && !isExcluded(candidate, excludedMatchers)) {
          selected.add(candidate);
        }
      }
      continue;
    }

    if (pool.includes(normalized) && !isExcluded(normalized, excludedMatchers)) {
      selected.add(normalized);
    }
  }

  const taskMentionedFiles = resolveTaskMentionedFiles(realWorkspace, pool, String(options.prompt || ""), excludedMatchers);
  for (const item of taskMentionedFiles.included) {
    selected.add(item.path);
  }

  const safeFiles = [...selected]
    .filter((item) => isSafeRelativePath(item))
    .filter((item) => !isSecretPath(item))
    .filter((item) => !BINARY_EXTENSIONS.has(path.extname(item).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));

  const priority = new Set(taskMentionedFiles.included.map((item) => item.path));
  const prioritized = [
    ...safeFiles.filter((item) => priority.has(item)),
    ...safeFiles.filter((item) => !priority.has(item))
  ];

  return {
    files: prioritized.slice(0, options.maxFiles),
    taskMentionedFiles: {
      mentioned: taskMentionedFiles.mentioned,
      included: taskMentionedFiles.included.filter((item) => prioritized.slice(0, options.maxFiles).includes(item.path)),
      missing: taskMentionedFiles.missing
    }
  };
}

function resolveTaskMentionedFiles(realWorkspace, pool, prompt, excludedMatchers) {
  const mentioned = extractMentionedPaths(prompt);
  const included = [];
  const missing = [];
  const lowerToPath = new Map();

  for (const candidate of pool) {
    if (!lowerToPath.has(candidate.toLowerCase())) {
      lowerToPath.set(candidate.toLowerCase(), candidate);
    }
  }

  for (const raw of mentioned) {
    const normalized = normalizeMentionedPath(raw);
    if (!normalized || !isSafeRelativePath(normalized) || isSecretPath(normalized)) {
      continue;
    }

    const exact = pool.includes(normalized) ? normalized : lowerToPath.get(normalized.toLowerCase());
    if (exact && !isExcluded(exact, excludedMatchers) && !BINARY_EXTENSIONS.has(path.extname(exact).toLowerCase())) {
      included.push({ requested: raw, path: exact, status: exact === normalized ? "exists" : "exists-case-insensitive" });
      continue;
    }

    missing.push({ requested: raw, normalized, status: "not-in-selected-workspace-index" });
  }

  return { mentioned, included: uniqueByPath(included), missing: uniqueByNormalized(missing) };
}

function extractMentionedPaths(prompt) {
  const text = String(prompt || "");
  const found = new Set();
  const patterns = [
    /(?:^|[\s`"'(:\[])([A-Za-z0-9._-]+\/[A-Za-z0-9._@+\-/]+\.[A-Za-z0-9]{1,12})(?=$|[\s`"'),.:;\]])/g,
    /(?:^|[\s`"'(:\[])([A-Za-z0-9._@+-]+\.(?:md|markdown|json|js|ts|tsx|jsx|css|html|yml|yaml|toml|py|rs|go|java|c|cpp|h|hpp|sh|txt))(?=$|[\s`"'),.:;\]])/gi
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const candidate = normalizeMentionedPath(match[1]);
      if (candidate) found.add(candidate);
    }
  }

  if (/\breadme\b/i.test(text)) {
    found.add("README.md");
    found.add("readme.md");
  }

  return [...found];
}

function normalizeMentionedPath(input) {
  let value = String(input || "").trim().replace(/\\/g, "/");
  value = value.replace(/^\.\//, "").replace(/[),.;:]+$/g, "");
  if (!value || value.includes("*") || value.includes("?")) return "";
  return value;
}

function uniqueByPath(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!seen.has(item.path)) {
      seen.add(item.path);
      output.push(item);
    }
  }
  return output;
}

function uniqueByNormalized(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!seen.has(item.normalized)) {
      seen.add(item.normalized);
      output.push(item);
    }
  }
  return output;
}

function makeTaskMentionedFilesSection(taskMentionedFiles) {
  if (!taskMentionedFiles || ((!taskMentionedFiles.included || taskMentionedFiles.included.length === 0) && (!taskMentionedFiles.missing || taskMentionedFiles.missing.length === 0))) {
    return "";
  }

  let text = "\nTask-mentioned file check:\n";
  for (const item of (taskMentionedFiles.included || []).slice(0, 20)) {
    text += `- ${item.requested}: exists as ${item.path} and was included in the context. Use this exact path/case in diffs.\n`;
  }
  for (const item of (taskMentionedFiles.missing || []).slice(0, 20)) {
    text += `- ${item.requested}: not found in the selected workspace file index. Do not create or modify it unless the task explicitly requires a new file and no existing equivalent is listed.\n`;
  }
  return text;
}

function listGitVisibleFiles(workspacePath) {
  const result = spawnSync("git", ["-C", workspacePath, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  return result.stdout
    .split("\0")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(toPosixPath)
    .filter(isSafeRelativePath)
    .filter((item) => !isSecretPath(item));
}

function walkWorkspace(workspacePath) {
  const output = [];
  walkDir(workspacePath, "", output);
  return output;
}

function walkDir(root, relativeDir, output) {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (_error) {
    return;
  }

  for (const entry of entries) {
    const relativePath = toPosixPath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (!DEFAULT_EXCLUDED_DIRS.has(entry.name) && !isSecretPath(relativePath)) {
        walkDir(root, relativePath, output);
      }
      continue;
    }
    if (entry.isFile() && isSafeRelativePath(relativePath) && !isSecretPath(relativePath)) {
      output.push(relativePath);
    }
  }
}

function makeMatcher(pattern) {
  let normalized = normalizeRequestPath(pattern);
  if (normalized.endsWith("/")) {
    normalized += "**";
  }
  if (normalized.endsWith("/**")) {
    const prefix = normalized.slice(0, -3);
    return (candidate) => candidate === prefix.slice(0, -1) || candidate.startsWith(prefix);
  }
  if (!hasGlob(normalized)) {
    return (candidate) => candidate === normalized;
  }

  const regex = new RegExp("^" + globToRegex(normalized) + "$", "i");
  return (candidate) => regex.test(candidate);
}

function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

function hasGlob(value) {
  return /[*?]/.test(value);
}

function normalizeRequestPath(input) {
  const value = String(input || "").trim().replace(/\\/g, "/");
  if (!value) {
    throw new Error("Context include/exclude paths cannot be empty.");
  }
  if (!isSafeRelativePath(value.replace(/\*\*/g, "x").replace(/\*/g, "x").replace(/\?/g, "x"))) {
    throw new Error(`Unsafe context path: ${input}`);
  }
  return value.replace(/^\.\//, "");
}

function isSafeRelativePath(value) {
  return Boolean(value)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split("/").includes("..");
}

function ensureInsideWorkspace(realWorkspace, absolutePath, label) {
  const probe = fs.existsSync(absolutePath) ? absolutePath : path.dirname(absolutePath);
  const resolved = fs.realpathSync(fs.existsSync(probe) ? probe : path.dirname(probe));
  const relative = path.relative(realWorkspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Context path escapes workspace: ${label}`);
  }
}

function isExcluded(candidate, matchers) {
  return matchers.some((matcher) => matcher(candidate));
}

function isSecretPath(relativePath) {
  const posix = toPosixPath(relativePath);
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(posix));
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 4096);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function makeFileChunk(relativePath, content) {
  const lang = languageForPath(relativePath);
  return `\n--- FILE: ${relativePath} ---\n\`\`\`${lang}\n${content.replace(/\`\`\`/g, "` ` `")}\n\`\`\`\n`;
}

function createZipArchive(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(toPosixPath(file.path), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data || ""), "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const { dosTime, dosDate } = getDosDateTime(new Date());

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localEntry = Buffer.concat([localHeader, nameBuffer, payload]);
    localParts.push(localEntry);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([centralHeader, nameBuffer]));

    offset += localEntry.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function getDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = makeCrcTable();
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function normalizeContextMode(value) {
  const mode = String(value || "readable").trim().toLowerCase();
  if (["zip", "compressed", "archive"].includes(mode)) {
    return "zip";
  }
  return "readable";
}

function languageForPath(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    ".js": "js",
    ".jsx": "jsx",
    ".ts": "ts",
    ".tsx": "tsx",
    ".py": "python",
    ".java": "java",
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".md": "md",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".xml": "xml",
    ".sh": "bash"
  };
  return map[ext] || "text";
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function getInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

module.exports = {
  buildContextBundle,
  resolveRequestedFiles,
  createZipArchive
};
