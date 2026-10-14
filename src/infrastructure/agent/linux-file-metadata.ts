import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface LinuxFileMetadata {
  mode: number;
  uid: number;
  gid: number;
  atimeNs: string;
  mtimeNs: string;
  identity: string;
  changeIdentity: string;
}

export const METADATA_LIMITATION = "Managed files preserve ordinary Linux ownership and permissions; caller-visible xattrs/ACLs/security labels and unsupported filesystem flags are refused. Linux hides trusted.* xattrs from unprivileged users: their absence cannot be verified. This is not an OS sandbox.";

const SCRIPT = String.raw`
import os, sys, stat, json, fcntl, array, struct
fd = 3

def inspect():
    s = os.fstat(fd)
    if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):
        raise RuntimeError("Unsupported metadata: not a regular file/directory")
    if os.listxattr(fd):
        raise RuntimeError("Unsupported metadata: caller-visible xattrs/ACLs/security labels")
    flags = array.array('L', [0])
    fcntl.ioctl(fd, 0x80086601, flags, True)
    allowed = 0x80000 | (0x1000 if stat.S_ISDIR(s.st_mode) else 0)
    if flags[0] & ~allowed:
        raise RuntimeError("Unsupported metadata: filesystem flags")
    fsx = bytearray(28)
    fcntl.ioctl(fd, 0x801c581f, fsx, True)
    xflags, extsize, nextents, projid, cowextsize = struct.unpack_from('=IIIII', fsx)
    if xflags or extsize or projid or cowextsize:
        raise RuntimeError("Unsupported metadata: filesystem project/allocation policy")
    identity = ':'.join(str(v) for v in (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size, s.st_mtime_ns))
    return dict(mode=s.st_mode, uid=s.st_uid, gid=s.st_gid, atimeNs=str(s.st_atime_ns), mtimeNs=str(s.st_mtime_ns), identity=identity, changeIdentity=identity+':'+str(s.st_ctime_ns))

try:
    inspect()
    creating = len(sys.argv) > 1 and sys.argv[1] == 'create'
    if creating:
        fd = os.open('.', os.O_TMPFILE | os.O_RDWR | os.O_CLOEXEC, 0o666, dir_fd=fd)
        inspect()
    desired_arg = sys.argv[2] if creating and len(sys.argv) > 2 else sys.argv[1] if not creating and len(sys.argv) > 1 else None
    if desired_arg is not None:
        desired = json.loads(desired_arg)
        s = os.fstat(fd)
        if (s.st_uid, s.st_gid) != (desired['uid'], desired['gid']):
            os.fchown(fd, desired['uid'], desired['gid'])
        os.fchmod(fd, desired['mode'] & 0o7777)
        s = os.fstat(fd)
        os.utime(fd, ns=(int(desired.get('atimeNs', s.st_atime_ns)), int(desired.get('mtimeNs', s.st_mtime_ns))))
    result = inspect()
    if desired_arg is not None and any(result[k] != desired[k] for k in desired):
        raise RuntimeError("Exact metadata preservation could not be verified")
    print(json.dumps(result))
except Exception as error:
    print('Linux metadata inspection/preservation failed: '+str(error), file=sys.stderr)
    sys.exit(1)
`;

type DesiredMetadata = Pick<LinuxFileMetadata, "uid" | "gid" | "mode"> & Partial<Pick<LinuxFileMetadata, "atimeNs" | "mtimeNs">>;

async function trustedPython(): Promise<string> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Managed metadata requires 64-bit Linux.");
  const executable = await realpath("/usr/bin/python3");

  if (path.dirname(executable) !== "/usr/bin") throw new Error("Untrusted system Python location.");

  for (const item of ["/", "/usr", "/usr/bin", executable]) {
    const info = await stat(item);

    if (info.uid !== 0 || (info.mode & 0o022) !== 0 || (item === executable ? !info.isFile() : !info.isDirectory())) throw new Error("System Python and its ancestors must be root-owned and not group/world-writable.");
  }

  return executable;
}

export async function inspectLinuxMetadata(file: FileHandle, desired?: DesiredMetadata, creation = false): Promise<LinuxFileMetadata> {
  const executable = await trustedPython();

  const metadata = await new Promise<LinuxFileMetadata>((resolve, reject) => {
    const child = spawn(executable, ["-I", "-S", "-c", SCRIPT, ...(creation ? ["create", ...(desired ? [JSON.stringify(desired)] : [])] : desired ? [JSON.stringify(desired)] : [])], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe", file.fd],
    });

    let output = ""; let errorOutput = ""; let bytes = 0; let done = false;

    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      child.stdout!.destroy(); child.stderr!.destroy();

      if (error) { child.kill("SIGKILL"); reject(error);

 return; }

      try {
        const value = JSON.parse(output) as LinuxFileMetadata;

        if (![value.mode, value.uid, value.gid].every(Number.isSafeInteger)
          || ![value.atimeNs, value.mtimeNs].every((item) => typeof item === "string" && /^\d+$/.test(item))
          || typeof value.identity !== "string" || !/^\d+(?::\d+){6}$/.test(value.identity)
          || typeof value.changeIdentity !== "string" || !/^\d+(?::\d+){7}$/.test(value.changeIdentity)
          || !value.changeIdentity.startsWith(`${value.identity}:`)) throw new Error("Invalid metadata helper response");
        resolve(value);
      } catch (error) { reject(error); }
    };

    const timer = setTimeout(() => finish(new Error("Linux metadata helper exceeded its 5-second deadline")), 5_000);

    const append = (chunk: Buffer, stderr: boolean) => {
      bytes += chunk.length;

      if (bytes > 8_192) { finish(new Error("Linux metadata helper exceeded its output limit"));

 return; }

      if (stderr) errorOutput += chunk.toString("utf8"); else output += chunk.toString("utf8");
    };

    child.stdout!.on("data", (chunk: Buffer) => append(chunk, false));
    child.stderr!.on("data", (chunk: Buffer) => append(chunk, true));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(code === 0 ? undefined : new Error(errorOutput || "Linux metadata helper failed")));
  });

  if (!creation) {
    const info = await file.stat({ bigint: true });
    const identity = [info.dev, info.ino, info.mode, info.uid, info.gid, info.size, info.mtimeNs, info.ctimeNs].join(":");

    if (identity !== metadata.changeIdentity || Number(info.mode) !== metadata.mode || Number(info.uid) !== metadata.uid || Number(info.gid) !== metadata.gid) throw new Error("Linux metadata helper result does not match the open inode (or metadata changed during inspection)");
  }

  return metadata;
}

export async function inspectLinuxPath(target: string, creation = false): Promise<LinuxFileMetadata> {
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try { return await inspectLinuxMetadata(file, undefined, creation); } finally { await file.close(); }
}

export async function exchangeLinuxFiles(target: string, displaced: string): Promise<void> {
  const executable = await trustedPython();
  const parent = await open(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY);

  try {
    const vault = await open(path.dirname(displaced), constants.O_RDONLY | constants.O_DIRECTORY);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ["-I", "-S", "-c", `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.renameat2(3, os.fsencode(sys.argv[1]), 4, os.fsencode(sys.argv[2]), 2) != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error))
os.fsync(3)
os.fsync(4)
`, path.basename(target), path.basename(displaced)], {
          cwd: "/", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "ignore", "pipe", parent.fd, vault.fd],
        });

        let errors = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        child.stderr!.on("data", chunk => { errors = (errors + String(chunk)).slice(-4096); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`Atomic Linux exchange failed: ${errors || code}`)); });
      });
    } finally { await vault.close(); }
  } finally { await parent.close(); }
}
