const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DEFAULT_MAX_CONTEXT_FILES = 25;
const DEFAULT_MAX_CONTEXT_CHARS = 120000;
const DEFAULT_MAX_FILE_BYTES = 200000;
const MAX_ZIP_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_PROJECT_TREE_ENTRIES = 800;
const DEFAULT_FULL_REPO_MAX_FILES = 500;
const FULL_REPO_SCOPE = "full";
const MAX_ZIP_UPLOAD_BASE64_CHARS = 32 * 1024 * 1024;
const MAX_ZIP_UPLOAD_BYTES = 100 * 1024 * 1024;

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env($|[./-])/i,
  /(^|\/)\.ssh($|\/)/i,
  /(^|\/)(id_rsa|id_ed25519|known_hosts)$/i,
  /(^|\/).*\.(pem|key|p12|pfx)$/i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc)$/i,
  /(^|\/)firebase-adminsdk[^/]*\.json$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.azure\//i,
  /(^|\/)gcloud\/credentials/i
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
  ".parcel-cache",
  ".vite",
  ".svelte-kit",
  ".angular",
  ".gradle",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
  "out",
  "tmp",
  "temp",
  "logs",
  ".idea",
  ".vs",
  ".vercel",
  ".netlify",
  ".output",
  "Pods"
]);

const FULL_REPO_NOISE_FILE_PATTERNS = [
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)desktop\.ini$/i,
  /(^|\/)npm-debug\.log$/i,
  /(^|\/)(yarn|pnpm)-debug\.log$/i,
  /(^|\/)yarn-error\.log$/i,
  /(^|\/)\.eslintcache$/i,
  /(^|\/).*\.tsbuildinfo$/i,
  /(^|\/).*\.log$/i,
  /(^|\/).*\.(tmp|temp|bak|swp|swo)$/i,
  /(^|\/).*\.map$/i,
  /(^|\/).*\.min\.(js|css)$/i
];

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".exe", ".dll", ".so",
  ".dylib", ".class", ".jar", ".woff", ".woff2", ".ttf", ".otf", ".mp3",
  ".mp4", ".mov", ".avi", ".mkv", ".sqlite", ".db"
]);

function buildContextBundle(contextRequest, workspace, config) {
  const contextScope = normalizeContextScope(contextRequest.contextScope || contextRequest.scope || "focused");
  const defaultMaxFiles = contextScope === "full"
    ? getInteger(config && config.maxFullRepoFiles, DEFAULT_FULL_REPO_MAX_FILES)
    : getInteger(config && config.maxContextFiles, DEFAULT_MAX_CONTEXT_FILES);
  const maxFiles = getInteger(contextRequest.maxFiles, defaultMaxFiles);
  const maxChars = getInteger(contextRequest.maxChars, getInteger(config && config.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS));
  const maxFileBytes = getInteger(config && config.maxContextFileBytes, DEFAULT_MAX_FILE_BYTES);
  const contextMode = contextScope === "full" ? "zip" : normalizeContextMode(contextRequest.contextMode || contextRequest.bundleMode || "readable");

  const include = Array.isArray(contextRequest.include) ? contextRequest.include : [];
  if (include.length === 0 && contextScope !== "full") {
    throw new Error("Context request must include explicit files or safe globs unless full repo archive mode is selected.");
  }

  const resolution = resolveRequestedFiles(workspace.path, include, contextRequest.exclude || [], {
    maxFiles,
    maxFileBytes,
    prompt: contextRequest.prompt || "",
    contextScope,
    maxProjectTreeEntries: getInteger(config && config.maxProjectTreeEntries, DEFAULT_PROJECT_TREE_ENTRIES)
  });
  const files = resolution.files;

  if (files.length === 0) {
    throw new Error("No readable context files matched the request.");
  }

  const effectiveMaxFileBytes = contextMode === "zip" ? MAX_ZIP_FILE_BYTES : maxFileBytes;
  const collected = collectReadableFiles(files, workspace.path, effectiveMaxFileBytes);
  if (collected.included.length === 0) {
    const detail = collected.skipped.slice(0, 6).map((s) => `${s.path} (${s.reason})`).join("; ");
    throw new Error(`All matched context files were skipped.${detail ? ` ${detail}${collected.skipped.length > 6 ? ` and ${collected.skipped.length - 6} more` : ""}.` : ""}`);
  }

  if (contextMode === "zip") {
    return buildZipContextBundle(contextRequest, workspace, collected, maxChars, config, resolution.taskMentionedFiles, resolution.projectTree, contextScope);
  }

  return buildReadableContextBundle(contextRequest, workspace, collected, maxChars, resolution.taskMentionedFiles, resolution.projectTree, contextScope);
}

function collectReadableFiles(files, workspacePath, maxFileBytes) {
  const included = [];
  const skipped = [];
  let totalChars = 0;

  for (const relativePath of files) {
    const absolutePath = path.join(workspacePath, relativePath);
    try {
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
    } catch (_error) {
      skipped.push({ path: relativePath, reason: "file unreadable or removed during collection" });
    }
  }

  return { included, skipped, totalChars };
}

function buildReadableContextBundle(contextRequest, workspace, collected, maxChars, taskMentionedFiles, projectTree, contextScope) {
  const included = [];
  const skipped = [...collected.skipped];
  let totalChars = 0;
  let bundle = makeBundleHeader(contextRequest, workspace);
  bundle += "Use the project file tree to preserve exact path casing and avoid duplicate files. Files listed only in the tree are not full file contents; if you need their contents, ask for them.\n";
  bundle += "Use only the provided file contents as editable context. If more files are needed, ask for another rel-ai-context request. Do not assume unseen file contents.\n";
  bundle += makeProjectTreeSection(projectTree);
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
    const detail = skipped.slice(0, 6).map((s) => `${s.path} (${s.reason})`).join("; ");
    throw new Error(`All matched context files exceeded the readable bundle limit (${maxChars} chars).${detail ? ` ${detail}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ""}.` : ""} Try ZIP context mode or select fewer/smaller files.`);
  }

  if (skipped.length > 0) {
    bundle += makeSkippedSection(skipped);
  }

  bundle += "\nNext step: use this readable context to reason, then output a rel-ai-apply block with a unified diff when ready.\n";

  return {
    ok: true,
    type: "relai.context",
    contextMode: "readable",
    contextScope,
    workspace: workspace.alias,
    fileCount: included.length,
    totalChars,
    files: included,
    skipped,
    taskMentionedFiles,
    projectTree,
    bundle
  };
}

function buildZipContextBundle(contextRequest, workspace, collected, maxChars, config, taskMentionedFiles, projectTree, contextScope) {
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
  const archiveFingerprint = makeArchiveFingerprint(workspace.alias, contextScope, manifest, zip);
  const safeTask = slugify(contextRequest.prompt || workspace.alias || "workspace").slice(0, 60) || "workspace";
  const archiveName = `rel-ai-${safeTask}-${archiveFingerprint}.zip`;
  const archivePath = writeTempArchive(archiveName, zip);

  let bundle = makeBundleHeader(contextRequest, workspace, contextScope);
  bundle += makeContextScopeGuidance(contextScope);
  bundle += (contextScope === "full" ? "The filtered full-repo workspace context is attached as a real ZIP file named `" : "The selected workspace context is attached as a real ZIP file named `") + archiveName + "`.\n";
  bundle += "Use the uploaded ZIP contents as the source context. Do not ask the user to paste the archive contents unless the upload is unavailable.\n";
  bundle += "Use the project file tree below to preserve exact path casing and avoid duplicate files. Files listed only in the tree are not full file contents; if you need their contents, ask for them.\n";
  bundle += "If you cannot inspect the attached ZIP, ask the user to resend in Readable text mode or select a narrower file list. Do not invent code from the manifest alone.\n\n";
  bundle += makeProjectTreeSection(projectTree);
  bundle += "Attached ZIP manifest:\n";
  bundle += "```json\n";
  bundle += JSON.stringify({
    format: "rel-ai-context-zip-upload",
    workspace: workspace.alias,
    contextScope,
    archiveName,
    fileCount: manifest.length,
    originalChars,
    zipBytes: zip.length,
    compressionRatio: Number(compressionRatio.toFixed(4)),
    files: manifest,
    taskMentionedFiles,
    projectTree: projectTree ? {
      totalFiles: projectTree.totalFiles,
      shownFiles: projectTree.shownFiles,
      omittedFiles: projectTree.omittedFiles
    } : undefined
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
    contextScope,
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
    projectTree,
    bundle
  };
}


function makeArchiveFingerprint(workspaceAlias, contextScope, manifest, zip) {
  const hash = crypto.createHash("sha256");
  hash.update(String(workspaceAlias || ""));
  hash.update("\0");
  hash.update(String(contextScope || ""));
  hash.update("\0");
  for (const item of manifest) {
    hash.update(item.path);
    hash.update("\0");
    hash.update(String(item.bytes));
    hash.update("\0");
    hash.update(String(item.chars));
    hash.update("\0");
  }
  hash.update(zip);
  return hash.digest("hex").slice(0, 10);
}

function writeTempArchive(archiveName, buffer) {
  const root = path.join(os.tmpdir(), "rel-ai-archives");
  fs.mkdirSync(root, { recursive: true });
  pruneTempArchives(root);
  const safeName = slugify(archiveName.replace(/\.zip$/i, "")).slice(0, 80) || "context";
  const fileName = `${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`;
  const archivePath = path.join(root, fileName);
  fs.writeFileSync(archivePath, buffer);
  return archivePath;
}

function pruneTempArchives(root) {
  const maxAgeMs = 4 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith(".zip")) continue;
      const full = path.join(root, entry);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full);
      } catch (_error) {}
    }
  } catch (_error) {}
}

function makeBundleHeader(contextRequest, workspace, contextScope) {
  let header = `Rel.AI workspace context
Workspace alias: ${workspace.alias}
Context scope: ${contextScope || "focused"}
`;
  if (contextRequest.prompt) {
    header += `Task:
${contextRequest.prompt}
`;
  }
  return `${header}
`;
}
function makeContextScopeGuidance(contextScope) {
  if (contextScope === "full") {
    return "Context scope is Full repo upload (filtered): Rel.AI included safe Git-visible workspace files up to the configured limit while excluding ignored paths, dependency folders, build outputs, caches, logs, binaries, generated artifacts, secret-looking paths, and tech-stack-specific noise files (e.g. *.pyc, *.snap, *.class, DerivedData). Treat skipped files as unavailable and ask for more context if needed.\n";
  }
  if (contextScope === "selected") {
    return "Context scope is Selected only: Rel.AI included the selected files/folders/globs plus any safe task-mentioned files that already exist. Do not assume unselected file contents.\n";
  }
  return "Context scope is Focused: Rel.AI included the compact project tree, selected context, and safe task-mentioned files that already exist. Ask for more context if the required contents are missing.\n";
}

function makeSkippedSection(skipped) {
  let text = "\nSkipped files:\n";
  for (const item of skipped.slice(0, 50)) {
    text += `- ${item.path}: ${item.reason}\n`;
  }
  return text;
}

function detectStackExclusions(workspacePath) {
  const extraDirs = new Set();
  const extraFilePatterns = [];

  let rootEntries;
  try {
    rootEntries = new Set(fs.readdirSync(workspacePath).map((e) => e.toLowerCase()));
  } catch (_error) {
    return { extraDirs, extraFilePatterns };
  }

  const has = (name) => rootEntries.has(name);
  const hasSuffix = (suffix) => [...rootEntries].some((e) => e.endsWith(suffix));

  const isNode = has("package.json") || has("package-lock.json") || has("yarn.lock") || has("pnpm-lock.yaml");
  if (isNode) {
    extraDirs.add(".nyc_output");
    extraDirs.add("storybook-static");
    extraDirs.add(".expo");
    extraDirs.add(".yarn");
    extraFilePatterns.push(/(^|\/).*\.snap$/i);
  }

  const isPython = has("requirements.txt") || has("pipfile") || has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("poetry.lock");
  if (isPython) {
    extraDirs.add(".eggs");
    extraDirs.add(".tox");
    extraDirs.add("htmlcov");
    extraDirs.add(".nox");
    extraFilePatterns.push(/(^|\/).*\.pyc$/i);
    extraFilePatterns.push(/(^|\/).*\.pyo$/i);
    extraFilePatterns.push(/(^|\/).*\.egg-info(\/|$)/i);
  }

  const isRust = has("cargo.toml");
  if (isRust) {
    extraFilePatterns.push(/(^|\/).*\.(rlib|rmeta)$/i);
  }

  const isJava = has("pom.xml") || has("build.gradle") || has("build.gradle.kts") || has("settings.gradle") || has("settings.gradle.kts") || has("gradlew");
  if (isJava) {
    extraDirs.add(".gradle");
    extraFilePatterns.push(/(^|\/).*\.class$/i);
    extraFilePatterns.push(/(^|\/).*\.(jar|war|ear|aar)$/i);
  }

  const isPhp = has("composer.json") || has("composer.lock");
  if (isPhp) {
    extraDirs.add("storage/logs");
    extraDirs.add("storage/framework/cache");
    extraDirs.add("bootstrap/cache");
    extraDirs.add("public/build");
  }

  const isRuby = has("gemfile") || has("gemfile.lock") || has("rakefile");
  if (isRuby) {
    extraDirs.add(".bundle");
    extraDirs.add("public/assets");
    extraDirs.add("public/packs");
  }

  const isApple = has("podfile") || hasSuffix(".xcodeproj") || hasSuffix(".xcworkspace");
  if (isApple) {
    extraDirs.add("DerivedData");
    extraDirs.add("xcuserdata");
    extraFilePatterns.push(/(^|\/).*\.xcuserdata(\/|$)/i);
  }

  const isFlutter = has("pubspec.yaml") || has("pubspec.lock");
  if (isFlutter) {
    extraDirs.add(".dart_tool");
    extraDirs.add(".flutter-plugins");
    extraFilePatterns.push(/(^|\/).*\.(freezed|g)\.dart$/i);
  }

  const isDotNet = hasSuffix(".csproj") || hasSuffix(".sln") || hasSuffix(".vbproj") || hasSuffix(".fsproj");
  if (isDotNet) {
    extraDirs.add("bin");
    extraDirs.add("obj");
    extraFilePatterns.push(/(^|\/).*\.(exe|dll|pdb|nupkg)$/i);
  }

  return { extraDirs, extraFilePatterns };
}

function resolveRequestedFiles(workspacePath, include, exclude, options) {
  const realWorkspace = fs.realpathSync(workspacePath);
  const gitFiles = listGitVisibleFiles(realWorkspace);
  const rawPool = gitFiles.length > 0 ? gitFiles : walkWorkspace(realWorkspace);
  const pool = rawPool.filter((candidate) => !isUnnecessaryContextPath(candidate));
  const excludedMatchers = exclude.map(makeMatcher);
  const selected = new Set();

  if (options.contextScope === FULL_REPO_SCOPE) {
    const { extraDirs, extraFilePatterns } = detectStackExclusions(realWorkspace);
    for (const candidate of pool) {
      if (!isExcluded(candidate, excludedMatchers)
        && !isExtraExcluded(candidate, extraDirs, extraFilePatterns)) {
        selected.add(candidate);
      }
    }
  } else {
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
  }

  const projectTree = buildProjectTree(pool, options.maxProjectTreeEntries || DEFAULT_PROJECT_TREE_ENTRIES);
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

  const finalFiles = prioritized.slice(0, options.maxFiles);
  const finalSet = new Set(finalFiles);
  return {
    files: finalFiles,
    taskMentionedFiles: {
      mentioned: taskMentionedFiles.mentioned,
      included: taskMentionedFiles.included.filter((item) => finalSet.has(item.path)),
      missing: taskMentionedFiles.missing
    },
    projectTree
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

function buildProjectTree(pool, maxEntries) {
  const safeFiles = [...new Set((Array.isArray(pool) ? pool : [])
    .map(toPosixPath)
    .filter(isSafeRelativePath)
    .filter((item) => !isSecretPath(item)))];

  const ordered = prioritizeTreeFiles(safeFiles);
  const shown = ordered.slice(0, Math.max(1, maxEntries || DEFAULT_PROJECT_TREE_ENTRIES));
  const omittedFiles = Math.max(0, safeFiles.length - shown.length);
  const text = renderProjectTree(shown, omittedFiles, safeFiles.length);

  return {
    totalFiles: safeFiles.length,
    shownFiles: shown.length,
    omittedFiles,
    text
  };
}

function prioritizeTreeFiles(files) {
  const rootPriority = /^(README(\.[A-Za-z0-9]+)?|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig\.json|jsconfig\.json|vite\.config\.[jt]s|webpack\.config\.[jt]s|LICENSE|CHANGELOG(\.md)?|CONTRIBUTING(\.md)?)$/i;
  return [...files].sort((a, b) => {
    const ap = rootPriority.test(a) ? 0 : 1;
    const bp = rootPriority.test(b) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const ad = a.split('/').length;
    const bd = b.split('/').length;
    if (ad !== bd) return ad - bd;
    return a.localeCompare(b);
  });
}

function renderProjectTree(files, omittedFiles, totalFiles) {
  const root = { dirs: new Map(), files: [] };
  for (const filePath of files) {
    const parts = filePath.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.files.push(part);
      } else {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
    }
  }

  const lines = ['.'];
  renderTreeNode(root, '', lines);
  if (omittedFiles > 0) {
    lines.push(`... ${omittedFiles} more file(s) omitted from tree (${totalFiles} total safe workspace files).`);
  }
  return lines.join('\n');
}

function renderTreeNode(node, prefix, lines) {
  const entries = [
    ...[...node.dirs.keys()].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, type: 'dir', node: node.dirs.get(name) })),
    ...node.files.sort((a, b) => a.localeCompare(b)).map((name) => ({ name, type: 'file' }))
  ];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const last = i === entries.length - 1;
    const connector = last ? '└── ' : '├── ';
    const childPrefix = prefix + (last ? '    ' : '│   ');
    lines.push(`${prefix}${connector}${entry.name}${entry.type === 'dir' ? '/' : ''}`);
    if (entry.type === 'dir') {
      renderTreeNode(entry.node, childPrefix, lines);
    }
  }
}

function makeProjectTreeSection(projectTree) {
  if (!projectTree || !projectTree.text) {
    return '';
  }
  let text = '\nProject file tree (exact workspace paths and casing; contents are only available for included files):\n';
  text += '```text\n';
  text += projectTree.text;
  text += '\n```\n';
  return text;
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
  const value = String(input || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value) {
    throw new Error("Context include/exclude paths cannot be empty.");
  }
  if (value === "." || value === "/" || value === "**" || value === "./**") {
    throw new Error("Context include/exclude path is too broad. Use a specific subdirectory like lib/data/services/**.");
  }
  const hasWildcard = hasGlob(value);
  if (hasWildcard && !isSafeDirectoryGlob(value)) {
    throw new Error("Context include/exclude paths may only use the safe directory glob form subdir/**. Other wildcards are not supported.");
  }
  const safeProbe = hasWildcard ? value.slice(0, -3) : value;
  if (!isSafeRelativePath(safeProbe)) {
    throw new Error(`Unsafe context path: ${input}`);
  }
  return value;
}

function isSafeDirectoryGlob(value) {
  if (!value.endsWith("/**")) {
    return false;
  }
  const prefix = value.slice(0, -3).replace(/\/+$/g, "");
  return Boolean(prefix)
    && prefix !== "."
    && !hasGlob(prefix)
    && isSafeRelativePath(prefix);
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

function isExtraExcluded(candidate, extraDirs, extraFilePatterns) {
  const parts = candidate.split("/").filter(Boolean);
  if (parts.some((part) => extraDirs.has(part))) return true;
  return extraFilePatterns.some((pattern) => pattern.test(candidate));
}

function isSecretPath(relativePath) {
  const posix = toPosixPath(relativePath);
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(posix));
}

function isUnnecessaryContextPath(relativePath) {
  const posix = toPosixPath(relativePath);
  const parts = posix.split("/").filter(Boolean);
  if (parts.some((part) => DEFAULT_EXCLUDED_DIRS.has(part))) {
    return true;
  }
  return FULL_REPO_NOISE_FILE_PATTERNS.some((pattern) => pattern.test(posix));
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

function normalizeContextScope(value) {
  const scope = String(value || "focused").trim().toLowerCase();
  if (["focused", "selected", "full"].includes(scope)) {
    return scope;
  }
  return "focused";
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
