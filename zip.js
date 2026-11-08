/**
 * Mnemon Sync — a minimal, dependency-free ZIP writer.
 *
 * Why hand-rolled: the plugin runs from a workspace directory that does not
 * carry dsh-mnemon's transitive dependencies, so importing `fflate` from there
 * would only work by coincidence of hoisting. Writing stored-or-deflated
 * entries with `node:zlib` keeps the plugin dependency-free, and a ZIP is the
 * one archive format every OS and NAS UI can open without extra tooling.
 *
 * Scope is deliberately narrow: one archive, no encryption, no ZIP64. A backup
 * of a memory store is a handful of megabytes; crossing the 4 GiB ZIP64 line
 * would mean something is very wrong, so that limit is reported rather than
 * silently producing a corrupt file.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const ZIP64_LIMIT = 0xffffffff

let crcTable

function crc32(buffer) {
  if (crcTable === undefined) {
    crcTable = new Int32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      crcTable[index] = value
    }
  }
  let crc = 0 ^ -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/** DOS timestamp: ZIP carries a local-time date no earlier than 1980. */
function dosStamp(at) {
  const year = Math.max(1980, at.getFullYear())
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2)
  const date = ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  return { time, date }
}

/**
 * Build a ZIP archive.
 *
 * @param {Array<{path: string, bytes: Uint8Array, compress?: boolean}>} entries
 * @param {{ at?: Date, level?: number }} [options]
 * @returns {Buffer}
 */
export function createZip(entries, options = {}) {
  const at = options.at ?? new Date()
  const level = options.level ?? 6
  const { time, date } = dosStamp(at)
  const parts = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const raw = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes)
    if (raw.length >= ZIP64_LIMIT) {
      throw new Error(`archive entry too large without ZIP64: ${entry.path}`)
    }
    // Small or already-compressed payloads are stored rather than deflated:
    // deflating 4096-byte SQLite pages gains little and costs time.
    const compress = entry.compress ?? true
    const body = compress ? deflateRawSync(raw, { level }) : raw
    const method = compress ? 8 : 0
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    parts.push(local, name, body)
    central.push({
      name,
      checksum,
      compressed: body.length,
      uncompressed: raw.length,
      method,
      offset,
    })
    offset += local.length + name.length + body.length
  }

  const centralStart = offset
  for (const entry of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_HEADER, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(entry.checksum, 16)
    header.writeUInt32LE(entry.compressed, 20)
    header.writeUInt32LE(entry.uncompressed, 24)
    header.writeUInt16LE(entry.name.length, 28)
    header.writeUInt32LE(entry.offset, 42)
    parts.push(header, entry.name)
    offset += header.length + entry.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  parts.push(end)

  return Buffer.concat(parts)
}

/**
 * Read back a ZIP produced by `createZip`, used by the restore preview to
 * prove the archive is intact before an operator acts on it.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('not a ZIP archive: end of central directory not found')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralStart = buffer.readUInt32LE(eocd + 16)
  const files = new Map()
  let cursor = centralStart
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new Error('corrupt ZIP: central directory header signature mismatch')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressed = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const body = buffer.subarray(dataStart, dataStart + compressed)
    files.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}
