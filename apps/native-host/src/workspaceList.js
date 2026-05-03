const fs = require("node:fs");
const path = require("node:path");

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env($|[./-])/i,
  /(^|\/)\.ssh($|\/)/i,
  /(^|\/)(id_rsa|id_ed25519|known_hosts)$/i,
  /(^|\/).*\.(pem|key|p12|pfx)$/i,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/i,
  /(^|\/)(\.npmrc|\.pypirc|\.netrc)$/i
];

const DEFAULT_EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".turbo",
  ".cache", ".venv", "venv", "__pycache__", "target", "vendor"
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf",
  ".zip", ".gz", ".tar", ".tgz", ".rar", ".7z", ".exe", ".dll", ".so",
  ".dylib", ".class", ".jar", ".woff", ".woff2", ".ttf", ".otf", ".mp3",
  ".mp4", ".mov", ".avi", ".mkv", ".sqlite", ".db"
]);

function listWorkspaceDirectory(request, workspace) {
  const dir = normalizeDir(request.dir || "");
  const realWorkspace = fs.realpathSync(workspace.path);
  const absoluteDir = path.resolve(realWorkspace, dir);
  const realDir = fs.existsSync(absoluteDir) ? fs.realpathSync(absoluteDir) : absoluteDir;
  if (!isPathInside(realDir, realWorkspace)) {
    throw new Error("Requested directory escapes workspace.");
  }
  if (!fs.existsSync(realDir) || !fs.statSync(realDir).isDirectory()) {
    throw new Error("Requested workspace directory does not exist.");
  }

  const entries = fs.readdirSync(realDir, { withFileTypes: true })
    .map((entry) => toEntry(entry, dir, realDir))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
    .slice(0, 300);

  return {
    ok: true,
    type: "relai.workspaceList",
    workspace: workspace.alias,
    dir,
    parent: parentDir(dir),
    entries
  };
}

function toEntry(entry, dir, absoluteDir) {
  const rel = toPosixPath(path.join(dir, entry.name));
  if (!isSafeRelativePath(rel) || isSecretPath(rel)) {
    return null;
  }
  if (entry.isDirectory()) {
    if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) {
      return null;
    }
    return {
      type: "directory",
      name: entry.name,
      path: rel.endsWith("/") ? rel : `${rel}/`
    };
  }
  if (!entry.isFile()) {
    return null;
  }
  if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
    return null;
  }
  let size = 0;
  try {
    size = fs.statSync(path.join(absoluteDir, entry.name)).size;
  } catch (_error) {
    size = 0;
  }
  return {
    type: "file",
    name: entry.name,
    path: rel,
    size
  };
}

function normalizeDir(input) {
  const dir = String(input || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  if (!dir) {
    return "";
  }
  if (dir.startsWith("/") || dir.includes("..") || /^[A-Za-z]:[\/]/.test(dir)) {
    throw new Error("Workspace browser path must be relative and must not contain traversal.");
  }
  return dir.replace(/\/+$/g, "");
}

function parentDir(dir) {
  const clean = normalizeDir(dir);
  if (!clean) {
    return "";
  }
  const parts = clean.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function isSecretPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isSafeRelativePath(relativePath) {
  const file = String(relativePath || "").replace(/\\/g, "/");
  return Boolean(file)
    && !file.startsWith("/")
    && !file.startsWith("\\")
    && !file.includes("..")
    && !/^[A-Za-z]:[\/]/.test(file);
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPosixPath(input) {
  return String(input || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

module.exports = {
  listWorkspaceDirectory
};
