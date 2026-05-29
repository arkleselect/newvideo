const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const FALLBACK_HOST = "127.0.0.1";
const SESSION_COOKIE_NAME = "lan-video-session";
const ROOT_DIR = process.cwd();
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const UPLOAD_ROOT = path.join(ROOT_DIR, "uploads");
const OUTPUT_ROOT = path.join(ROOT_DIR, "exports");
const PASSLOG_ROOT = path.join(ROOT_DIR, ".ffmpeg-passlog");
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const AUDIO_CODEC = process.platform === "darwin" ? "aac_at" : "aac";
const VIDEO_PRESET = process.env.VIDEO_PRESET || "medium";
const X265_PARAMS = process.env.X265_PARAMS || "pass={pass}:stats={stats}:aq-mode=1:keyint=250:min-keyint=1";
const ENCODE_PROFILES = {
  tight: {
    key: "tight",
    label: "H.265 / HEVC",
    description: "视频流还是 HEVC，音频压得更低，体积更小。",
    videoCodec: "libx265",
    videoTag: "hvc1",
    videoBitrate: "31k",
    passParamName: "x265-params",
    audioBitrate: "16k"
  },
  compat: {
    key: "compat",
    label: "libx265 + hvc1 + AAC",
    description: "本质仍是 HEVC，但音频更宽松，体积会略大。",
    videoCodec: "libx265",
    videoTag: "hvc1",
    videoBitrate: "31k",
    passParamName: "x265-params",
    audioBitrate: "48k"
  },
  h264: {
    key: "h264",
    label: "H.264",
    description: "兼容性最好，但通常体积会更大。",
    videoCodec: "libx264",
    videoTag: "avc1",
    videoBitrate: "31k",
    passParamName: "x264-params",
    audioBitrate: "16k"
  }
};
const SUPPORTED_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"]);
const GENERATED_NAME_PATTERNS = [
  /^成品_/,
  /^output\.mp4$/i,
  /_h265_target788\.mp4$/i,
  /_h265_crf\d+_aac\d+k\.mp4$/i,
  /_av1_q\d+_aaccopy\.mp4$/i
];
const SAFE_UPLOAD_EXTENSIONS = SUPPORTED_EXTENSIONS;

const jobs = new Map();
const clientSchedulers = new Map();
let legacyMigrated = false;

function clampConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function getClientScheduler(clientId) {
  const safeClientId = normalizeClientId(clientId);
  if (!safeClientId) {
    throw new Error("Missing client id.");
  }

  let scheduler = clientSchedulers.get(safeClientId);
  if (!scheduler) {
    scheduler = {
      queue: [],
      activeJobId: null
    };
    clientSchedulers.set(safeClientId, scheduler);
  }
  return scheduler;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".avi") return "video/x-msvideo";
  if (ext === ".m4v") return "video/x-m4v";
  return "application/octet-stream";
}

function normalizeClientId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]{8,80}$/.test(trimmed)) return null;
  return trimmed;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== "string" || !cookieHeader.trim()) {
    return cookies;
  }

  for (const pair of cookieHeader.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }

  return cookies;
}

function getClientIdFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return normalizeClientId(cookies[SESSION_COOKIE_NAME]);
}

function setClientIdCookie(res, clientId) {
  const cookie = `${SESSION_COOKIE_NAME}=${clientId}; Path=/; HttpOnly; SameSite=Lax`;
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  const list = Array.isArray(existing) ? existing.slice() : [String(existing)];
  list.push(cookie);
  res.setHeader("Set-Cookie", list);
}

function ensureClientId(req, res) {
  const existing = getClientIdFromRequest(req);
  if (existing) return existing;

  const clientId = crypto.randomUUID();
  setClientIdCookie(res, clientId);
  return clientId;
}

function clientPaths(clientId) {
  const safeClientId = normalizeClientId(clientId);
  if (!safeClientId) {
    throw new Error("Missing client id.");
  }

  return {
    clientId: safeClientId,
    uploadDir: path.join(UPLOAD_ROOT, safeClientId),
    outputDir: path.join(OUTPUT_ROOT, safeClientId),
    passlogDir: path.join(PASSLOG_ROOT, safeClientId)
  };
}

async function ensureDirs() {
  await fsp.mkdir(UPLOAD_ROOT, { recursive: true });
  await fsp.mkdir(OUTPUT_ROOT, { recursive: true });
  await fsp.mkdir(PASSLOG_ROOT, { recursive: true });
}

async function ensureClientDirs(clientId) {
  const dirs = clientPaths(clientId);
  await fsp.mkdir(dirs.uploadDir, { recursive: true });
  await fsp.mkdir(dirs.outputDir, { recursive: true });
  await fsp.mkdir(dirs.passlogDir, { recursive: true });
  if (!legacyMigrated) {
    await migrateLegacyArtifactsToClient(clientId);
    legacyMigrated = true;
  }
  return dirs;
}

async function moveLegacyFiles(sourceDir, targetDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (sourceDir === UPLOAD_ROOT || sourceDir === OUTPUT_ROOT) {
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    try {
      await fsp.rename(sourcePath, targetPath);
    } catch (error) {
      if (error.code === "EXDEV") {
        await fsp.copyFile(sourcePath, targetPath);
        await fsp.unlink(sourcePath);
      } else if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function migrateLegacyArtifactsToClient(clientId) {
  const dirs = clientPaths(clientId);
  await moveLegacyFiles(UPLOAD_ROOT, dirs.uploadDir);
  await moveLegacyFiles(OUTPUT_ROOT, dirs.outputDir);
}

async function listSourceVideos(clientId) {
  const { uploadDir } = await ensureClientDirs(clientId);
  const files = [];

  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(uploadDir, entryPath).split(path.sep).join("/");
      const ext = path.posix.extname(relativePath).toLowerCase();
      const baseName = path.posix.basename(relativePath);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      if (GENERATED_NAME_PATTERNS.some((pattern) => pattern.test(baseName))) continue;

      const stats = await fsp.stat(entryPath);
      files.push({
        name: relativePath,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        folder: folderFromRelativePath(relativePath)
      });
    }
  }

  await walk(uploadDir);
  files.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return files;
}

function toClientJob(job) {
  return {
    id: job.id,
    clientId: job.clientId,
    profileKey: job.profileKey,
    profileLabel: job.profileLabel,
    concurrency: job.concurrency,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    sourceCleared: Boolean(job.sourceCleared),
    outputsCleared: Boolean(job.outputsCleared),
    files: job.files,
    currentIndex: job.currentIndex,
    currentFile: job.currentFile,
    currentFolder: job.currentFolder,
    currentFiles: job.currentFiles || [],
    currentFolders: job.currentFolders || [],
    stage: job.stage,
    progress: job.progress,
    logs: job.logs.slice(-10),
    results: job.results,
    errors: job.errors
  };
}

function serveDownload(res, filePath, downloadName) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (statError, stats) => {
      if (statError) {
        reject(statError);
        return;
      }

      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${downloadName}"`,
        "Content-Length": stats.size
      });

      const stream = fs.createReadStream(filePath);
      stream.on("error", fail);
      res.on("close", () => {
        stream.destroy();
        finish();
      });
      stream.on("end", finish);
      stream.pipe(res);
    });
  });
}

function pushLog(job, message) {
  job.logs.push(`${new Date().toLocaleTimeString()} ${message}`);
  if (job.logs.length > 200) {
    job.logs = job.logs.slice(-200);
  }
  job.updatedAt = Date.now();
}

function updateJobProgress(job) {
  if (!job.fileStates || !job.fileStates.length) {
    return;
  }

  const total = job.fileStates.reduce((sum, fileState) => sum + Math.max(0, Math.min(100, fileState.progress || 0)), 0);
  job.progress = Math.max(0, Math.min(100, Number((total / job.fileStates.length).toFixed(2))));
  job.updatedAt = Date.now();
}

function percentageFor(index, total, partial) {
  const completed = (index + partial) / total;
  return Math.max(0, Math.min(100, Number((completed * 100).toFixed(2))));
}

function sanitizeBaseName(name) {
  return name.replace(/[^\p{L}\p{N}\-_]+/gu, "_");
}

function folderFromRelativePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return "根目录";
  const dir = path.posix.dirname(normalized);
  return dir === "." ? "根目录" : dir;
}

function sanitizePathSegment(name) {
  const cleaned = String(name)
    .replace(/[\/\\]+/g, "_")
    .replace(/[^\p{L}\p{N}\-_ .]+/gu, "_")
    .trim();
  return cleaned || "file";
}

function normalizeRelativePath(inputPath) {
  if (typeof inputPath !== "string") return null;
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/").trim());
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    return null;
  }

  const segments = normalized.split("/").filter(Boolean).map(sanitizePathSegment);
  if (!segments.length) return null;
  return segments.join("/");
}

function encodeUrlPath(relativePath) {
  return String(relativePath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getLanAddresses() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeRequestBodyToFile(req, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath, { flags: "wx" });
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      fsp.unlink(filePath).catch(() => {});
      reject(error);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    req.on("error", fail);
    out.on("error", fail);
    out.on("finish", done);
    req.pipe(out);
  });
}

async function serveStatic(req, res, filePath) {
  try {
    const stats = await fsp.stat(filePath);
    const range = req.headers.range;

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", mimeType(filePath));

    if (!range) {
      res.writeHead(200, { "Content-Length": stats.size });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
      res.end();
      return;
    }

    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stats.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= stats.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stats.size}`
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } catch (error) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe exited with code ${code}`));
        return;
      }
      const duration = Number(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error("Unable to read video duration."));
        return;
      }
      resolve(duration);
    });
  });
}

async function runFfmpegPass({ job, args, duration, onProgress }) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let lastProgress = 0;

    if (job) {
      job.currentProcesses = job.currentProcesses || new Set();
      job.currentProcesses.add(proc);
    }

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      const matches = [...text.matchAll(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/g)];
      if (!matches.length) return;

      const match = matches[matches.length - 1];
      const seconds =
        Number(match[1]) * 3600 +
        Number(match[2]) * 60 +
        Number(match[3]);
      const progress = Math.max(0, Math.min(1, seconds / duration));
      if (progress > lastProgress) {
        lastProgress = progress;
        onProgress(progress);
      }
    });

    proc.on("close", (code) => {
      if (job && job.currentProcesses) {
        job.currentProcesses.delete(proc);
      }
      if (code === null) {
        const error = new Error("Job canceled.");
        error.code = "ABORT_ERR";
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        return;
      }
      onProgress(1);
      resolve();
    });
  });
}

async function cleanupPassLogs(passBase) {
  const files = [passBase, `${passBase}.cutree`, `${passBase}.temp`, `${passBase}.log`];
  await Promise.all(
    files.map(async (file) => {
      try {
        await fsp.unlink(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    })
  );
}

async function clearDirectory(dirPath) {
  await fsp.rm(dirPath, { recursive: true, force: true });
  await fsp.mkdir(dirPath, { recursive: true });
}

async function createJobArchive(job) {
  const archiveName = `job-${job.id}.zip`;
  const archivePath = path.join(os.tmpdir(), `job-${job.id}-${crypto.randomUUID()}.zip`);
  const dirs = clientPaths(job.clientId);
  const isWindows = process.platform === "win32";
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const windowsScript = `& { Compress-Archive -Force -Path (Join-Path ${psQuote(dirs.outputDir)} '*') -DestinationPath ${psQuote(archivePath)} }`;

  await new Promise((resolve, reject) => {
    const proc = isWindows
      ? spawn("powershell.exe", ["-NoProfile", "-Command", windowsScript], {
          stdio: ["ignore", "ignore", "pipe"]
        })
      : spawn("zip", ["-r", "-q", archivePath, "."], {
          cwd: dirs.outputDir,
          stdio: ["ignore", "ignore", "pipe"]
        });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      reject(error.code === "ENOENT"
        ? new Error(isWindows ? "PowerShell Compress-Archive is unavailable." : "zip command is unavailable.")
        : error);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `zip exited with code ${code}`));
        return;
      }
      resolve();
    });
  });

  return { archivePath, archiveName };
}

async function clearJobSourceFiles(job) {
  const dirs = clientPaths(job.clientId);
  let clearedCount = 0;
  for (const fileName of job.files || []) {
    try {
      await fsp.unlink(path.join(dirs.uploadDir, fileName));
      clearedCount += 1;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  job.sourceCleared = true;
  pushLog(job, `Cleared ${clearedCount} uploaded source file(s).`);
  return clearedCount;
}

async function clearJobOutputs(job) {
  const dirs = clientPaths(job.clientId);
  let clearedCount = 0;
  for (const item of job.results || []) {
    try {
      await fsp.unlink(path.join(dirs.outputDir, item.outputName));
      clearedCount += 1;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await clearDirectory(dirs.passlogDir);
  job.outputsCleared = true;
  pushLog(job, `Cleared ${clearedCount} exported video(s).`);
  return clearedCount;
}

async function clearClientUploads(clientId) {
  const dirs = clientPaths(clientId);
  await clearDirectory(dirs.uploadDir);
}

async function clearClientOutputs(clientId) {
  const dirs = clientPaths(clientId);
  await clearDirectory(dirs.outputDir);
  await clearDirectory(dirs.passlogDir);
}

function killJobProcess(job) {
  for (const proc of job.currentProcesses || []) {
    if (proc && !proc.killed) {
      proc.kill();
    }
  }
}

function requestJobCancel(job) {
  if (!job) return false;
  if (job.status !== "queued" && job.status !== "running") return false;

  job.cancelRequested = true;
  job.stage = "canceling";
  job.updatedAt = Date.now();
  pushLog(job, "Cancel requested.");

  if (job.status === "queued") {
    const scheduler = getClientScheduler(job.clientId);
    const nextIndex = scheduler.queue.indexOf(job.id);
    if (nextIndex !== -1) {
      scheduler.queue.splice(nextIndex, 1);
    }
    job.status = "canceled";
    job.stage = "canceled";
    job.progress = Math.min(job.progress, 100);
    job.currentFile = null;
    pushLog(job, "Job canceled before start.");
    return true;
  }

  killJobProcess(job);
  return true;
}

async function makeUniqueFilenameInDir(fileName, dirPath) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = fileName;
  let counter = 1;

  while (true) {
    try {
      await fsp.access(path.join(dirPath, candidate));
      candidate = `${base}_${counter}${ext}`;
      counter += 1;
    } catch (error) {
      if (error.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
}

async function makeUniqueRelativePathInDir(relativePath, dirPath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    throw new Error("Missing relative path.");
  }

  const ext = path.posix.extname(normalized);
  const base = path.posix.basename(normalized, ext);
  const dir = path.posix.dirname(normalized);
  let candidate = normalized;
  let counter = 1;

  while (true) {
    try {
      await fsp.access(path.join(dirPath, candidate));
      const nextName = `${base}_${counter}${ext}`;
      candidate = dir === "." ? nextName : `${dir}/${nextName}`;
      counter += 1;
    } catch (error) {
      if (error.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
}

async function makeUniqueFilename(fileName) {
  return makeUniqueFilenameInDir(fileName, UPLOAD_ROOT);
}

async function compressFile(job, fileName, fileIndex) {
  const dirs = clientPaths(job.clientId);
  const inputPath = path.join(dirs.uploadDir, fileName);
  const normalizedInput = normalizeRelativePath(fileName);
  const ext = path.posix.extname(normalizedInput || fileName);
  const baseName = path.posix.basename(normalizedInput || fileName, ext);
  const safeBase = sanitizeBaseName((normalizedInput || fileName).replace(/[\/\\]/g, "_"));
  const outputName = await makeUniqueRelativePathInDir(normalizedInput || fileName, dirs.outputDir);
  const outputPath = path.join(dirs.outputDir, outputName);
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const passBaseFs = path.join(dirs.passlogDir, `${safeBase}_${job.id}`);
  const passBase = path
    .relative(ROOT_DIR, passBaseFs)
    .split(path.sep)
    .join("/");
  const duration = await probeDuration(inputPath);
  const profile = ENCODE_PROFILES[job.profileKey] || ENCODE_PROFILES.tight;
  const pass1Params = X265_PARAMS.replace("{pass}", "1").replace("{stats}", passBase);
  const pass2Params = X265_PARAMS.replace("{pass}", "2").replace("{stats}", passBase);
  const passParamName = profile.passParamName || "x265-params";
  const firstPassParams = profile.videoCodec === "libx264"
    ? `pass=1:stats=${passBase}:keyint=250:min-keyint=1:scenecut=40`
    : pass1Params;
  const secondPassParams = profile.videoCodec === "libx264"
    ? `pass=2:stats=${passBase}:keyint=250:min-keyint=1:scenecut=40`
    : pass2Params;
  const sourceFolder = folderFromRelativePath(fileName);
  const updateFileState = (progress, status) => {
    if (!job.fileStates || !job.fileStates[fileIndex]) return;
    job.fileStates[fileIndex].progress = Math.max(0, Math.min(100, Number(progress.toFixed(2))));
    if (status) {
      job.fileStates[fileIndex].status = status;
    }
    updateJobProgress(job);
  };

  try {
    pushLog(job, `Compressing ${fileName}.`);
    job.stage = "processing";
    updateFileState(5, "running");

    await runFfmpegPass({
      job,
      args: [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-c:v",
        profile.videoCodec,
        "-preset",
        VIDEO_PRESET,
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        profile.videoTag,
        "-b:v",
        profile.videoBitrate,
        `-${passParamName}`,
        firstPassParams,
        "-an",
        "-f",
        "mp4",
        NULL_DEVICE
      ],
      duration,
      onProgress: (value) => {
        updateFileState(value * 45, "running");
      }
    });

    if (job.cancelRequested) {
      const error = new Error("Job canceled.");
      error.code = "ABORT_ERR";
      throw error;
    }

    pushLog(job, `${fileName} pass 1 complete.`);
    job.stage = "processing";
    updateFileState(50, "running");

    await runFfmpegPass({
      job,
      args: [
        "-y",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c:v",
        profile.videoCodec,
        "-preset",
        VIDEO_PRESET,
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        profile.videoTag,
        "-b:v",
        profile.videoBitrate,
        `-${passParamName}`,
        secondPassParams,
        "-c:a",
        AUDIO_CODEC,
        "-b:a",
        profile.audioBitrate,
        "-ac",
        "1",
        "-ar",
        "24000",
        "-movflags",
        "+faststart",
        outputPath
      ],
      duration,
      onProgress: (value) => {
        updateFileState(50 + value * 50, "running");
      }
    });

    if (job.cancelRequested) {
      const error = new Error("Job canceled.");
      error.code = "ABORT_ERR";
      throw error;
    }

    const stats = await fsp.stat(outputPath);
    job.results.push({
      source: fileName,
      folder: sourceFolder,
      outputName,
      outputPath: `/exports/${encodeURIComponent(job.clientId)}/${encodeUrlPath(outputName)}`,
      size: stats.size
    });
    pushLog(job, `${fileName} exported as ${outputName}.`);
    updateFileState(100, "done");
  } finally {
    if (!job.results.some((item) => item.outputName === outputName)) {
      await fsp.unlink(outputPath).catch(() => {});
    }
    await cleanupPassLogs(passBaseFs);
  }
}

async function runJobFiles(job) {
  const concurrency = clampConcurrency(job.concurrency || 1);
  let cursor = 0;
  let fatalError = null;

  job.fileStates = job.files.map((fileName) => ({
    fileName,
    folder: folderFromRelativePath(fileName),
    status: "queued",
    progress: 0
  }));
  job.currentFiles = [];
  job.currentFolders = [];
  job.currentFile = null;
  job.currentFolder = null;
  job.currentIndex = 0;
  job.progress = 0;
  job.stage = "preparing";
  job.status = "running";
  pushLog(job, `Job started with concurrency ${concurrency}.`);

  const markRunningFiles = () => {
    job.currentFiles = job.fileStates
      .filter((item) => item.status === "running")
      .map((item) => item.fileName);
    job.currentFolders = Array.from(new Set(
      job.fileStates.filter((item) => item.status === "running").map((item) => item.folder)
    ));
    job.currentFile = job.currentFiles[0] || null;
    job.currentFolder = job.currentFolders[0] || null;
    job.updatedAt = Date.now();
  };

  const worker = async () => {
    while (!job.cancelRequested) {
      const fileIndex = cursor;
      cursor += 1;
      if (fileIndex >= job.files.length) {
        return;
      }

      const fileName = job.files[fileIndex];
      if (job.fileStates[fileIndex]) {
        job.fileStates[fileIndex].status = "running";
        job.fileStates[fileIndex].progress = Math.max(job.fileStates[fileIndex].progress, 1);
        job.currentIndex = fileIndex;
        markRunningFiles();
        updateJobProgress(job);
      }

      try {
        await compressFile(job, fileName, fileIndex);
      } catch (error) {
        if (error && error.code !== "ABORT_ERR" && !job.cancelRequested) {
          fatalError = error;
          job.cancelRequested = true;
          job.stage = "failed";
          killJobProcess(job);
        }
        throw error;
      } finally {
        markRunningFiles();
      }
    }
  };

  try {
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.allSettled(workers);
    if (fatalError) {
      throw fatalError;
    }
    if (job.cancelRequested) {
      const error = new Error("Job canceled.");
      error.code = "ABORT_ERR";
      throw error;
    }
    job.status = "completed";
    job.stage = "done";
    job.progress = 100;
    job.currentFiles = [];
    job.currentFolders = [];
    job.currentFile = null;
    job.currentFolder = null;
    pushLog(job, "Job completed.");
  } catch (error) {
    if (fatalError) {
      job.status = "failed";
      job.stage = "failed";
      job.currentFiles = [];
      job.currentFolders = [];
      job.currentFile = null;
      job.currentFolder = null;
      job.errors.push(String(fatalError.message || fatalError));
      pushLog(job, `Job failed: ${String(fatalError.message || fatalError)}`);
    } else if (error && (error.code === "ABORT_ERR" || job.cancelRequested)) {
      job.status = "canceled";
      job.stage = "canceled";
      job.currentFiles = [];
      job.currentFolders = [];
      job.currentFile = null;
      job.currentFolder = null;
      job.progress = Math.min(job.progress, 100);
      pushLog(job, "Job canceled.");
    } else {
      job.status = "failed";
      job.stage = "failed";
      job.currentFiles = [];
      job.currentFolders = [];
      job.currentFile = null;
      job.currentFolder = null;
      job.errors.push(String(error.message || error));
      pushLog(job, `Job failed: ${String(error.message || error)}`);
    }
  } finally {
    job.updatedAt = Date.now();
    job.currentProcesses = null;
    job.currentFiles = job.currentFiles || [];
    job.currentFolders = job.currentFolders || [];
  }
}

async function processClientQueue(clientId) {
  const scheduler = getClientScheduler(clientId);
  if (scheduler.activeJobId) return;

  const nextId = scheduler.queue.shift();
  if (!nextId) return;

  scheduler.activeJobId = nextId;
  const job = jobs.get(nextId);

  if (!job) {
    scheduler.activeJobId = null;
    processClientQueue(clientId).catch(console.error);
    return;
  }

  try {
    await runJobFiles(job);
  } finally {
    scheduler.activeJobId = null;
    processClientQueue(clientId).catch(console.error);
  }
}

async function handleApi(req, res, pathname, clientId) {
  if (!pathname.startsWith("/api/")) {
    return false;
  }

  if (!clientId) {
    sendJson(res, 400, { error: "Missing client id." });
    return true;
  }
  const dirs = await ensureClientDirs(clientId);

  if (pathname === "/api/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, clientId });
    return true;
  }

  if (pathname === "/api/upload" && req.method === "PUT") {
    try {
      const rawName = req.headers["x-filename"];
      if (typeof rawName !== "string" || !rawName.trim()) {
        sendJson(res, 400, { error: "Missing x-filename header." });
        return true;
      }

      let decodedName = rawName;
      try {
        decodedName = decodeURIComponent(rawName);
      } catch (_) {
        decodedName = rawName;
      }

      const baseName = path.basename(decodedName);
      const ext = path.extname(baseName).toLowerCase();
      if (!SAFE_UPLOAD_EXTENSIONS.has(ext)) {
        sendJson(res, 400, { error: "Unsupported file type." });
        return true;
      }

      const rawRelativePath = typeof req.headers["x-relative-path"] === "string" ? req.headers["x-relative-path"] : baseName;
      const decodedRelativePath = (() => {
        try {
          return decodeURIComponent(rawRelativePath);
        } catch {
          return rawRelativePath;
        }
      })();
      const relativePath = normalizeRelativePath(decodedRelativePath || baseName);
      if (!relativePath) {
        sendJson(res, 400, { error: "Missing relative path." });
        return true;
      }

      const uniqueName = await makeUniqueRelativePathInDir(relativePath, dirs.uploadDir);
      const filePath = path.join(dirs.uploadDir, uniqueName);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await writeRequestBodyToFile(req, filePath);
      const stats = await fsp.stat(filePath);
      sendJson(res, 201, { name: uniqueName, size: stats.size });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return true;
  }

  if (pathname === "/api/uploads/clear" && req.method === "POST") {
    try {
      await clearClientUploads(clientId);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return true;
  }

  if (pathname === "/api/files" && req.method === "GET") {
    try {
      const files = await listSourceVideos(clientId);
      sendJson(res, 200, { files });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return true;
  }

  if (pathname === "/api/jobs" && req.method === "GET") {
    const items = Array.from(jobs.values())
      .filter((job) => job.clientId === clientId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toClientJob);
    sendJson(res, 200, { jobs: items });
    return true;
  }

  if (pathname.startsWith("/api/jobs/") && req.method === "GET") {
    const jobId = pathname.slice("/api/jobs/".length);
    if (jobId.endsWith("/archive")) {
      const pureJobId = jobId.slice(0, -"/archive".length);
      const job = jobs.get(pureJobId);
      if (!job || job.clientId !== clientId) {
        sendJson(res, 404, { error: "Job not found." });
        return true;
      }
      if (!job.results.length) {
        sendJson(res, 400, { error: "No completed videos are available for download." });
        return true;
      }

      const archive = await createJobArchive(job);
      try {
        await serveDownload(res, archive.archivePath, archive.archiveName);
      } finally {
        fsp.unlink(archive.archivePath).catch(() => {});
      }
      return true;
    }
    const job = jobs.get(jobId);
    if (!job || job.clientId !== clientId) {
      sendJson(res, 404, { error: "Job not found." });
      return true;
    }
    sendJson(res, 200, { job: toClientJob(job) });
    return true;
  }

  if (pathname.startsWith("/api/jobs/") && pathname.endsWith("/clear") && req.method === "POST") {
    const jobId = pathname.slice("/api/jobs/".length, -"/clear".length);
    const job = jobs.get(jobId);
    if (!job || job.clientId !== clientId) {
      sendJson(res, 404, { error: "Job not found." });
      return true;
    }
    if (job.status === "running" || job.status === "queued") {
      sendJson(res, 409, { error: "Job is still running." });
      return true;
    }

    try {
      await clearJobOutputs(job);
      const clearedCount = await clearJobSourceFiles(job);
      job.results = [];
      job.currentFile = null;
      sendJson(res, 200, { job: toClientJob(job), clearedCount });
    } catch (error) {
      sendJson(res, 500, { error: String(error.message || error) });
    }
    return true;
  }

  if (pathname.startsWith("/api/jobs/") && pathname.endsWith("/cancel") && req.method === "POST") {
    const jobId = pathname.slice("/api/jobs/".length, -"/cancel".length);
    const job = jobs.get(jobId);
    if (!job || job.clientId !== clientId) {
      sendJson(res, 404, { error: "Job not found." });
      return true;
    }
    if (!requestJobCancel(job)) {
      sendJson(res, 409, { error: "Job cannot be canceled." });
      return true;
    }

    sendJson(res, 200, { job: toClientJob(job) });
    return true;
  }

  if (pathname === "/api/jobs" && req.method === "POST") {
    try {
      const body = await getRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const selectedFiles = Array.isArray(parsed.files) ? parsed.files : [];
      const concurrency = clampConcurrency(parsed.concurrency || 1);
      const profileKey = ENCODE_PROFILES[parsed.profile]?.key || "tight";
      const profile = ENCODE_PROFILES[profileKey] || ENCODE_PROFILES.tight;
      const available = await listSourceVideos(clientId);
      const availableSet = new Set(available.map((item) => item.name));
      const files = selectedFiles.length
        ? selectedFiles.filter((name) => availableSet.has(name))
        : available.map((item) => item.name);

      if (!files.length) {
        sendJson(res, 400, { error: "No valid source videos were found." });
        return true;
      }

      const job = {
        id: crypto.randomUUID(),
        clientId,
        status: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        profileKey,
        profileLabel: profile.label,
        concurrency,
        sourceCleared: false,
        files,
        currentIndex: 0,
        currentFile: null,
        currentFiles: [],
        stage: "queued",
        progress: 0,
        fileStates: [],
        logs: [],
        results: [],
        errors: []
      };

      jobs.set(job.id, job);
      const scheduler = getClientScheduler(clientId);
      scheduler.queue.push(job.id);
      processClientQueue(clientId).catch(console.error);

      sendJson(res, 201, { job: toClientJob(job) });
    } catch (error) {
      sendJson(res, 400, { error: String(error.message || error) });
    }
    return true;
  }

  return false;
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");

  if (pathname.startsWith("/api/")) {
    const clientId = ensureClientId(req, res);
    if (await handleApi(req, res, pathname, clientId)) return;
  }

  if (pathname === "/" && req.method === "GET") {
    ensureClientId(req, res);
    await serveStatic(req, res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  if (pathname.startsWith("/app/") && req.method === "GET") {
    const filePath = path.resolve(PUBLIC_DIR, pathname.slice("/app/".length));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    await serveStatic(req, res, filePath);
    return;
  }

  if (pathname.startsWith("/exports/") && req.method === "GET") {
    const clientId = ensureClientId(req, res);
    const relative = pathname.slice("/exports/".length);
    const requestedClientId = normalizeClientId(relative.split("/")[0]);
    if (requestedClientId !== clientId) {
      sendText(res, 403, "Forbidden");
      return;
    }
    const filePath = path.resolve(OUTPUT_ROOT, relative);
    if (!filePath.startsWith(OUTPUT_ROOT + path.sep)) {
      sendText(res, 403, "Forbidden");
      return;
    }
    await serveStatic(req, res, filePath);
    return;
  }

  sendText(res, 404, "Not found");
}

async function start() {
  await ensureDirs();
  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: String(error.message || error) });
      } else {
        res.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    const startListen = (host) => {
      server.removeAllListeners("error");
      server.once("error", (error) => {
        if (error.code === "EPERM" && host !== FALLBACK_HOST) {
          console.warn(`Binding ${host}:${PORT} failed, retrying on ${FALLBACK_HOST}:${PORT}.`);
          startListen(FALLBACK_HOST);
          return;
        }
        reject(error);
      });

      server.listen(PORT, host, () => {
        if (host === FALLBACK_HOST) {
          console.log(`Server listening on http://${FALLBACK_HOST}:${PORT}`);
        } else {
          const addresses = getLanAddresses();
          console.log(`Server listening on http://${host}:${PORT}`);
          for (const address of addresses) {
            console.log(`LAN access: http://${address}:${PORT}`);
          }
        }
        resolve();
      });
    };

    startListen(HOST);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
