import {
  ioCall,
  inputStreamCreate,
  outputStreamCreate,
} from "../io/worker-io.js";
import { INPUT_STREAM_CREATE, OUTPUT_STREAM_CREATE } from "../io/calls.js";
import { FILE } from "../io/stream-types.js";
// import { environment } from "./cli.js";
import {
  closeSync,
  constants,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  futimesSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  opendirSync,
  openSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { platform } from "node:process";

const symbolDispose = Symbol.dispose || Symbol.for("dispose");

const isWindows = platform === "win32";

const nsMagnitude = 1_000_000_000_000n;
function nsToDateTime(ns) {
  const seconds = ns / nsMagnitude;
  const nanoseconds = Number(ns % seconds);
  return { seconds, nanoseconds };
}

function lookupType(obj) {
  if (obj.isFile()) return "regular-file";
  else if (obj.isSocket()) return "socket";
  else if (obj.isSymbolicLink()) return "symbolic-link";
  else if (obj.isFIFO()) return "fifo";
  else if (obj.isDirectory()) return "directory";
  else if (obj.isCharacterDevice()) return "character-device";
  else if (obj.isBlockDevice()) return "block-device";
  return "unknown";
}

// Note: This should implement per-segment semantics of openAt, but we cannot currently
//       due to the lack of support for openat() in Node.js.
//       Tracking issue: https://github.com/libuv/libuv/issues/4167
/**
 * @implements {DescriptorProps}
 */
let descriptorCnt = 3;
class Descriptor {
  #hostPreopen;
  #fd;
  #mode;
  #fullPath;

  static _createPreopen(hostPreopen) {
    const descriptor = new Descriptor();
    descriptor.#hostPreopen = hostPreopen.endsWith("/")
      ? hostPreopen.slice(0, -1) || '/'
      : hostPreopen;
    return descriptor;
  }

  static _create(fd, mode, fullPath) {
    const descriptor = new Descriptor();
    descriptor.#fd = fd;
    descriptor.#mode = mode;
    if (fullPath.endsWith("/")) throw new Error("bad full path");
    descriptor.#fullPath = fullPath;
    return descriptor;
  }

  constructor() {
    // this id is purely for debugging purposes
    this._id = descriptorCnt++;
  }

  readViaStream(offset) {
    if (this.#hostPreopen) throw "is-directory";
    return inputStreamCreate(
      FILE,
      ioCall(INPUT_STREAM_CREATE | FILE, null, {
        fd: this.#fd,
        offset,
      })
    );
  }

  writeViaStream(offset) {
    if (this.#hostPreopen) throw "is-directory";
    return outputStreamCreate(
      FILE,
      ioCall(OUTPUT_STREAM_CREATE | FILE, null, { fd: this.#fd, offset })
    );
  }

  appendViaStream() {
    return this.writeViaStream(this.stat().size);
  }

  advise(_offset, _length, _advice) {}

  syncData() {
    if (this.#hostPreopen) throw "invalid";
    try {
      fdatasyncSync(this.#fd);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  getFlags() {
    if (this.#hostPreopen) throw "invalid";
    return this.#mode;
  }

  getType() {
    if (this.#hostPreopen) return "directory";
    const stats = fstatSync(this.#fd);
    return lookupType(stats);
  }

  setSize(size) {
    if (this.#hostPreopen) throw "is-directory";
    try {
      ftruncateSync(this.#fd, Number(size));
    } catch (e) {
      throw convertFsError(e);
    }
  }

  setTimes(dataAccessTimestamp, dataModificationTimestamp) {
    if (this.#hostPreopen) throw "invalid";
    let stats;
    if (
      dataAccessTimestamp.tag === "no-change" ||
      dataModificationTimestamp.tag === "no-change"
    )
      stats = this.stat();
    const atime = this.#getNewTimestamp(
      dataAccessTimestamp,
      dataAccessTimestamp.tag === "no-change" && stats.dataAccessTimestamp
    );
    const mtime = this.#getNewTimestamp(
      dataModificationTimestamp,
      dataModificationTimestamp.tag === "no-change" &&
        stats.dataModificationTimestamp
    );
    try {
      futimesSync(this.#fd, atime, mtime);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  #getNewTimestamp(newTimestamp, maybeNow) {
    switch (newTimestamp.tag) {
      case "no-change":
        return timestampToMs(maybeNow);
      case "now":
        return Math.floor(Date.now() / 1e3);
      case "timestamp":
        return timestampToMs(newTimestamp.val);
    }
  }

  read(length, offset) {
    if (!this.#fullPath) throw "bad-descriptor";
    const buf = new Uint8Array(length);
    const bytesRead = readSync(this.#fd, buf, Number(offset), length, 0);
    const out = new Uint8Array(buf.buffer, 0, bytesRead);
    return [out, bytesRead === 0 ? "ended" : "open"];
  }

  write(buffer, offset) {
    if (!this.#fullPath) throw "bad-descriptor";
    return BigInt(
      writeSync(this.#fd, buffer, Number(offset), buffer.byteLength - offset, 0)
    );
  }

  readDirectory() {
    if (!this.#fullPath) throw "bad-descriptor";
    try {
      const dir = opendirSync(
        isWindows ? this.#fullPath.slice(1) : this.#fullPath
      );
      return directoryEntryStreamCreate(dir);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  sync() {
    if (this.#hostPreopen) throw "invalid";
    try {
      fsyncSync(this.#fd);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  createDirectoryAt(path) {
    const fullPath = this.#getFullPath(path);
    try {
      mkdirSync(fullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  stat() {
    if (this.#hostPreopen) throw "invalid";
    let stats;
    try {
      stats = fstatSync(this.#fd, { bigint: true });
    } catch (e) {
      throw convertFsError(e);
    }
    const type = lookupType(stats);
    return {
      type,
      linkCount: stats.nlink,
      size: stats.size,
      dataAccessTimestamp: nsToDateTime(stats.atimeNs),
      dataModificationTimestamp: nsToDateTime(stats.mtimeNs),
      statusChangeTimestamp: nsToDateTime(stats.ctimeNs),
    };
  }

  statAt(pathFlags, path) {
    const fullPath = this.#getFullPath(path, false);
    let stats;
    try {
      stats = (pathFlags.symlinkFollow ? statSync : lstatSync)(
        isWindows ? fullPath.slice(1) : fullPath,
        { bigint: true }
      );
    } catch (e) {
      throw convertFsError(e);
    }
    const type = lookupType(stats);
    return {
      type,
      linkCount: stats.nlink,
      size: stats.size,
      dataAccessTimestamp: nsToDateTime(stats.atimeNs),
      dataModificationTimestamp: nsToDateTime(stats.mtimeNs),
      statusChangeTimestamp: nsToDateTime(stats.ctimeNs),
    };
  }

  setTimesAt(pathFlags, path, dataAccessTimestamp, dataModificationTimestamp) {
    const fullPath = this.#getFullPath(path, false);
    let stats;
    if (
      dataAccessTimestamp.tag === "no-change" ||
      dataModificationTimestamp.tag === "no-change"
    )
      stats = this.stat();
    const atime = this.#getNewTimestamp(
      dataAccessTimestamp,
      dataAccessTimestamp.tag === "no-change" && stats.dataAccessTimestamp
    );
    const mtime = this.#getNewTimestamp(
      dataModificationTimestamp,
      dataModificationTimestamp.tag === "no-change" &&
        stats.dataModificationTimestamp
    );
    try {
      (pathFlags.symlinkFollow ? utimesSync : lutimesSync)(
        fullPath,
        atime,
        mtime
      );
    } catch (e) {
      throw convertFsError(e);
    }
  }

  linkAt(oldPathFlags, oldPath, newDescriptor, newPath) {
    const oldFullPath = this.#getFullPath(oldPath, oldPathFlags.symlinkFollow);
    const newFullPath = newDescriptor.#getFullPath(newPath, false);
    try {
      linkSync(oldFullPath, newFullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  openAt(pathFlags, path, openFlags, descriptorFlags) {
    const fullPath = this.#getFullPath(path, pathFlags.symlinkFollow);
    let fsOpenFlags = 0x0;
    if (openFlags.create) fsOpenFlags |= constants.O_CREAT;
    if (openFlags.directory) fsOpenFlags |= constants.O_DIRECTORY;
    if (openFlags.exclusive) fsOpenFlags |= constants.O_EXCL;
    if (openFlags.truncate) fsOpenFlags |= constants.O_TRUNC;

    if (descriptorFlags.read && descriptorFlags.write)
      fsOpenFlags |= constants.O_RDWR;
    else if (descriptorFlags.write) fsOpenFlags |= constants.O_WRONLY;
    else if (descriptorFlags.read) fsOpenFlags |= constants.O_RDONLY;
    // TODO:
    // if (descriptorFlags.fileIntegritySync)
    // if (descriptorFlags.dataIntegritySync)
    // if (descriptorFlags.requestedWriteSync)
    // if (descriptorFlags.mutateDirectory)

    try {
      const fd = openSync(
        isWindows ? fullPath.slice(1) : fullPath,
        fsOpenFlags
      );
      return descriptorCreate(fd, descriptorFlags, fullPath, preopenEntries);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  readlinkAt(path) {
    const fullPath = this.#getFullPath(path, false);
    try {
      return readlinkSync(fullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  removeDirectoryAt(path) {
    const fullPath = this.#getFullPath(path, false);
    try {
      rmdirSync(fullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  renameAt(oldPath, newDescriptor, newPath) {
    const oldFullPath = this.#getFullPath(oldPath, false);
    const newFullPath = newDescriptor.#getFullPath(newPath, false);
    try {
      renameSync(oldFullPath, newFullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  symlinkAt(target, path) {
    const fullPath = this.#getFullPath(path, false);
    try {
      symlinkSync(target, fullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  unlinkFileAt(path) {
    const fullPath = this.#getFullPath(path, false);
    try {
      unlinkSync(fullPath);
    } catch (e) {
      throw convertFsError(e);
    }
  }

  isSameObject(other) {
    return other === this;
  }

  metadataHash() {
    if (this.#hostPreopen) return { upper: 0n, lower: BigInt(this._id) };
    try {
      const stats = fstatSync(this.#fd, { bigint: true });
      return { upper: stats.mtimeNs, lower: stats.ino };
    } catch (e) {
      throw convertFsError(e);
    }
  }

  metadataHashAt(pathFlags, path) {
    const fullPath = this.#getFullPath(path, false);
    try {
      const stats = (pathFlags.symlinkFollow ? statSync : lstatSync)(
        isWindows ? fullPath.slice(1) : fullPath,
        { bigint: true }
      );
      return { upper: stats.mtimeNs, lower: stats.ino };
    } catch (e) {
      throw convertFsError(e);
    }
  }

  // TODO: support followSymlinks
  #getFullPath(subpath, _followSymlinks) {
    let descriptor = this;
    if (subpath.indexOf("\\") !== -1) subpath = subpath.replace(/\\/g, "/");
    if (subpath[0] === "/") {
      let bestPreopenMatch = "";
      for (const preopenEntry of preopenEntries) {
        if (
          subpath.startsWith(preopenEntry[1]) &&
          (!bestPreopenMatch ||
            bestPreopenMatch.length < preopenEntry[1].length)
        ) {
          bestPreopenMatch = preopenEntry;
        }
      }
      if (!bestPreopenMatch) throw "no-entry";
      descriptor = bestPreopenMatch[0];
      subpath = subpath.slice(bestPreopenMatch[1]);
      if (subpath[0] === "/") subpath = subpath.slice(1);
    }
    if (subpath.startsWith("."))
      subpath = subpath.slice(subpath[1] === "/" ? 2 : 1);
    if (descriptor.#hostPreopen)
      return (
        descriptor.#hostPreopen + (subpath.length > 0 ? "/" : "") + subpath
      );
    return descriptor.#fullPath + (subpath.length > 0 ? "/" : "") + subpath;
  }

  [symbolDispose]() {
    if (this.#fd) closeSync(this.#fd);
  }
}
const descriptorCreatePreopen = Descriptor._createPreopen;
delete Descriptor._createPreopen;
const descriptorCreate = Descriptor._create;
delete Descriptor._create;

class DirectoryEntryStream {
  #dir;
  readDirectoryEntry() {
    let entry;
    try {
      entry = this.#dir.readSync();
    } catch (e) {
      throw convertFsError(e);
    }
    if (entry === null) {
      return null;
    }
    const name = entry.name;
    const type = lookupType(entry);
    return { name, type };
  }
  [symbolDispose]() {
    this.#dir.closeSync();
  }

  static _create(dir) {
    const dirStream = new DirectoryEntryStream();
    dirStream.#dir = dir;
    return dirStream;
  }
}
const directoryEntryStreamCreate = DirectoryEntryStream._create;
delete DirectoryEntryStream._create;

let preopenEntries = [];
// let cwd = environment.initialCwd();

export const preopens = {
  Descriptor,
  getDirectories() {
    return preopenEntries;
  },
};

_addPreopen("/", "/");

export const types = {
  Descriptor,
  DirectoryEntryStream,
};

export function _setPreopens(preopens) {
  preopenEntries = [];
  for (const [virtualPath, hostPreopen] of Object.entries(preopens)) {
    _addPreopen(virtualPath, hostPreopen);
  }
}

export function _addPreopen(virtualPath, hostPreopen) {
  const preopenEntry = [descriptorCreatePreopen(hostPreopen), virtualPath];
  preopenEntries.push(preopenEntry);
}

function convertFsError(e) {
  switch (e.code) {
    case "EACCES":
      return "access";
    case "EAGAIN":
    case "EWOULDBLOCK":
      return "would-block";
    case "EALREADY":
      return "already";
    case "EBADF":
      return "bad-descriptor";
    case "EBUSY":
      return "busy";
    case "EDEADLK":
      return "deadlock";
    case "EDQUOT":
      return "quota";
    case "EEXIST":
      return "exist";
    case "EFBIG":
      return "file-too-large";
    case "EILSEQ":
      return "illegal-byte-sequence";
    case "EINPROGRESS":
      return "in-progress";
    case "EINTR":
      return "interrupted";
    case "EINVAL":
      return "invalid";
    case "EIO":
      return "io";
    case "EISDIR":
      return "is-directory";
    case "ELOOP":
      return "loop";
    case "EMLINK":
      return "too-many-links";
    case "EMSGSIZE":
      return "message-size";
    case "ENAMETOOLONG":
      return "name-too-long";
    case "ENODEV":
      return "no-device";
    case "ENOENT":
      return "no-entry";
    case "ENOLCK":
      return "no-lock";
    case "ENOMEM":
      return "insufficient-memory";
    case "ENOSPC":
      return "insufficient-space";
    case "ENOTDIR":
      return "not-directory";
    case "ENOTEMPTY":
      return "not-empty";
    case "ENOTRECOVERABLE":
      return "not-recoverable";
    case "ENOTSUP":
      return "unsupported";
    case "ENOTTY":
      return "no-tty";
    case "ENXIO":
      return "no-such-device";
    case "EOVERFLOW":
      return "overflow";
    case "EPERM":
      return "not-permitted";
    case "EPIPE":
      return "pipe";
    case "EROFS":
      return "read-only";
    case "ESPIPE":
      return "invalid-seek";
    case "ETXTBSY":
      return "text-file-busy";
    case "EXDEV":
      return "cross-device";
    default:
      throw e;
  }
}

function timestampToMs(timestamp) {
  return Number(timestamp.seconds) * 1000 + timestamp.nanoseconds / 1e9;
}
