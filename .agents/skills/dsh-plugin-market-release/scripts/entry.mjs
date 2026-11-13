#!/usr/bin/env node
/**
 * 生成 awesome-dsh-plugin 的条目文件与文件名，并做一致性自查。
 *
 * 用法（在本仓根目录）：
 *   node .agents/skills/dsh-plugin-market-release/scripts/entry.mjs \
 *     --repo https://github.com/summerscar/dsh-plugins \
 *     --subdir plugins/dsh-mnemon-sync \
 *     --package @summerscar/dsh-mnemon-sync \
 *     --category memory \
 *     [--label dsh-mnemon-sync] [--out /tmp/entry.yml]
 *
 * 它做三件事：
 *   1. 按对方 slugFor() 的规则推导 `owner__repo[--sub-path].yml` 文件名；
 *   2. 从 npm registry 读 latest 的 repository/license/engines，核对「包是否认领该仓库」；
 *   3. 从包内 locale/*.json 取 meta.description，给出可直接提交的 YAML。
 *
 * 只读：不写仓库文件、不联网到除 registry.npmjs.org 以外的地方。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? '' : arr[i + 1] ?? ''])
    return acc
  }, []),
)

const repo = String(args.repo ?? '').replace(/\/+$/, '')
const subdir = String(args.subdir ?? '').replace(/^\/+|\/+$/g, '')
const pkg = String(args.package ?? '')
const category = String(args.category ?? '')
const label = args.label || subdir.split('/').pop() || ''
if (!repo || !pkg || !category) {
  console.error('用法: --repo <github-url> --package <npm-name> --category <id> [--subdir <path>] [--label <tag>] [--out <file>]')
  process.exit(1)
}

/** 与 awesome-dsh-plugin 的 scripts/lib/entries.mjs slugFor() 等价。 */
export function slugFor(url) {
  const p = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  const repository = p.split('/').slice(0, 2).join('/')
  const sub = p.includes('/tree/') ? p.split('/tree/')[1].replace(/^[^/]+\//, '') : null
  const base = repository.replaceAll('/', '__')
  return sub ? `${base}--${sub.replaceAll('/', '-')}` : base
}

const entryUrl = subdir ? `${repo}/tree/main/${subdir}` : repo
const fileName = `${slugFor(entryUrl)}.yml`
const ownerRepo = repo.replace(/^https:\/\/github\.com\//, '').split('/').slice(0, 2).join('/')
const name = subdir ? `${ownerRepo}#${label}` : ownerRepo

let meta = {}
try {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (res.ok) meta = await res.json()
} catch (error) {
  console.error(`warn: 读不到 npm registry（${error.message}），描述将留空待手填`)
}

const latest = meta['dist-tags']?.latest
const version = latest ? meta.versions?.[latest] : undefined
const repoOk = version?.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '') === repo

const yamlEscape = (s) => (/:\s/.test(s) || /^[>|*&!%@`'"{[]/.test(s) ? `'${String(s).replaceAll("'", "''")}'` : String(s))

let en = ''
let zh = ''
try {
  en = JSON.parse(readFileSync(join(subdir || '.', 'locale/en.json'), 'utf8'))?.meta?.description ?? ''
  zh = JSON.parse(readFileSync(join(subdir || '.', 'locale/zh.json'), 'utf8'))?.meta?.description ?? ''
} catch {
  console.error('warn: 读不到包内 locale/*.json，描述请手填')
}

const lines = [
  `url: ${entryUrl}`,
  `name: ${name}`,
  `category: ${category}`,
  'description:',
  `  en: ${yamlEscape(en || '<一句话英文描述，以句号结尾>')}`,
  `  zh: ${yamlEscape(zh || '<一句话中文描述，以句号结尾>')}`,
]

console.log('文件名（必须一致）:', fileName)
console.log('')
console.log(lines.join('\n'))
console.log('')
console.log('--- 一致性自查 ---')
console.log(`npm latest          : ${latest ?? '(读不到)'}`)
console.log(`repository 指回本仓 : ${repoOk ? '是' : '否 —— 市场会关联不上包，先修 package.json 再投递'}`)
console.log(`license             : ${version?.license ?? '(未知)'}`)
console.log(`engines.dsh         : ${version?.engines?.dsh ?? '(未声明)'}`)
console.log(`描述含 ": " 需加引号 : ${/:\s/.test(en + zh) ? '已自动加引号' : '无需'}`)

if (args.out) {
  writeFileSync(String(args.out), lines.join('\n') + '\n')
  console.log(`\n已写入 ${args.out}`)
}
if (repoOk === false) process.exitCode = 2
