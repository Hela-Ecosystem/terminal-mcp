import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);
const RTK_VERSION = "1.2.0";
const RELEASE_BASE = `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}`;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 30_000;

type RtkAsset = {
  archive: string;
  checksum: string;
  windowsZip: boolean;
};

const ASSETS: Record<string, RtkAsset> = {
  "oss:linux:x64": {
    archive: "rtk-oss-x86_64-unknown-linux-musl.tar.gz",
    checksum: "a28407dc13038bdc9c2a1f5a047b0c636e0c1d495b15523576e2adb992a06a17",
    windowsZip: false,
  },
  "oss:linux:arm64": {
    archive: "rtk-oss-aarch64-unknown-linux-musl.tar.gz",
    checksum: "9786c61dbbea704e1468ee7060930d3b45b67f79ba2babfb73463e85340628d9",
    windowsZip: false,
  },
  "oss:darwin:x64": {
    archive: "rtk-oss-x86_64-apple-darwin.tar.gz",
    checksum: "48f8cee63ae0b4853f9a77d7839e62ffcca18ef88c408f8a93d4e69986b1ab82",
    windowsZip: false,
  },
  "oss:darwin:arm64": {
    archive: "rtk-oss-aarch64-apple-darwin.tar.gz",
    checksum: "1959bd6d89a729ccdee176b7141490bbe750820f032c74f29a752576f2495254",
    windowsZip: false,
  },
  "oss:win32:x64": {
    archive: "rtk-oss-x86_64-pc-windows-msvc.zip",
    checksum: "d105aaaa55822252f04ac28989e9069c1ea61755ca561940d887cb0b89c785fc",
    windowsZip: true,
  },
  "full:linux:x64": {
    archive: "rtk-x86_64-unknown-linux-musl.tar.gz",
    checksum: "70fee7b4a548c43dde94c77e2335550981b0bc2fb013691d8c8109b5bd0eda37",
    windowsZip: false,
  },
  "full:linux:arm64": {
    archive: "rtk-aarch64-unknown-linux-musl.tar.gz",
    checksum: "f91a06e94e5fad7dfa87946c811a4bcbc500e6da119fd47033f2a8940bf64f93",
    windowsZip: false,
  },
  "full:darwin:x64": {
    archive: "rtk-x86_64-apple-darwin.tar.gz",
    checksum: "1484ae6fffd0da180d65434eeca32e014a86a6e21dcfc7a0004fe82b7bb0a9b9",
    windowsZip: false,
  },
  "full:darwin:arm64": {
    archive: "rtk-aarch64-apple-darwin.tar.gz",
    checksum: "a2c411ffa49a8595b408c151ea47c9a812268924a76eaeecbc3a5065b02207ff",
    windowsZip: false,
  },
  "full:win32:x64": {
    archive: "rtk-x86_64-pc-windows-msvc.zip",
    checksum: "b291b4e53d37f84b7f1696bc20559207396fb0190f20ed3c949db1b7e1c0c378",
    windowsZip: true,
  },
};

let cachedRtkBinary: string | null | undefined;
let installPromise: Promise<string | null> | null = null;

function autoInstallEnabled(): boolean {
  return !["0", "false", "no", "off"].includes((process.env.RTK_AUTO_INSTALL ?? "true").toLowerCase());
}

function edition(): "oss" | "full" {
  return process.env.RTK_EDITION?.toLowerCase() === "full" ? "full" : "oss";
}

function platformKey(): string | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) return null;
  if (process.platform === "linux" || process.platform === "darwin") return `${process.platform}:${arch}`;
  if (process.platform === "win32") return "win32:x64";
  return null;
}

function assetForCurrentPlatform(): RtkAsset | null {
  const key = platformKey();
  return key ? ASSETS[`${edition()}:${key}`] ?? null : null;
}

export function getManagedRtkPath(): string {
  const installDirectory = process.env.RTK_INSTALL_DIR?.trim()
    || (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Hela", "rtk", "bin")
      : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "hela", "rtk", "bin"));
  return path.join(installDirectory, process.platform === "win32" ? "rtk.exe" : "rtk");
}

async function probe(binary: string): Promise<boolean> {
  try {
    await execFileAsync(binary, ["--version"], { timeout: 1500, maxBuffer: 16 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function findExistingRtk(): Promise<string | null> {
  const candidates = [process.env.RTK_BIN?.trim(), getManagedRtkPath(), "rtk"]
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of [...new Set(candidates)]) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_ARCHIVE_BYTES) throw new Error("download exceeds the RTK archive size limit");
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_ARCHIVE_BYTES) throw new Error("download has an invalid size");
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function isUnsafeArchiveEntry(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..");
}

async function extractArchive(archive: string, destination: string, windowsZip: boolean): Promise<void> {
  const listArgs = windowsZip ? ["-tf", archive] : ["-tzf", archive];
  const extractArgs = windowsZip ? ["-xf", archive, "-C", destination] : ["-xzf", archive, "-C", destination];
  const { stdout } = await execFileAsync("tar", listArgs, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 512 * 1024 });
  if (stdout.split(/\r?\n/).filter(Boolean).some(isUnsafeArchiveEntry)) {
    throw new Error("RTK archive contains an unsafe path");
  }
  await execFileAsync("tar", extractArgs, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 });
}

async function findExtractedBinary(root: string): Promise<string> {
  const expectedName = process.platform === "win32" ? "rtk.exe" : "rtk";
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === expectedName) {
        return candidate;
      }
    }
  }
  throw new Error("RTK executable was not found in the downloaded archive");
}

async function installManagedRtk(): Promise<string | null> {
  const asset = assetForCurrentPlatform();
  if (!asset) {
    log.warn(`RTK auto-install is not supported on ${process.platform}/${process.arch}`);
    return null;
  }

  const target = getManagedRtkPath();
  const targetDirectory = path.dirname(target);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hela-rtk-install-"));
  try {
    await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const archive = path.join(temporaryRoot, asset.archive);
    const data = await download(`${RELEASE_BASE}/${asset.archive}`);
    const actualChecksum = createHash("sha256").update(data).digest("hex");
    if (actualChecksum !== asset.checksum) throw new Error("RTK checksum verification failed");
    await fs.writeFile(archive, data, { mode: 0o600 });
    const extracted = path.join(temporaryRoot, "extracted");
    await fs.mkdir(extracted, { mode: 0o700 });
    await extractArchive(archive, extracted, asset.windowsZip);
    const binary = await findExtractedBinary(extracted);
    const staged = path.join(targetDirectory, `.rtk-${process.pid}-${Date.now()}${process.platform === "win32" ? ".exe" : ""}`);
    await fs.copyFile(binary, staged);
    if (process.platform !== "win32") await fs.chmod(staged, 0o755);
    await fs.rename(staged, target);
    if (!await probe(target)) throw new Error("installed RTK binary failed its version check");
    log.info(`Installed RTK ${RTK_VERSION} (${edition()}) at ${target}`);
    return target;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function getRtkBinary(): Promise<string | null> {
  if (cachedRtkBinary !== undefined) return cachedRtkBinary;
  const existing = await findExistingRtk();
  if (existing) {
    cachedRtkBinary = existing;
    return existing;
  }
  if (!autoInstallEnabled()) {
    cachedRtkBinary = null;
    return null;
  }
  if (!installPromise) {
    installPromise = installManagedRtk().catch((error: unknown) => {
      log.warn(`RTK auto-install unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  cachedRtkBinary = await installPromise;
  return cachedRtkBinary;
}

export function resetRtkCacheForTests(): void {
  cachedRtkBinary = undefined;
  installPromise = null;
}
