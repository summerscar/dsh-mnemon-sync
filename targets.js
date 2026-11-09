/**
 * Mnemon Sync — upload targets.
 *
 * Two target kinds ship here, both implemented against the platform's own
 * `fetch` and `node:crypto` rather than an SDK:
 *
 * - `webdav`: a plain authenticated `PUT`, which is all a WebDAV collection
 *   needs to accept an archive. `MKCOL` is tried for the parent so a fresh
 *   target directory does not fail the first upload.
 * - `s3`: AWS Signature Version 4 against any S3-compatible endpoint
 *   (Cloudflare R2, MinIO, Backblaze B2, Alibaba OSS...). Signing by hand
 *   keeps the plugin dependency-free; a wrong signature fails loudly with
 *   `SignatureDoesNotMatch`, never silently.
 *
 * Nothing here stores credentials. The caller reads them from the 0600
 * settings file and passes them in, so this module stays a pure function of
 * (config, bytes) and can be exercised against a throwaway bucket.
 */

import { createHash, createHmac } from 'node:crypto'

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

/**
 * Normalise whatever the settings page saved into the shape the uploaders take.
 * Kept permissive about the key spelling so a hand-edited file still works:
 * `endpoint`/`url`, `accessKey`/`accessKeyId`, `secretKey`/`secretAccessKey`.
 */
export function normalizeTarget(raw) {
  const kind = String(raw?.kind ?? '').trim()
  if (kind !== 's3' && kind !== 'webdav') {
    throw new Error(`unsupported backup target kind: ${kind === '' ? '(empty)' : kind}`)
  }
  if (kind === 'webdav') {
    const url = required(raw.url, 'WebDAV URL')
    return {
      kind,
      url: url.replace(/\/+$/u, ''),
      username: String(raw.username ?? ''),
      password: String(raw.password ?? ''),
      remotePath: trimSlashes(raw.remotePath ?? 'mnemon-sync'),
      timeoutMs: positiveInteger(raw.timeoutMs, 30000),
    }
  }
  const endpoint = required(raw.endpoint, 'S3 endpoint').replace(/\/+$/u, '')
  return {
    kind,
    endpoint,
    bucket: required(raw.bucket, 'S3 bucket'),
    region: String(raw.region ?? '').trim() || 'auto',
    accessKeyId: required(raw.accessKeyId ?? raw.accessKey, 'S3 access key id'),
    secretAccessKey: required(raw.secretAccessKey ?? raw.secretKey, 'S3 secret access key'),
    sessionToken: String(raw.sessionToken ?? '').trim(),
    remotePath: trimSlashes(raw.remotePath ?? 'mnemon-sync'),
    forcePathStyle: raw.forcePathStyle === true,
    timeoutMs: positiveInteger(raw.timeoutMs, 30000),
  }
}

function required(value, label) {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`${label} is required`)
  return text
}

function trimSlashes(value) {
  return String(value ?? '').trim().replace(/^\/+/u, '').replace(/\/+$/u, '')
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

/**
 * Upload one archive and return where it landed.
 * The return value is what the UI shows and what the retention step deletes,
 * so both kinds answer with the same `{ location, key }` shape.
 */
export async function uploadArchive(target, key, bytes, options = {}) {
  if (target.kind === 'webdav') return putWebDav(target, key, bytes, options.signal)
  if (target.kind === 's3') return putS3Object(target, key, bytes, options.signal)
  throw new Error(`unsupported backup target kind: ${String(target.kind)}`)
}

/** Delete one archive; missing objects count as success so retention is idempotent. */
export async function deleteArchive(target, key, options = {}) {
  if (target.kind === 'webdav') return deleteWebDav(target, key, options.signal)
  if (target.kind === 's3') return deleteS3Object(target, key, options.signal)
  throw new Error(`unsupported backup target kind: ${String(target.kind)}`)
}

/**
 * List the archives the target currently holds.
 *
 * Both kinds answer the same `{ key, bytes, modifiedAt }` shape, sorted newest
 * first, so the page can show one list. Listing is read-only and never assumes
 * this machine made the archive: a bucket may hold backups from another Host,
 * which is exactly what a person wants to see after reinstalling.
 */
export async function listArchives(target, options = {}) {
  if (target.kind === 'webdav') return listWebDav(target, options.signal)
  if (target.kind === 's3') return listS3(target, options.signal)
  throw new Error(`unsupported backup target kind: ${String(target.kind)}`)
}

/**
 * Fetch one archive back.
 *
 * Restore reads first and writes later: downloading the whole archive lets the
 * caller verify every checksum before deciding where anything lands, which is
 * the only safe order when the target may hold an incomplete upload.
 */
export async function downloadArchive(target, key, options = {}) {
  if (target.kind === 'webdav') {
    const url = webDavUrl(target, key)
    const response = await fetch(url, {
      method: 'GET',
      headers: authHeaders(target),
      signal: options.signal ?? AbortSignal.timeout(target.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`WebDAV GET ${url} failed: ${response.status} ${await safeText(response)}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
  if (target.kind === 's3') {
    const url = new URL(s3Url(target, key))
    const response = await fetch(url, {
      method: 'GET',
      headers: signedHeadersForGet(target, url),
      signal: options.signal ?? AbortSignal.timeout(target.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`S3 GET ${url.pathname} failed: ${response.status} ${await safeText(response)}`)
    }
    return Buffer.from(await response.arrayBuffer())
  }
  throw new Error(`unsupported backup target kind: ${String(target.kind)}`)
}

// ---------------------------------------------------------------------------
// WebDAV
// ---------------------------------------------------------------------------

function webDavUrl(target, key) {
  const segments = [target.remotePath, key].filter((part) => part !== '').join('/')
  return `${target.url}/${segments.split('/').map(encodeURIComponent).join('/')}`
}

function authHeaders(target) {
  if (target.username === '' && target.password === '') return {}
  const token = Buffer.from(`${target.username}:${target.password}`).toString('base64')
  return { authorization: `Basic ${token}` }
}

async function putWebDav(target, key, bytes, signal) {
  const url = webDavUrl(target, key)
  // A missing collection is the common first-run failure; create it and retry
  // once. A 405 means it already exists, which is equally fine.
  await ensureWebDavDirectory(target, url, signal)
  const response = await fetch(url, {
    method: 'PUT',
    headers: { ...authHeaders(target), 'content-type': 'application/zip' },
    body: bytes,
    signal: signal ?? AbortSignal.timeout(target.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`WebDAV PUT ${url} failed: ${response.status} ${await safeText(response)}`)
  }
  return { location: url, key }
}

async function ensureWebDavDirectory(target, url, signal) {
  const directoryUrl = url.slice(0, url.lastIndexOf('/'))
  if (directoryUrl === '') return
  const segments = directoryUrl.split('/')
  // Walk down from the collection root so a multi-segment remote path works.
  const rootIndex = segments.indexOf(target.url.split('/').filter(Boolean).pop()?.toString() ?? '')
  const start = rootIndex >= 0 ? rootIndex + 1 : 3
  for (let index = start; index <= segments.length; index += 1) {
    const current = segments.slice(0, index).join('/')
    if (current === '' || !current.startsWith('http')) continue
    try {
      await fetch(current, {
        method: 'MKCOL',
        headers: authHeaders(target),
        signal: signal ?? AbortSignal.timeout(target.timeoutMs),
      })
    } catch {
      // Best effort: a PUT below reports the real problem with the real status.
    }
  }
}

async function deleteWebDav(target, key, signal) {
  const url = webDavUrl(target, key)
  const response = await fetch(url, {
    method: 'DELETE',
    headers: authHeaders(target),
    signal: signal ?? AbortSignal.timeout(target.timeoutMs),
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`WebDAV DELETE ${url} failed: ${response.status} ${await safeText(response)}`)
  }
  return { location: url, key, deleted: response.ok }
}

/**
 * List the sync folder with `PROPFIND depth: 1`.
 *
 * Only entries directly under the remote path are read, which is what the page
 * shows. A missing collection answers 404 and is reported as an empty list: a
 * target that has never been written to is not an error.
 */
async function listWebDav(target, signal) {
  const directory = `${target.url}/${target.remotePath.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetch(directory, {
    method: 'PROPFIND',
    headers: {
      ...authHeaders(target),
      depth: '1',
      'content-type': 'application/xml; charset=utf-8',
    },
    body: XML_LIST_BODY,
    signal: signal ?? AbortSignal.timeout(target.timeoutMs),
  })
  if (response.status === 404) return []
  if (!response.ok) {
    throw new Error(`WebDAV PROPFIND ${directory} failed: ${response.status} ${await safeText(response)}`)
  }
  return parseWebDavListing(await response.text(), target.remotePath)
}

const XML_LIST_BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<d:propfind xmlns:d="DAV:"><d:prop>'
  + '<d:getcontentlength/><d:getlastmodified/><d:resourcetype/>'
  + '</d:prop></d:propfind>'

/**
 * Turn a PROPFIND multistatus document into archive rows.
 *
 * Parsing is deliberately forgiving: tag prefixes vary between servers (`d:`,
 * `D:`, none), and a listing that omits a property must not drop the file. Only
 * the pieces this page needs are read.
 */
function parseWebDavListing(xml, remotePath) {
  const entries = []
  const blocks = xml.split(/<\/[^:>]*:?response>/iu)
  for (const block of blocks) {
    const href = /<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/iu.exec(block)
    if (href === null) continue
    // A collection is the parent itself; it is not an archive.
    if (/<[^:>]*:?collection\s*\/?>/iu.test(block)) continue
    let path
    try {
      path = decodeURIComponent(href[1].trim())
    } catch {
      path = href[1].trim()
    }
    const name = path.split('/').filter(Boolean).pop() ?? ''
    if (!name.toLowerCase().endsWith('.zip')) continue
    entries.push({
      key: name,
      bytes: integerOf(/<[^:>]*:?getcontentlength[^>]*>(\d+)</iu.exec(block)),
      modifiedAt: textOf(/<[^:>]*:?getlastmodified[^>]*>([^<]+)</iu.exec(block)),
    })
  }
  return newestFirst(entries)
}

/**
 * Sort archives newest first.
 *
 * `modifiedAt` is an RFC 1123 string (`Sun, 09 Nov 2026 08:00:00 GMT`) from
 * WebDAV and an ISO 8601 string from S3. Comparing those as text is wrong: the
 * weekday and day lead the WebDAV form, so "09 Nov 23:00" sorts before
 * "10 Nov 01:00" even though it is older. Parse to an instant instead.
 *
 * An unparseable or missing stamp sorts last rather than corrupting the order:
 * a listing that cannot say when something was written should not push a
 * usable row off the top.
 */
function newestFirst(entries) {
  const stamp = (entry) => {
    const value = entry?.modifiedAt
    if (typeof value !== 'string') return Number.NEGATIVE_INFINITY
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed
  }
  return entries.sort((left, right) => stamp(right) - stamp(left))
}

function integerOf(match) {
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

function textOf(match) {
  return match === null ? undefined : match[1].trim()
}

// ---------------------------------------------------------------------------
// S3 (Signature Version 4)
// ---------------------------------------------------------------------------

function s3Endpoint(target) {
  // Path style keeps the bucket in the path, which R2 and MinIO both accept
  // and which avoids wildcard-TLS surprises on custom domains.
  if (target.forcePathStyle) return `${target.endpoint}/${target.bucket}`
  const url = new URL(target.endpoint)
  return `${url.protocol}//${target.bucket}.${url.host}`
}

function s3Url(target, key) {
  const base = s3Endpoint(target)
  const segments = [target.remotePath, key].filter((part) => part !== '').join('/')
  return `${base}/${segments.split('/').map(encodeURIComponent).join('/')}`
}

/** One signed request against the S3 REST API. */
async function signedS3Request(target, method, key, bytes, signal) {
  const url = new URL(s3Url(target, key))
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = bytes === undefined ? EMPTY_SHA256 : sha256Hex(bytes)

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (target.sessionToken !== '') headers['x-amz-security-token'] = target.sessionToken
  if (bytes !== undefined) headers['content-length'] = String(bytes.length)

  const headerNames = Object.keys(headers).sort()
  const canonicalHeaders = headerNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
  const signedHeaders = headerNames.join(';')

  // The canonical URI must be the encoded path exactly as it goes on the wire,
  // and any query string must be signed in its sorted, encoded form.
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${target.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = signatureKey(target.secretAccessKey, dateStamp, target.region)
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(url, {
    method,
    headers,
    body: bytes,
    signal: signal ?? AbortSignal.timeout(target.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(
      `S3 ${method} ${url.pathname} failed: ${response.status} ${await safeText(response)}`,
    )
  }
  return { response, location: url.toString() }
}

async function putS3Object(target, key, bytes, signal) {
  const { location } = await signedS3Request(target, 'PUT', key, bytes, signal)
  return { location, key }
}

async function deleteS3Object(target, key, signal) {
  const url = new URL(s3Url(target, key))
  const response = await fetch(url, {
    method: 'DELETE',
    headers: signedHeadersForDelete(target, url),
    signal: signal ?? AbortSignal.timeout(target.timeoutMs),
  })
  // S3 answers 204 for a deleted object and 404 for one that never existed.
  if (!response.ok && response.status !== 404) {
    throw new Error(`S3 DELETE ${url.pathname} failed: ${response.status} ${await safeText(response)}`)
  }
  return { location: url.toString(), key, deleted: response.status === 204 }
}

/** DELETE carries no body, so it signs the empty-payload hash. */
function signedHeadersForDelete(target, url) {
  return signEmptyPayloadRequest(target, url, 'DELETE')
}

/** GET carries no body either; S3 requires it to be signed the same way. */
function signedHeadersForGet(target, url) {
  return signEmptyPayloadRequest(target, url, 'GET')
}

/**
 * Sign one body-less request (GET or DELETE) against the S3 REST API.
 *
 * The canonical request is identical between the two methods apart from the
 * verb, so one function keeps them from drifting: a GET signed like a PUT would
 * fail with `SignatureDoesNotMatch` and would be tedious to spot.
 */
function signEmptyPayloadRequest(target, url, method) {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, '')
  const dateStamp = amzDate.slice(0, 8)
  const headers = {
    host: url.host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  }
  if (target.sessionToken !== '') headers['x-amz-security-token'] = target.sessionToken
  const headerNames = Object.keys(headers).sort()
  const canonicalHeaders = headerNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
  const signedHeaders = headerNames.join(';')
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, EMPTY_SHA256].join('\n')
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = signatureKey(target.secretAccessKey, dateStamp, target.region)
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/**
 * Encode a query string the way Signature Version 4 expects: parameter names
 * and values percent-encoded with unreserved characters untouched, sorted by
 * name, joined with `&`. An empty query is the empty string, not `""`.
 */
function canonicalQuery(searchParams) {
  const pairs = []
  for (const [name, value] of searchParams.entries()) {
    pairs.push([encodeRfc3986(name), encodeRfc3986(value)])
  }
  pairs.sort((left, right) => (left[0] === right[0]
    ? left[1].localeCompare(right[1])
    : left[0].localeCompare(right[0])))
  return pairs.map(([name, value]) => `${name}=${value}`).join('&')
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * List archives with the ListObjectsV2 API.
 *
 * Only keys directly under the remote path are kept, and the listing is a single
 * page: a sync folder holding more than a thousand archives means retention is
 * misconfigured, and paging the whole bucket would cost more than it explains.
 */
async function listS3(target, signal) {
  // ListObjectsV2 operates on the bucket: the path is the bucket alone and
  // the prefix carries the folder. s3Url(target, '') would put remotePath in
  // the path, and the store then answers 404 NoSuchKey for the missing object.
  const url = new URL(s3Endpoint(target))
  url.searchParams.set('list-type', '2')
  url.searchParams.set('prefix', `${target.remotePath}/`)
  const { response } = await signedS3UrlRequest(target, 'GET', url, signal)
  const xml = await response.text()
  const entries = []
  const blocks = xml.split(/<\/Contents>/u)
  for (const block of blocks) {
    const key = /<Key>([^<]+)<\/Key>/u.exec(block)
    if (key === null) continue
    const raw = key[1]
    const name = raw.split('/').filter(Boolean).pop() ?? ''
    if (!name.toLowerCase().endsWith('.zip')) continue
    entries.push({
      key: name,
      fullKey: raw,
      bytes: integerOf(/<Size>(\d+)<\/Size>/u.exec(block)),
      modifiedAt: textOf(/<LastModified>([^<]+)<\/LastModified>/u.exec(block)),
    })
  }
  return newestFirst(entries)
}

/**
 * Sign and send one request to an already-built URL, including its query.
 * Kept beside the object calls so LIST reuses the same signing code.
 */
async function signedS3UrlRequest(target, method, url, signal) {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, '')
  const dateStamp = amzDate.slice(0, 8)
  const headers = {
    host: url.host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  }
  if (target.sessionToken !== '') headers['x-amz-security-token'] = target.sessionToken
  const headerNames = Object.keys(headers).sort()
  const canonicalHeaders = headerNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
  const signedHeaders = headerNames.join(';')
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n')
  const scope = `${dateStamp}/${target.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = signatureKey(target.secretAccessKey, dateStamp, target.region)
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  // The signature covers the canonical (RFC 3986) query, but URLSearchParams
  // re-encodes spaces as `+` when the URL stringifies, which would not match
  // what was signed. Serialize the query for the wire with the same encoding.
  const wireQuery = [...url.searchParams.entries()]
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join('&')
  const response = await fetch(`${url.origin}${url.pathname}?${wireQuery}`, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: signal ?? AbortSignal.timeout(target.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`S3 ${method} ${url.pathname} failed: ${response.status} ${await safeText(response)}`)
  }
  return { response }
}

function signatureKey(secret, dateStamp, region) {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update('s3').digest()
  return createHmac('sha256', kService).update('aws4_request').digest()
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function safeText(response) {
  try {
    const text = await response.text()
    return text.slice(0, 400)
  } catch {
    return ''
  }
}
