// DSH「通到 QQ」· 宿主半边
//
// 这一半只做一件事（先只做 DSH → QQ）：
//   伙伴在「目标会话」里说完一句话（一整轮的最后一句），就自动把它发到 QQ（私聊 / 群）。
//   发 QQ 走 NapCat 的 OneBot HTTP 接口（127.0.0.1:3000），走标准的 OneBot 11 HTTP。
//
// 反过来（QQ → DSH）是下一半，放到另一个插件/进程里做，不在这里混。
//
// ⚠ 安全默认：总开关 = false、试运行 = true —— 不手动打开，一句都不会真的发到 QQ。

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, createWriteStream, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createSelfUpdate } from './selfupdate.mjs'

export const name = 'qq-bridge'

/** 需要宿主提供：webServer（路由）+ sessions/sessionTitle（目标会话清单 + 标题）+ agents（followup）+ timer（轮询收消息）+ attachments（图片）。 */
// ⭐ 本机改动：加上 agentDefaultModel / sessionQuery —— 叫醒、开会话要「当前默认模型」和「会话头里的预设」
import { 开官方线 } from './official.js'
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'timer', 'workspaceRegistry', 'attachments', 'tools', 'agentDefaultModel', 'sessionQuery']

// ---------- 常量 ----------

const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'qq-bridge-config.json')
const 路由前缀 = '/dsh-qq-bridge'
const 日志上限 = 60

const 默认配置 = {
  总开关: false, // 关着 = 一句都不发（安全默认）
  试运行: true, // 开着 = 只记账、不真发到 QQ
  目标会话: '', // ⚠️ 老字段（= 私聊会话）。还认，读的时候会搬进「私聊会话」
  私聊会话: '', // ⭐ QQ 私聊那一路进哪一间（2026-10-25 拆开）
  群会话: '', //   ⭐ QQ 群里那一路进哪一间（可以留空 = 不看群）
  私聊QQ: '', // 发到哪个私聊（QQ 号，字符串）
  群号: '', // 发到哪个群（可空）
  转私聊: true,
  转群: false,
  NapCat: 'http://127.0.0.1:3000', // OneBot HTTP 接口
  令牌: '', // ⭐ access_token（2026-10-25）：NapCat / SnowLuma 开了鉴权就填这里，留空 = 不鉴权
  // ⭐ 2026-10-30（第二根线）：QQ 官方机器人 —— openid + WS 推送，跟 OneBot 轮询二选一
  协议: 'onebot11', // 'onebot11' = NapCat 轮询（老规矩）｜'qq-official' = 官方机器人
  官方AppID: '',
  官方密钥: '',
  官方沙箱: false,
  官方intents: 100663296, // 群 @(1<<25) + 单聊(1<<26)
  官方主人openid: '', // 官方线只有 openid：填了才在正文头里标出「主人」
  // ⭐ 2026-10-22：图片两个方向
  收图: true, // QQ → DSH：她发的图片也转进来
  收图最多: 4, // 一条消息最多转几张
  发图: true, // DSH → QQ：伙伴发的图片也发过去
  图上限MB: 5, // 单张最大多少 MB（两个方向共用）
  图片根目录: '', // 正文里 `![名字](相对路径)` 按哪个目录去找（留空 = 自动猜）
  称呼: '对方', // ⭐ 私聊时怎么称呼跟它说话的那个人（写进转给它的文案里，比如「小明发来了图片」）
  回复门槛: false, // ⚠ 已废弃（2026-10-25）：门槛改成「按绑定行走」——老配置里是 true 的会在迁移时变成那一行的门槛
  // ⭐ 0.7.0（用户 GAME-66 的建议，issue #2）出站两个闸，默认都关
  只发标记内: false, // 开着 = 只发正文里 [QQ]…[/QQ] 那一段（块外的解释/路径/思考留在本地）
  只回QQ唤醒: false, // 开着 = 只有「这一轮是被 QQ 消息叫醒的」才发（你在 DSH 里自己聊的不推到手机）
  // ⭐ 0.8.0：语音转写（QQ 语音条 → 文字）。插件自己不带模型，只负责把音频交给「你指定的命令」。
  语音转写: false,
  转写命令: '', // 模板，里面必须带 {file}；例如：python D:sr.py "{file}"
  语音模型目录: '', // 语音模型放哪（SenseVoice 的 model.int8.onnx + tokens.txt 所在目录）
  转写超时秒: 60,
  补投窗口分: 10, // 会话关着期间攒下的消息，超过这么多分钟就不再补投
  // ⭐ 2026-10-25（QQ 桥用户反馈「一次回一堆消息」）：长回复按空行拆成几条连发，以前是写死的。
  长回复拆段: true, // 关掉 = 一整段只发一条消息（不再刷屏）
  拆段间隔毫秒: 900, // 每段之间隔多久（太短像刷屏，太长像卡住）
  拆段抖动毫秒: 1200, // ⭐ 2026-10-27：每段再随机加 0~N 毫秒（固定间隔看着像脚本）
  // ⭐ 2026-10-25（主人：「接下来得限制发送频率」）：出站限速，防刷屏也防被当成机器号
  发送限速: true, // 开：同一聊天两条之间至少隔一会，且每分钟/每小时有硬上限
  最小间隔秒: 6, // 两条消息之间至少隔这么久
  抖动秒: 4, // 额外随机 0~N 秒（固定间隔看起来像机器）
  每分钟上限: 6, // 同一个聊天一分钟最多发几条
  每小时上限: 60, // 同一个聊天一小时最多发几条
  // ⭐⭐ 2026-10-27（主人：「开始改吧」；对着 B 站那期风控指南）：三样**保号**护栏 ——
  //   目的只有一个：这条线别被 QQ 判成批量接口。**不是扮演人类**（主人 2026-10-27 原话：
  //   「这些行为只为了保护你的QQ号不被封……不需要通过扮演拟人」）。
  //   ① 深夜静默：整条线夜里一起睡 —— 24 小时秒回是最像机器的特征
  //   ② 接话概率 / 冷却：**默认全收、默认关** —— 群里接不接由她自己看着办，
  //      桥不替她筛（主人 2026-10-27 明确否掉了概率接话）。留着只是号太烫时的备用手闸。
  //   ③ 节奏：每段之间随机抖动 + 按字数停顿（见 段等待()）—— 不再固定 450ms 连发
  静默时段: '23:00-08:00', // 空 = 不静默；跨零点就写成 23:00-08:00 这样
  静默两边都停: true, // 静默里：QQ 消息不叫醒她（不投），她也不往 QQ 发
  接话概率: 100, // 群里接话概率（%）。**默认 100 = 全收**，接不接她自己定；收窄才会替她筛
  冷却分钟: 0, // 同一聊天两次「主动接话」的最小间隔。**默认 0 = 关**（不开就不筛）
  私聊也限: false, // 把上面这两条也用到私聊上（默认只限群；两条都默认关时本来就等于不限）
  // ⭐ 2026-10-25：门槛判定「不接」时，要不要**真把这一轮停掉**。
  //   · 关（默认）：不停轮，只把这轮的「出站」掐掉 —— 界面干净，但模型会把这轮想完（费一点 token）
  //   · 开：调用 agent.cancel() 停轮 —— 这才是真的「停止思考」，代价是界面上会出现
  //        `Error: tool call aborted`（那是停轮的**表现**，不是故障），有的宿主还会「重试模型请求」
  门槛真停轮: false,
  // ⭐⭐ 2026-10-25：绑定列表 —— 一行 = 一个聊天（私聊/群）→ 一间 DSH 会话
  //   { 类型: '私聊' | '群', 号码: 'QQ号或群号', 会话: 'session-…', 称呼: '小明', 门槛: false }
  // ⭐ 本机改动：点名认的称呼表（空格分隔）—— 群里出现这些词就算「在叫它」
  别名: '鲸鱼娘 鲸鱼 小鲸鱼',
  绑定: [],
  群称呼: '群里的人', // ⭐ 群聊时怎么称呼（群里不止一个人，一般别填某个人的名字）
  // ⭐ 本机改动：绑定行的形状又长了几项 —— 每行自己的投递口径（上面那两行注释是老形状）
  //   { 类型, 号码, 会话, 称呼, 门槛, 收档: '全收'|'半收'|'点名', 半收分钟: 5, 自动发: true,
  //     预设: 'whale', 会话目录: '', 只认: '', 叫醒: true, 收: true, 发: true }
}

/** 包根目录（用它读自己包里的东西，比如 tools/asr_cli.py） */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 版本从 package.json 读。 */
const 版本 = (() => {
  try {
    const p = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    return String(p.version || '?')
  } catch (error) {
    return '?'
  }
})()

/** 跑一条外部命令（异步、带超时、拿 stdout）。
 *  ⭐ 语音转写用：插件自己**不带 ASR 模型**，只负责「把音频文件交给用户指定的命令，拿回文字」。
 *  这样本机 whisper / SenseVoice / 云端 API 都能接，插件也不会因为塞模型变成几百 MB。 */
function 跑命令(模板, 文件, 超时秒) {
  return new Promise((resolve) => {
    const 命令 = String(模板 || '').replace(/\{file\}/g, 文件)
    let 出 = ''
    let 错 = ''
    let 收过 = false
    const 收 = (v) => { if (收过) return; 收过 = true; resolve(v) }
    let 子 = null
    try {
      子 = spawn(命令, {
        shell: true, windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (error) {
      return 收({ ok: false, 错: String((error && error.message) || error) })
    }
    const 定时 = setTimeout(() => {
      try { 子.kill() } catch (error) {}
      收({ ok: false, 错: '超时（' + 超时秒 + ' 秒）' })
    }, Math.max(5, Number(超时秒) || 60) * 1000)
    子.stdout.on('data', (c) => { 出 += c })
    子.stderr.on('data', (c) => { 错 += c })
    子.on('error', (error) => { clearTimeout(定时); 收({ ok: false, 错: String((error && error.message) || error) }) })
    子.on('close', (码) => {
      clearTimeout(定时)
      收({ ok: 码 === 0, 文字: 出.trim(), 错: (错.trim() || ('退出码 ' + 码)) })
    })
  })
}

/** 把「语音段」里的东西落成本地文件（QQ 给的有三种形态：http 链接 / base64:// / 本地文件名）
 *  ⚠️ 2026-10-25 修（她实测报的）：以前直接把 `file` 丢给转写命令 —— 那个值经常是
 *     `https://multimedia.nt.qq.com.cn/download?appid=...` 这种**网络地址**，
 *     命令当然找不到文件，就报「找不到音频文件」。现在先下载/解码到本地再交给它。 */
async function 语音落文件(段, 拉任意, 家目录, 名) {
  const d = (段 && 段.data) || {}
  const 原 = String(d.file || d.url || '')
  const 直链 = String(d.url || '') || (/^https?:/i.test(原) ? 原 : '')
  const 落盘 = (字节, 扩展) => {
    try {
      const 目录 = join(家目录, 'audio')
      mkdirSync(目录, { recursive: true })
      const 文件 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.' + 扩展)
      writeFileSync(文件, 字节)
      return 文件
    } catch (error) { return '' }
  }
  const 从地址取扩展 = (u) => {
    const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(String(u || ''))
    const e = m ? m[1].toLowerCase() : ''
    return ['wav', 'mp3', 'amr', 'silk', 'ogg', 'm4a', 'flac'].includes(e) ? e : 'amr'
  }
  // ① 先问后端：get_record 能直接给 wav（它自己会解 silk）—— 这是最省事的一条路
  if (原) {
    try {
      const r = await 拉任意('get_record', { file: 原, out_format: 'wav' })
      if (r) {
        const 本地 = r.file || r.path
        if (本地 && existsSync(String(本地))) return String(本地)
        if (r.base64) {
          try {
            const f = 落盘(Buffer.from(String(r.base64).replace(/^data:[^,]*,/, ''), 'base64'), 'wav')
            if (f) return f
          } catch (error) {}
        }
      }
    } catch (error) {}
  }
  // ② 网络地址 → 下载
  const 拿地址 = 直链 || (/^https?:/i.test(原) ? 原 : '')
  if (拿地址) {
    try {
      const r = await fetch(拿地址)
      if (r && r.ok) {
        const 字节 = Buffer.from(await r.arrayBuffer())
        const f = 落盘(字节, 从地址取扩展(拿地址))
        if (f) return f
      }
    } catch (error) {}
  }
  // ③ base64:// 或本来就是本地文件
  if (原.startsWith('base64://')) {
    try {
      const f = 落盘(Buffer.from(原.slice('base64://'.length), 'base64'), 'amr')
      if (f) return f
    } catch (error) {}
  }
  if (原 && existsSync(原)) return 原
  return ''
}

/** 不是 wav 就转成 16k 单声道 wav（用 ffmpeg；找不到就原样交给命令，让命令自己想办法） */
async function 转成wav(路径, ffmpeg, 家目录, 名) {
  if (!路径 || /\.wav$/i.test(路径)) return 路径
  if (!ffmpeg) return 路径
  try {
    const 目录 = join(家目录, 'audio')
    mkdirSync(目录, { recursive: true })
    const 出 = join(目录, String(名).replace(/[^a-zA-Z0-9_-]/g, '') + '.wav')
    const 结果 = await new Promise((resolve) => {
      let 子 = null
      try {
        子 = spawn(ffmpeg, ['-y', '-i', 路径, '-ar', '16000', '-ac', '1', 出], { windowsHide: true })
      } catch (error) { return resolve(false) }
      子.on('error', () => resolve(false))
      子.on('close', (码) => resolve(码 === 0 && existsSync(出)))
    })
    return 结果 ? 出 : 路径
  } catch (error) { return 路径 }
}

/** 一条 QQ 语音 → 文字。插件只做三件事：拿到音频 → 交给命令 → 拿回文字。
 *  ⚠️ 没配命令、或者没开开关，就退化成 `[语音]` 三个字（跟以前一样）。 */
async function 转写语音(段, 拉任意, 配置, 选项 = {}) {
  const 模板 = String((配置 && 配置.转写命令) || '')
  if (!配置 || !配置.语音转写 || !模板.includes('{file}')) return '[语音]'
  const 家目录 = 选项.家目录 || ''
  const 名 = 'qq-voice-' + (选项.消息id || Date.now())
  const 本地 = await 语音落文件(段, 拉任意, 家目录, 名)
  if (!本地) return '[语音（没下到音频）]'
  const 就绪 = await 转成wav(本地, 选项.ffmpeg || '', 家目录, 名)
  const 结果 = await 跑命令(模板, 就绪, 配置.转写超时秒)
  if (结果.ok && 结果.文字) return '（语音）' + 结果.文字
  return '[语音（转写失败：' + String(结果.错 || '没输出').slice(0, 60) + '）]'
}

/** 找 ffmpeg：环境变量 → PATH → 装依赖时随手装的那份 imageio-ffmpeg。
 *  语音要转成 wav 才能喂给识别命令，没有 ffmpeg 就只能把原始文件交出去。 */
let ffmpeg缓存 = null
async function 找ffmpeg() {
  if (ffmpeg缓存 !== null) return ffmpeg缓存
  const 试 = async (命令, 参数) => {
    try {
      const 码 = await new Promise((resolve) => {
        let 子 = null
        try { 子 = spawn(命令, 参数, { windowsHide: true }) } catch (error) { return resolve(-1) }
        子.on('error', () => resolve(-1))
        子.on('close', (c) => resolve(c === null ? -1 : c))
      })
      return 码 === 0
    } catch (error) { return false }
  }
  if (process.env.FFMPEG && await 试(process.env.FFMPEG, ['-version'])) return (ffmpeg缓存 = process.env.FFMPEG)
  if (await 试('ffmpeg', ['-version'])) return (ffmpeg缓存 = 'ffmpeg')
  // 装依赖时装了 imageio-ffmpeg 的话，它自带一个静态 ffmpeg
  try {
    const 脚本 = 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'
    const r = await 跑命令('"' + ASRpython + '" -c "' + 脚本.replace(/"/g, '\\"') + '"', '', 20)
    if (r && r.ok && r.文字 && existsSync(r.文字)) return (ffmpeg缓存 = r.文字.trim())
  } catch (error) {}
  return (ffmpeg缓存 = '')
}

// ---------- 配置读写 ----------

function 布(值, 兜) {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜
}

/** 把「绑定」整成干净的清单：类型只能是私聊/群；号码和会话都要有；
 *  **同一个会话只能绑一条**、**同一个聊天也只能绑一条**（串消息就是从这里来的）。
 *  老配置（只有一个私聊会话 + 一个群会话）会自动变成两行，不用手动搬。 */
function 规整绑定(raw, 混, 字, 布, 数) {
  const 出 = []
  const 见会话 = new Set()
  const 见聊天 = new Set()
  // ⭐ 本机改动：先把「本机旧改版」那种行的字段名挪过来 —— 旧行长这样：
  //    { 名, 类型: 'private'|'group', 号, 目标会话, 收, 发, 试运行, 潜水, 只认, 收档, 半收分钟, 自动发 }
  const 挪旧 = (x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x
    const o = { ...x }
    if (o.类型 === 'private') o.类型 = '私聊'
    else if (o.类型 === 'group') o.类型 = '群'
    if (o.号码 == null && o.号 != null) o.号码 = o.号
    if (o.会话 == null && o.目标会话 != null) o.会话 = o.目标会话
    if (o.收档 == null && o.潜水 === true) o.收档 = '点名'   // 旧版的「潜水」= 只被点名才收
    return o
  }
  const 收一条 = (x0) => {
    const x = 挪旧(x0)
    const t = String((x && x.类型) || '').trim()
    const 类型 = t === '私聊' ? '私聊' : (t === '群' ? '群' : '')
    if (!类型) return null
    const 号码 = 字(x && x.号码)
    const 会话 = 字(x && x.会话)
    if (!号码 || !会话) return null
    const 称呼 = (字(x && x.称呼) || (类型 === '群' ? '群里的人' : '对方')).slice(0, 16)
    const 聊天键 = 类型 + ':' + 号码
    if (见聊天.has(聊天键)) return null
    // ⚠️ 2026-10-27（事故修复）：占位符不算「一个会话」—— 两行都填 `新`（要各开一间新屋子，
    //    正是主人要的）时，原来这里会把第二行**整条丢掉**：群行就是这么没的，连带
    //    群号/群会话/转群 一起被反推成空。占位符不参与去重，真实会话号才参与。
    const 是占位 = /^(新|new)(\s|:|$)/i.test(会话)
    if (!是占位 && 见会话.has(会话)) return null   // 一个真实会话只绑一条
    见聊天.add(聊天键)
    if (!是占位) 见会话.add(会话)
    // ⭐ 本机改动：每行自己的投递口径（收档 / 半收分钟 / 自动发 / 预设 / 会话目录 / 只认 / 叫醒）+ 收发开关
    const 档 = 字(x && x.收档)
    return {
      类型, 号码, 会话, 称呼, 门槛: 布(x && x.门槛, false),
      收档: ['全收', '半收', '点名'].indexOf(档) >= 0 ? 档 : '全收',
      半收分钟: 数(x && x.半收分钟, 5, 1, 240),
      自动发: 布(x && x.自动发, true),
      预设: (字(x && x.预设) || 'whale').slice(0, 40),
      会话目录: 字(x && x.会话目录).slice(0, 400),
      只认: 字(x && x.只认).slice(0, 20),
      叫醒: 布(x && x.叫醒, true),
      收: 布(x && x.收, true),
      发: 布(x && x.发, true),
    }
  }
  if (Array.isArray(raw)) {
    for (const x of raw.slice(0, 30)) {
      const r = 收一条(x)
      if (r) 出.push(r)
    }
  }
  if (!出.length) {
    // 老配置迁移：私聊会话 / 群会话 → 两行（也走 收一条，新字段一并带上）
    const 私会话 = 字(混.私聊会话) || 字(混.目标会话)
    const 私号 = 字(混.私聊QQ)
    const 群会话 = 字(混.群会话)
    const 群号2 = 字(混.群号)
    if (私会话 && 私号) { const r = 收一条({ 类型: '私聊', 号码: 私号, 会话: 私会话, 称呼: (字(混.称呼) || '对方').slice(0, 16), 门槛: false }); if (r) 出.push(r) }
    if (群会话 && 群号2) { const r = 收一条({ 类型: '群', 号码: 群号2, 会话: 群会话, 称呼: (字(混.群称呼) || '群里的人').slice(0, 16), 门槛: false }); if (r) 出.push(r) }
  }
  return 出
}

function 归一化(原始) {
  const 是对象 = 原始 && typeof 原始 === 'object' && !Array.isArray(原始)
  const 混 = 是对象 ? { ...默认配置, ...原始 } : { ...默认配置 }
  const 字 = (v) => (typeof v === 'string' ? v.trim() : '')
  const 数 = (v, 兜, 低, 高) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n)) return 兜
    return Math.max(低, Math.min(n, 高))
  }
  const 绑定 = 规整绑定(混.绑定, 混, 字, 布, 数)
  // 老配置迁移：以前是「总开关」带动全部，现在按行走 —— 总开关开过的话，把群那几行补上
  if (布(混.回复门槛, false)) {
    for (const 行 of 绑定) if (行.类型 === '群' && !行.门槛) 行.门槛 = true
  }
  const 私聊行 = 绑定.find((x) => x.类型 === '私聊') || null
  const 群行 = 绑定.find((x) => x.类型 === '群') || null
  return {
    总开关: 布(混.总开关, 默认配置.总开关),
    试运行: 布(混.试运行, 默认配置.试运行),
    // ⭐ 下面这几个老字段现在**从绑定反推**（只留一份真数据，避免两套说法打架）：
    //    私聊会话/群会话 = 绑定里第一条私聊 / 第一条群；老代码还看它们，行为不变。
    私聊会话: 私聊行 ? 私聊行.会话 : '',
    群会话: 群行 ? 群行.会话 : '',
    目标会话: 私聊行 ? 私聊行.会话 : '',
    私聊QQ: 私聊行 ? 私聊行.号码 : 字(混.私聊QQ),
    群号: 群行 ? 群行.号码 : '',
    // ⚠️ 2026-10-25（她报的「群里没收到它的回复」）：这两个老开关界面上已经不显示了，
    //    却还在拦发送 —— 她加了群绑定、但 转群 还是默认 false，于是群里一条都收不到。
    //    现在**有那一行就代表要发**：直接从绑定推。
    转私聊: 绑定.some((b) => b.类型 === '私聊'),
    转群: 绑定.some((b) => b.类型 === '群'),
    NapCat: 字(混.NapCat) || 默认配置.NapCat,
    令牌: 字(混.令牌),
    // ⭐ 2026-10-30：第二根线（QQ 官方机器人）
    协议: (字(混.协议) === 'qq-official' ? 'qq-official' : 'onebot11'),
    官方AppID: 字(混.官方AppID).slice(0, 40),
    官方密钥: 字(混.官方密钥).slice(0, 200),
    官方沙箱: 布(混.官方沙箱, false),
    官方intents: 数(混.官方intents, 默认配置.官方intents, 0, 2 ** 31),
    官方主人openid: 字(混.官方主人openid).slice(0, 80),
    绑定,
    收图: 布(混.收图, 默认配置.收图),
    发图: 布(混.发图, 默认配置.发图),
    收图最多: 数(混.收图最多, 默认配置.收图最多, 1, 10),
    图上限MB: 数(混.图上限MB, 默认配置.图上限MB, 1, 30),
    图片根目录: 字(混.图片根目录),
    称呼: (私聊行 ? 私聊行.称呼 : (字(混.称呼) || 默认配置.称呼)),
    // ⚠ 老字段，只用来迁移：以前「总开关 + 每行」两个一起管太难懂，
    //    现在**只认每一行自己的门槛**；老配置里总开关是开的，就给群那几行默认打开。
    回复门槛: 布(混.回复门槛, 默认配置.回复门槛),
    只发标记内: 布(混.只发标记内, 默认配置.只发标记内),
    只回QQ唤醒: 布(混.只回QQ唤醒, 默认配置.只回QQ唤醒),
    语音转写: 布(混.语音转写, 默认配置.语音转写),
    转写命令: 字(混.转写命令).slice(0, 400),
    语音模型目录: 字(混.语音模型目录).slice(0, 400),
    转写超时秒: 数(混.转写超时秒, 默认配置.转写超时秒, 5, 600),
    补投窗口分: 数(混.补投窗口分, 默认配置.补投窗口分, 1, 240),
    长回复拆段: 布(混.长回复拆段, 默认配置.长回复拆段),
    拆段间隔毫秒: 数(混.拆段间隔毫秒, 默认配置.拆段间隔毫秒, 0, 5000),
    拆段抖动毫秒: 数(混.拆段抖动毫秒, 默认配置.拆段抖动毫秒, 0, 5000),
    发送限速: 布(混.发送限速, 默认配置.发送限速),
    最小间隔秒: 数(混.最小间隔秒, 默认配置.最小间隔秒, 0, 120),
    抖动秒: 数(混.抖动秒, 默认配置.抖动秒, 0, 30),
    每分钟上限: 数(混.每分钟上限, 默认配置.每分钟上限, 1, 300),
    每小时上限: 数(混.每小时上限, 默认配置.每小时上限, 1, 3000),
    门槛真停轮: 布(混.门槛真停轮, 默认配置.门槛真停轮),
    // ⭐ 2026-10-27：深夜静默 + 接话概率 / 冷却（上面默认配置里那一段的注释有口径）
    静默时段: (字(混.静默时段) || '').slice(0, 40),
    静默两边都停: 布(混.静默两边都停, 默认配置.静默两边都停),
    接话概率: 数(混.接话概率, 默认配置.接话概率, 0, 100),
    冷却分钟: 数(混.冷却分钟, 默认配置.冷却分钟, 0, 240),
    私聊也限: 布(混.私聊也限, 默认配置.私聊也限),
    群称呼: (群行 ? 群行.称呼 : (字(混.群称呼) || 默认配置.群称呼)),
    // ⭐ 本机改动：点名时认的几个称呼（空格分隔）
    别名: (字(混.别名) || 默认配置.别名).slice(0, 200),
  }
}

// ---------- 图片小工具（两个方向共用）----------
// ⭐ 2026-10-22 加：QQ 的图片段（OneBot）可能给 http url、本地路径、base64 三种形态，
//    这里统一成字节；大小和类型都在收的时候判，判不了就当 jpeg。

/** 收进来的图存一份到这儿（纯文本模型看不见图，至少能从文字里找到路径） */
/**
 * ⭐ 2026-10-23：会话 id 有两种写法（`xxx` / `session-xxx`）。找agent 两种都认，
 *    但事件过滤、归档判断、设置页高亮这些地方原来是**字面比较** ⇒ 存的是裸 id 时就对不上。
 *    统一用「去掉 session- 前缀」的键来比。
 */
const 会话键 = (v) => {
  const s = String(v == null ? '' : v).trim()
  return s.startsWith('session-') ? s.slice('session-'.length) : s
}

const 收图目录 = join(目录, 'qq-bridge-inbox')

/**
 * ⭐ 2026-10-22：DSH 存图时会留一份「归一化副本」（官方文档原话：may be resized or re-encoded），
 *    GIF 到这一步就变成静态 webp 了 —— 所以回发时必须用**我们自己留的原图**。
 *    这张表记「附件 id → 我们存的原图路径」，回发时先查它。
 */
const 收图表 = join(目录, 'qq-bridge-received.json')

function 读收图表() {
  try {
    const j = JSON.parse(readFileSync(收图表, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch (error) {
    return {}
  }
}

/** 路径统一：去掉两头引号/空格，Windows 下大小写不敏感 */
const 清路径 = (p) => String(p || '').trim().replace(/^["']+|["']+$/g, '').trim()

/**
 * 记「附件 / DSH 那份只读副本 → 我们存的原图」。
 * ⚠ 两个键都要记：伙伴回发时可能用附件 id（附件块），也可能照抄 DSH 给的那条
 *   只读副本路径（正文里的 markdown 图）—— 后者是常见情况，第一次就漏了。
 */
function 记收图(附件id, 副本路径, 原图路径) {
  const 原 = String(原图路径 || '').trim()
  if (!原) return
  const id = String(附件id || '').trim()
  const 副 = 清路径(副本路径)
  if (!id && !副) return
  try {
    const 表 = 读收图表()
    const 记 = { p: 原, t: Date.now() }
    if (id) 表['id:' + id] = 记
    if (副) 表['p:' + 副.toLowerCase()] = 记
    // 只留最近 200 条，别让这个文件无限长
    const 留 = Object.entries(表).sort((a, b) => Number((b[1] && b[1].t) || 0) - Number((a[1] && a[1].t) || 0)).slice(0, 200)
    writeFileSync(收图表, JSON.stringify(Object.fromEntries(留)), 'utf8')
  } catch (error) {}
}

/** 这张图能不能换回原图？键可以是 `id:<附件id>`，也可以是 `p:<副本路径>` */
function 原图路径(键) {
  const k = String(键 || '').trim()
  if (!k) return ''
  const 表 = 读收图表()
  const 记 = 表[k] || 表[k.toLowerCase()] || 表[String(k).replace(/^id:/, '')]
  const p = 记 && typeof 记.p === 'string' ? 记.p : ''
  if (!p) return ''
  try { return existsSync(p) ? p : '' } catch (error) { return '' }
}

const 扩展 = (类) => (类 === 'image/png' ? 'png' : 类 === 'image/gif' ? 'gif' : 类 === 'image/webp' ? 'webp' : 'jpg')

function 看图类(字节) {
  try {
    if (字节[0] === 0x89 && 字节[1] === 0x50) return 'image/png'
    if (字节[0] === 0x47 && 字节[1] === 0x49) return 'image/gif'
    if (字节[0] === 0x52 && 字节[1] === 0x49 && 字节[8] === 0x57) return 'image/webp'
  } catch (error) {}
  return 'image/jpeg'
}

/** 从 OneBot 的图片段里把字节抠出来：url → file(本地/base64://) 依次试 */
async function 取图字节(数据) {
  const d = 数据 || {}
  const url = typeof d.url === 'string' ? d.url.trim() : ''
  if (url) {
    if (url.startsWith('file://')) {
      try { return readFileSync(new URL(url)) } catch (error) {}
    } else if (/^https?:/i.test(url)) {
      try {
        const r = await fetch(url)
        if (r.ok) return Buffer.from(await r.arrayBuffer())
      } catch (error) {}
    }
  }
  const f = typeof d.file === 'string' ? d.file.trim() : ''
  if (f.startsWith('base64://')) {
    try { return Buffer.from(f.slice('base64://'.length), 'base64') } catch (error) {}
  }
  if (f && (f.includes('\\') || f.includes('/'))) {
    try { return readFileSync(f) } catch (error) {}
  }
  return null
}

/** 存一份到收图目录，返回路径（存不下就返回空串，不影响转图） */
function 存一张(名字, 字节, 类) {
  try {
    mkdirSync(收图目录, { recursive: true })
    const p = join(收图目录, `${名字}.${扩展(类)}`)
    writeFileSync(p, 字节)
    return p
  } catch (error) {
    return ''
  }
}

function 读配置() {
  try {
    return 归一化(JSON.parse(readFileSync(配置文件, 'utf8')))
  } catch (error) {
    return 归一化(null)
  }
}

function 写配置(配置) {
  try {
    mkdirSync(目录, { recursive: true })
    writeFileSync(配置文件, JSON.stringify(配置, null, 2), 'utf8')
    return true
  } catch (error) {
    return false
  }
}

// ---------- 纯函数（导出给冒烟测试喂） ----------

/** 从一条 assistant 消息里只抽出正文（text 块拼起来；reasoning / image 都不要）。 */
export function 提取正文(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/** 拼一个 OneBot「私聊 text 段」消息体。 */
export function 私人消息体(text) {
  return { user_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** 拼一个 OneBot「群 text 段」消息体。 */
export function 群消息体(text) {
  return { group_id: 0, message: [{ type: 'text', data: { text } }] }
}

/** ⭐ 2026-10-22：从一条 assistant 消息里挑出图片块（要发到 QQ 的那几张）。 */
export function 提取图块(message) {
  if (!message || !Array.isArray(message.content)) return []
  return message.content.filter((b) => b && b.type === 'image' && b.attachment).slice(0, 10)
}

/** 拼一个 OneBot「图片段」（base64 直接塞，不依赖 QQ 那边能不能访问本地文件）。 */
export function 图片段(base64) {
  return { type: 'image', data: { file: 'base64://' + String(base64) } }
}

/**
 * ⭐ 2026-10-22：正文里那种 markdown 图片 `![名字](路径)` 也当图片发。
 *    伙伴发贴纸就是这么发的（`![小肥鱼](_stickers/feiyu-test.webp)`）——
 *    以前只认附件块，这种一律被当成普通文字发过去，QQ 那边看到的是一串 markdown。
 * @returns {净文字, 图: [{kind:'url'|'path', value}]}
 */
export function 抠正文图(文字) {
  const 图 = []
  const 净文字 = String(文字 || '')
    .replace(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g, (全, 路径) => {
      const p = String(路径 || '').trim()
      if (!p) return ''
      if (/^https?:\/\//i.test(p)) {
        if (!图.some((x) => x.value === p)) 图.push({ kind: 'url', value: p })
        return ''
      }
      if (!图.some((x) => x.value === p)) 图.push({ kind: 'path', value: p })
      return ''
    })
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { 净文字, 图 }
}

// ⭐⭐⭐ 本机改动（本机改版移植）—— 从这一行到「本机改动到此为止」之间全是本机加的东西 ⭐⭐⭐
//
// 一、收档：投递前的便宜过滤（群专用，确定性判定）—— 全收 / 半收 / 点名。
// 二、归属头：转进会话的每条消息都先标清楚「谁说的」。
// 三、表情包：正文里的 [表情: 描述] → 图库里的真图（真图在「发到QQ」那一步才加）。
// 四、发图白名单：只允许发图库 / 收图目录 / 附件目录 / 各个工作区里的文件。

/** 她最近一次真的出声的时刻：键是「类型:号码」（群 = '群:964277762'，私聊 = '私聊:850705216'） */
const 出声表 = new Map()

/** ⭐ 记一笔「她刚在这间聊天里说过话」。传绑定行、或直接传「类型:号码」字符串都行。 */
function 记出声(什么) {
  try {
    const 键 = (什么 && typeof 什么 === 'object')
      ? String(什么.类型 || '') + ':' + String(什么.号码 || '')
      : String(什么 == null ? '' : 什么).trim()
    if (!键 || 键 === ':') return
    出声表.set(键, Date.now())
  } catch (error) {}
}

/** ⭐ 读出来（毫秒时间戳；没记过 = 0） */
function 出声时刻(键) {
  try { return Number(出声表.get(String(键 == null ? '' : 键).trim()) || 0) } catch (error) { return 0 }
}

/** ⭐ 点名了没：正文里出现 @ / 别名表里的词 / 主人号的任一写法（850705216、#850705216）。 */
function 点名了(文字, 配置, 本人号 = 0) {
  const t = String(文字 == null ? '' : 文字)
  if (!t) return false
  if (/[@＠]/.test(t)) return true
  const 主 = Number(本人号) || Number((配置 && 配置.私聊QQ) || 0)
    || Number((((配置 && 配置.绑定) || []).find((x) => x && x.类型 === '私聊') || {}).号码) || 0
  if (主) {
    const s = String(主)
    if (t.indexOf(s) >= 0 || t.indexOf('#' + s) >= 0) return true
  }
  for (const 词 of String((配置 && 配置.别名) || '').split(/\s+/)) {
    if (词 && t.indexOf(词) >= 0) return true
  }
  return false
}

/** ⭐ 2026-10-27（深夜静默 · 纯函数）：此刻在不在「静默时段」里。
 *  时段形如 `23:00-08:00` / `23:00~8:00`（跨零点也认），空着 = 不静默。
 *  写歪了（认不出来）也当**不静默** —— 宁可少拦一件事，也别因为一个笔误让整条线夜里哑掉。 */
function 在静默里(配置, 现在 = new Date()) {
  const 段 = String((配置 && 配置.静默时段) || '').trim()
  if (!段) return false
  const m = /^(\d{1,2}):(\d{2})\s*[-~～到]\s*(\d{1,2}):(\d{2})$/.exec(段)
  if (!m) return false
  const 拆分 = (h, mi) => (Number(h) % 24) * 60 + Math.max(0, Math.min(59, Number(mi)))
  const 起 = 拆分(m[1], m[2])
  const 止 = 拆分(m[3], m[4])
  if (起 === 止) return false
  let 现在分 = 0
  try {
    现在分 = Number(现在.getHours()) * 60 + Number(现在.getMinutes())
  } catch (error) {
    return false
  }
  return 起 < 止 ? (现在分 >= 起 && 现在分 < 止) : (现在分 >= 起 || 现在分 < 止)
}

/** ⭐ 收档判定（纯函数）：投递前问一句「这条该收吗」。
 *  · 全收 → 都收；
 *  · 半收 → 点名了、**或者**她刚在这间说过话（半收分钟以内）；
 *  · 点名 → 只有点名了才收。
 *  最近出声 = 毫秒时间戳（出声时刻(键)），0 = 没说过。 */
function 要收吗(配置, 行, 文字, 本人号, 最近出声) {
  if (!行) return true
  const 档 = String(行.收档 || '全收')
  if (档 !== '半收' && 档 !== '点名') return true
  if (点名了(文字, 配置, 本人号)) return true
  if (档 === '点名') return false
  const 分钟 = Number(行.半收分钟) > 0 ? Number(行.半收分钟) : 5
  const t = Number(最近出声) || 0
  return t > 0 && Date.now() - t < 分钟 * 60000
}

/** ⭐ 归属头（谁说的）：
 *    群·主人 → 〔QQ 群 964277762〕★主人·灰⑨(#850705216)：
 *    群·群友 → 〔QQ 群 964277762〕（群友）龙竹(#123456)：
 *    私聊    → 〔QQ 私聊〕★主人(#850705216)：   ← 一对一，本来就不用报名字
 *    没昵称没号 → 〔…〕（群友）某人：
 *  条 = OneBot 那条原始消息（看 .sender / .user_id）；主号 = 主人自己的 QQ 号。
 *  时刻 = 可选：这条消息的 unix 秒（OneBot 的 .time）。给了就带上 ` HH:MM` ——
 *    「同一分钟里的连续几条属于同一场」是判断谁在对谁说话最便宜的线索，而它一直都在，只是以前没往上传。
 * ⭐ 2026-10-27（主人定的边界）：**这是证据，不是结论** —— 时刻可以进归属头；
 *    替她把「谁在回谁」读好了塞进正文不行（那属于偷懒，她得自己看上下文）。 */
function 归属头(是群, 群号, 条, 主号, 时刻) {
  const 昵 = String((条 && 条.sender && (条.sender.card || 条.sender.nickname)) || '').trim()
  const 主 = Number(主号) || 0
  const 主人吗 = !!主 && Number((条 && 条.user_id) || 0) === 主
  const 标 = 主人吗 ? '★主人' : (是群 ? '（群友）' : '')
  // 私聊没昵称就不写名字（写成 QQ 号只是重复一遍数字）；群里没昵称就写「某人」
  const 名 = 昵 || (是群 ? '某人' : '')
  const 号 = 条 && 条.user_id ? '(#' + 条.user_id + ')' : ''
  const 点 = 短时刻(时刻)
  return '〔' + (是群 ? 'QQ 群 ' + 群号 : 'QQ 私聊') + '〕' + 标 + (名 ? (主人吗 ? '·' + 名 : 名) : '') + 号 + (点 ? ' ' + 点 : '') + '：'
}

/** ⭐ 2026-10-27：unix 秒 → 看得见的时刻。今天 `HH:MM`；昨天及更早 `MM-DD HH:MM`；拿不到 = ''（不编）。 */
function 短时刻(秒) {
  const t = Number(秒) || 0
  if (t <= 0) return ''
  const d = new Date(t * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const 两 = (n) => String(n).padStart(2, '0')
  const 时 = 两(d.getHours()) + ':' + 两(d.getMinutes())
  let 今 = new Date()
  const 同日 = d.getFullYear() === 今.getFullYear() && d.getMonth() === 今.getMonth() && d.getDate() === 今.getDate()
  return 同日 ? 时 : (两(d.getMonth() + 1) + '-' + 两(d.getDate()) + ' ' + 时)
}

/** ⭐ 表情图库都在哪：DSH_HOME 下的 meme-packs + 各 profile 里 dsh-meme 自带的 memes */
function 表情根们() {
  const 根 = [join(目录, 'meme-packs')]
  try {
    const 包 = join(目录, 'node_modules', 'dsh-meme', 'memes')
    if (existsSync(包)) 根.push(包)
    for (const e of readdirSync(join(目录, 'profiles'), { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const 此 = join(目录, 'profiles', e.name, 'node_modules', 'dsh-meme', 'memes')
      if (existsSync(此)) 根.push(此)
    }
  } catch (error) {}
  return 根
}

const 表情表 = new Map()    // 文件名（去扩展名，小写）+ 全名 → 绝对路径
const 表情标题 = new Map()  // caption（小写）→ 绝对路径（从各图库包的 index.db 读）
let 表情扫过 = false

/** ⭐ 扫一遍图库目录，把「文件名 → 路径」建起来（图库包里的图片都在下面几层） */
function 建表情表() {
  if (表情扫过) return
  表情扫过 = true
  const 走 = (d, 层) => {
    if (层 > 5) return
    let 项 = []
    try { 项 = readdirSync(d, { withFileTypes: true }) } catch (error) { return }
    for (const e of 项) {
      const p = join(d, e.name)
      if (e.isDirectory()) { 走(p, 层 + 1); continue }
      if (!/\.(gif|png|jpe?g|webp)$/i.test(e.name)) continue
      const 键 = e.name.replace(/\.[^.]+$/, '').toLowerCase()
      if (键 && !表情表.has(键)) 表情表.set(键, p)
      const 全名 = e.name.toLowerCase()
      if (!表情表.has(全名)) 表情表.set(全名, p)
    }
  }
  for (const r of 表情根们()) 走(r, 0)
}

/** ⭐ 找一张表情图（纯函数）：caption 精确 → caption 包含 → 文件名包含；找不到回空串。 */
function 表情查找(描述) {
  const k = String(描述 == null ? '' : 描述).trim().toLowerCase().replace(/^["「『]+|["」』]+$/g, '').trim()
  if (!k) return ''
  for (const [名, p] of 表情标题) if (名 === k) return p
  for (const [名, p] of 表情标题) if (名.length > 1 && (名.indexOf(k) >= 0 || k.indexOf(名) >= 0)) return p
  建表情表()
  for (const [名, p] of 表情表) if (名 === k) return p
  for (const [名, p] of 表情表) if (名.length > 1 && (名.indexOf(k) >= 0 || k.indexOf(名) >= 0)) return p
  return ''
}

/** ⭐ 发图白名单：只有这些根下面的文件才准发出去
 *  （表情图库 / 收图目录 / 附件目录 / 调用方给的额外根 —— 一般是各个工作区）。
 *  额外根们 = 工作区路径（在 apply 里从 workspaceRegistry.list() 拿）。 */
function 图在内(p, 额外根们 = []) {
  const 原 = String(p == null ? '' : p).trim()
  if (!原) return false
  const 许 = [
    ...表情根们(),
    收图目录,
    join(目录, 'attachments'),
    ...(Array.isArray(额外根们) ? 额外根们 : []),
  ]
  let 全 = ''
  try { 全 = resolve(原) } catch (error) { return false }
  for (const r of 许) {
    const R = String(r || '').trim()
    if (!R) continue
    let 绝对 = R
    try { 绝对 = resolve(R) } catch (error) { continue }
    if (全 === 绝对 || 全.startsWith(绝对 + sep)) return true
  }
  return false
}

/** ⭐ 读图库包的 index.db（node:sqlite 只读）把 caption 也变成索引键。
 *  ⚠ 各家的图库包表名/列名不一样（本机 dafeiyu-001 是**表 memes**、列 path / file_name / caption），
 *    所以先 PRAGMA table_info 看一眼再用；拿不到就退化成只按文件名匹配。
 *  ⚠ 只读，不改图库一个字节。 */
async function 补表情索引() {
  let DatabaseSync = null
  try { ({ DatabaseSync } = await import('node:sqlite')) } catch (error) { return }
  if (!DatabaseSync) return
  for (const 根 of 表情根们()) {
    let 包们 = []
    try {
      for (const e of readdirSync(根, { withFileTypes: true })) {
        if (e.isDirectory()) 包们.push(join(根, e.name))
        else if (e.isFile() && e.name === 'index.db') 包们.push(根)
      }
    } catch (error) { continue }
    for (const 包 of 包们) {
      const db = join(包, 'index.db')
      if (!existsSync(db)) continue
      let 库 = null
      try {
        库 = new DatabaseSync(db, { readOnly: true })
        let 表们 = []
        try { 表们 = 库.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => String((x && x.name) || '')) } catch (error) { 表们 = [] }
        const 表 = ['stickers', 'memes'].find((n) => 表们.indexOf(n) >= 0) || 表们[0] || ''
        if (!表) continue
        let 列 = []
        try { 列 = 库.prepare('PRAGMA table_info(' + 表 + ')').all().map((x) => String((x && x.name) || '')) } catch (error) { 列 = [] }
        if (!列.length) continue
        const 路径列 = ['path', 'file', 'file_name', 'filename', 'name'].find((n) => 列.indexOf(n) >= 0) || ''
        if (!路径列) continue
        let 行们 = []
        try { 行们 = 库.prepare('SELECT * FROM ' + 表).all() } catch (error) { 行们 = [] }
        for (const r of 行们) {
          const 相对 = String((r && r[路径列]) || '').trim()
          if (!相对) continue
          const 全 = /^([a-zA-Z]:[\\/]|\/)/.test(相对) ? 相对 : join(包, 相对)
          const 名 = String((r && (r.file_name || r.name)) || 相对).replace(/^.*[\\/]/, '')
          for (const 键 of [r && r.caption, 名, 名.replace(/\.[^.]+$/, '')]) {
            const k = String(键 || '').trim().toLowerCase()
            if (k && !表情标题.has(k)) 表情标题.set(k, 全)
          }
        }
      } catch (error) {
        // 这个包读不了就算了，别的包接着读
      } finally {
        try { if (库) 库.close() } catch (error) {}
      }
    }
  }
}
// 起来就读一遍（异步、不挡装载；读不到就只按文件名匹配）
void 补表情索引().catch(() => {})

// ⭐⭐⭐ 本机改动到此为止（下面又是上游的代码）⭐⭐⭐

// 包根：用来读自己的 package.json（版本 + 仓库地址）
const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')

export function apply(ctx) {
  // ⭐ 设置页那个「检查更新」：查这个插件自己的仓库
  createSelfUpdate({ packageRoot: 包根, diag: 记账 }).register(ctx, 路由前缀)
  // ---------- 状态 ----------

  const 日志 = []
  // ⚠ 2026-10-23 修（反馈：换过「目标会话」之后，新会话第 2 轮起就静默不发）
  //   真因：这两个表原来都是**全局一份**，只认「轮号」，不认「哪个会话」。
  //     从 A 换到 B 之后，B 的轮号一旦跟 A 撞上，就被当成「这轮已经发过了」跳过；
  //     而调用处是 `void 落地一发(...)`，没有日志 → 日志里一片空白，很难查。
  //   → 现在都按会话分开：上一轮按会话键存一份；已发的键是「会话键:轮号」。
  const 空轮 = () => ({ 轮号: -1, 文本: '', 图们: [] })
  const 上一轮们 = new Map() // 会话键 -> { 轮号, 文本, 图们 }
  const 已发轮 = new Set() // 「会话键:轮号」
  const 已转消息 = new Set() // 已经转发进 DSH 的 QQ 消息 id（防重复转）
  // ⭐ 本机改动（回声锁，2026-10-25 实测踩过）：她自己发出去的话会被当成「群里来了新消息」再投回来。
  //   上游的群过滤靠「只认」（默认只认主人号），可一旦某行设成 只认='0'（谁都收）连她自己的也收进来
  //   ⇒ 她回一句 → 又被投回来 → 无限回声。两道锁：① 记下桥自己发出去的 message_id；
  //   ② 认出「自己这个 QQ 号」（get_login_info 拿一次），它发的消息一律不算新消息。
  const 自己发过 = new Set() // 桥自己发出去的 OneBot message_id
  let 自己号 = 0             // 这个 QQ 账号自己的号
  let 自己号试过 = 0         // 上次尝试拿自己号的时间（失败别每条消息都打一次）
  async function 拿自己号(配置) {
    if (自己号) return 自己号
    if (Date.now() - 自己号试过 < 60000) return 0
    自己号试过 = Date.now()
    try {
      const r = await fetch(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: 请求头(配置), body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok' && Number(j.data && j.data.user_id)) {
        自己号 = Number(j.data.user_id)
        存水位()
        记账('回声锁：记住自己这个 QQ 号 = ' + 自己号)
      }
    } catch (error) { /* 拿不到就算了，下次再试 */ }
    return 自己号
  }
  // ⚠️ 2026-10-25（她报的「我没发新消息，它却自己回了一条」）：
  //   这两个东西以前**只存在内存里** —— 插件一重启（今天改了鱼的心情 / 换插件都要重启），
  //   「看到哪儿了」就归零 ⇒ 最近那十几条历史消息会**被当成新消息重投一遍**，
  //   于是她一点开会话就冒出一条自动回复。现在落盘到 qq-bridge-state.json，重启接着上次。
  const 状态文件 = join(dirname(配置文件), 'qq-bridge-state.json')
  const 读水位 = () => {
    try {
      const j = JSON.parse(readFileSync(状态文件, 'utf8'))
      if (j && j.上次 && typeof j.上次 === 'object') for (const [k, v] of Object.entries(j.上次)) 上次时间.set(String(k), Number(v) || 0)
      if (j && Array.isArray(j.已转)) for (const id of j.已转.slice(-300)) 已转消息.add(id)
      if (j && Array.isArray(j.自己发)) for (const id of j.自己发.slice(-300)) 自己发过.add(String(id))
      if (j && Number(j.自己号)) 自己号 = Number(j.自己号)
    } catch (error) { /* 没有就算了，第一次跑 */ }
  }
  const 存水位 = () => {
    try {
      writeFileSync(状态文件, JSON.stringify({
        上次: Object.fromEntries([...上次时间].map(([k, v]) => [k, Number(v) || 0])),
        已转: [...已转消息].slice(-300),
        自己发: [...自己发过].slice(-300),
        自己号: Number(自己号) || 0,
      }, null, 2), 'utf8')
    } catch (error) { /* 存不下不影响转消息 */ }
  }
  // ⭐ 0.6.0：每个「聊天」各自记「看到哪儿了」（键 = 类型:号码）—— 多群多私聊才不会互相串
  const 上次时间 = new Map()
  // ⭐ 本机改动（修上游真 bug）：上游把 读水位() 放在「上次时间」声明**之前**调用 ⇒ 里面那句
  //   上次时间.set() 抛 ReferenceError（TDZ）被 try 悄悄吞掉 —— 水位/已转其实从来没恢复过，
  //   重启后会把最近几十条历史当新消息重投。挪到声明之后调用。
  读水位()

  function 记账(文本) {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    const 时间 = `${补(d.getMonth() + 1)}-${补(d.getDate())} ${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`
    日志.push({ 时间, 文本 })
    if (日志.length > 日志上限) 日志.shift()
    try {
      ctx.logger?.info(`qq-bridge: ${文本}`)
    } catch (error) {}
  }

  /** 请求头：填了「令牌」就带 Bearer；没填就照旧（老 NapCat 不鉴权，零变化） */
  const 请求头 = (配置, 带体 = true) => {
    const h = 带体 ? { 'content-type': 'application/json', 'user-agent': 'dsh-qq-bridge' } : { 'user-agent': 'dsh-qq-bridge' }
    const t = String((配置 && 配置.令牌) || '').trim()
    if (t) h.authorization = 'Bearer ' + t
    return h
  }

  // ── 出站限速（2026-10-25，主人口径：限制发送频率）──────────────
  //  规矩：同一聊天，两条之间至少隔「最小间隔秒 + 0~抖动秒」；一分钟/一小时各有硬上限；
  //        要等超过 90 秒的宁可这条不发（记账留痕），也不攒着一起轰。
  //  收口在 发一个() 里、只对 send_* 生效 —— 探活/取历史/上传不过闸。
  const 发信记录 = new Map() // 聊天键 -> 最近一小时的发送时间戳
  const 算等待 = (键, 配置, 现在) => {
    const 记录 = (发信记录.get(键) || []).filter((t) => 现在 - t < 3600000)
    发信记录.set(键, 记录)
    if (配置 && 配置.发送限速 === false) return { 等: 0, 原因: '' }
    const 最小 = Math.max(0, Number(配置.最小间隔秒) || 0) * 1000
      + Math.floor(Math.random() * Math.max(0, Number(配置.抖动秒) || 0) * 1000)
    let 等 = 0
    let 原因 = ''
    const 上一条 = 记录.length ? 记录[记录.length - 1] : 0
    if (上一条 && 现在 - 上一条 < 最小) { 等 = 最小 - (现在 - 上一条); 原因 = '最小间隔' }
    const 分钟上限 = Math.max(1, Number(配置.每分钟上限) || 6)
    const 分钟窗 = 记录.filter((t) => 现在 - t < 60000)
    if (分钟窗.length >= 分钟上限) {
      const 要等 = 分钟窗[分钟窗.length - 分钟上限] + 60000 - 现在
      if (要等 > 等) { 等 = 要等; 原因 = '每分钟上限' }
    }
    const 小时上限 = Math.max(1, Number(配置.每小时上限) || 60)
    if (记录.length >= 小时上限) {
      const 要等 = 记录[记录.length - 小时上限] + 3600000 - 现在
      if (要等 > 等) { 等 = 要等; 原因 = '每小时上限' }
    }
    return { 等: Math.max(0, 等), 原因 }
  }
  async function 限速(配置, 体) {
    const 键 = 体 && (体.group_id ? 'group:' + 体.group_id : 体.user_id ? 'private:' + 体.user_id : '')
    if (!键) return true
    let 报过 = false
    for (;;) {
      const { 等, 原因 } = 算等待(键, 配置, Date.now())
      if (等 <= 0) {
        const 记录 = 发信记录.get(键) || []
        记录.push(Date.now())
        发信记录.set(键, 记录)
        return true
      }
      if (等 > 90000) { 记账('限速：要等 ' + Math.round(等 / 1000) + ' 秒太久，这条不发（' + 原因 + '）'); return false }
      if (!报过) { 记账('限速：等 ' + (等 / 1000).toFixed(1) + ' 秒再发（' + 原因 + '）'); 报过 = true }
      await new Promise((r) => setTimeout(r, Math.min(等, 15000)))
    }
  }

  async function 发一个(base, action, 体, 配置) {
    try {
      // 只拦真正发消息的调用；探活、取历史、上传不过闸
      if (/^send_(private|group|forward)_msg$/.test(String(action))) {
        if (!(await 限速(配置, 体))) return { action, ok: false, 数据: { 错: '被限速丢弃', 限速: true } }
      }
      const r = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: 请求头(配置),
        body: JSON.stringify(体),
      })
      const j = await r.json()
      return { action, ok: !!(j && j.status === 'ok' && j.retcode === 0), 数据: j }
    } catch (error) {
      return { action, ok: false, 数据: { 错: String((error && error.message) || error) } }
    }
  }

  /** 把一段长文字按空行拆成自然段（没有空行就整段）。 */
  function 按段拆(文字) {
    const 段 = String(文字 || '')
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return 段
  }

  /**
   * 相对路径的图按哪儿找：
   *   ① 设置里的「图片根目录」（填了就以它为准）
   *   ② **目标会话所在的那个工作区**（自动的，一般不用填）
   *   ③ 其它登记过的工作区
   *   ④ 进程当前目录 ⑤ <DSH_HOME>/workspace ⑥ 用户主目录
   * 找到就返回绝对路径。
   */
  function 找本地图(p, 配置) {
    const 原 = String(p || '').trim()
    if (!原) return ''
    const 试 = []
    if (/^[a-zA-Z]:[\\/]/.test(原) || 原.startsWith('\\\\') || 原.startsWith('/')) 试.push(原)
    else {
      const 根们 = []
      const 设 = String(配置.图片根目录 || '').trim()
      if (设) 根们.push(设)
      try {
        const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
        const 列表 = (登记 && typeof 登记.list === 'function' ? 登记.list() : []) || []
        const 目标 = String(配置.目标会话 || '')
        // ⭐ 先把「目标会话所在的工作区」排到前面 —— 这个才是它平时待的地方
        const 排 = 列表.slice().sort((a, b) => {
          const A = a && Array.isArray(a.sessionIds) && a.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          const B = b && Array.isArray(b.sessionIds) && b.sessionIds.map(String).indexOf(目标) >= 0 ? 0 : 1
          return A - B
        })
        for (const w of 排) {
          const d = w && (typeof w.path === 'string' ? w.path : (w.directory || w.dir || w.root))
          if (typeof d === 'string' && d) 根们.push(d)
        }
      } catch (error) {}
      根们.push(process.cwd(), join(目录, 'workspace'), homedir())
      for (const r of 根们) 试.push(join(String(r), 原))
    }
    for (const 全 of 试) {
      try { if (existsSync(全)) return 全 } catch (error) {}
    }
    记账('找不到这张图：' + 原 + '（试过：' + 试.slice(0, 4).join(' ｜ ') + ' 等 ' + 试.length + ' 个位置；可在设置里填「图片根目录」）')
    return ''
  }

  /** ⭐ 本机改动：发图白名单的「额外根」= 登记过的各个工作区（图库/收图目录/附件目录在纯函数里管） */
  const 工作区根们 = () => {
    const 根 = []
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 列表 = (登记 && typeof 登记.list === 'function' ? 登记.list() : []) || []
      for (const w of 列表) {
        const d = w && (typeof w.path === 'string' ? w.path : (w.directory || w.dir || w.root))
        if (typeof d === 'string' && d) 根.push(d)
      }
    } catch (error) {}
    return 根
  }
  /** ⭐ 本机改动：这张图准不准发出去（白名单本体是上面那个纯函数 图在内） */
  const 图在内吗 = (p) => 图在内(p, 工作区根们())

  /** 把一句正文发到该发的地方（私聊 / 群）；按空行拆段，一段一条连发。⭐ 末尾再加上图片。 */
  async function 发到QQ(配置, 原文字, 图们, 方向 = '') {
    // ⭐ 0.6.0：方向 = 会话键；拿它反查「这条绑的是哪个聊天」，然后只发那一个
    const 行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 会话键(方向)) || null
    const 出 = []
    // ⭐ 本机改动（表情包接线）：正文里的 [表情: 描述] 先换成图库里的真图 —— 每轮最多 1 张
    //   （已经要发的图算进去：这一轮已经有别的图了，表情那张就不发，只记一笔账）
    let 净原文 = String(原文字 || '')
    let 表情图 = ''
    const 标们 = [...净原文.matchAll(/\[表情[:：]\s*([^\]\n]{1,40})\]/g)]
    if (标们.length) {
      const 找到 = 表情查找(标们[0][1])
      if (找到 && 图在内吗(找到)) 表情图 = 找到
      else if (找到) 记账('这张表情不在允许的目录里，没发：' + 找到)
      else 记账('表情标记没配到图（' + 标们[0][1] + '），这轮只发文字')
      if (标们.length > 1) 记账('这轮有 ' + 标们.length + ' 个表情标记，按分寸只发第一张')
      净原文 = 净原文.replace(/\[表情[:：]\s*[^\]\n]{1,40}\]/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    }
    // ⭐ 正文里的 markdown 图（贴纸就是这么发的）也当图片发；抠掉之后正文更干净
    const 抠过 = 配置.发图 ? 抠正文图(净原文) : { 净文字: String(净原文 || ''), 图: [] }
    const 文字 = 抠过.净文字
    // ⭐ 2026-10-25（用户反馈）：拆段和间隔以前写死（固定 450ms）——
    //    长回复会变成连着好几条，看着像刷屏。现在两个都能配：不拆 = 一整条发出去。
    const 要拆 = 配置.长回复拆段 !== false
    const 段们 = 要拆 && 按段拆(文字).length
      ? 按段拆(文字)
      : [String(文字 || '').trim()].filter((s) => s.length > 0)
    const 发段延迟 = Math.max(0, Math.min(Number(配置.拆段间隔毫秒) || 0, 5000))
    // ⭐ 2026-10-27（节奏 · **保号**用，不是学人）：每段之间的等待 = 基础 + 随机抖动 + 按这一段字数。
    //   目的是「不像批量接口一下吐一串」，不是扮演人类打字。
    const 段等待 = (段) => {
      const 基 = Math.max(0, Math.min(Number(配置.拆段间隔毫秒) || 0, 5000))
      const 抖 = Math.max(0, Math.min(Number(配置.拆段抖动毫秒) || 0, 5000))
      const 按字 = Math.min(120, String(段 == null ? '' : 段).length) * 12
      return 基 + Math.floor(Math.random() * (抖 + 1)) + 按字
    }
    const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
    // ⭐ 图片：base64 或网络地址，QQ 那边直接收，不用访问本机文件
    const 图数据 = []
    const 加图 = (源) => {
      if (!源 || 图数据.length >= 4) return
      if (源.kind === 'url') { 图数据.push({ url: 源.value }); return }
      let 值 = 源.value
      // ⭐ 伙伴回发时常常照抄 DSH 给的那条「只读副本」路径（webp）——
      //    先反查一次表，能换回我们存的原图就换（GIF 才是动的）
      const 换 = 原图路径('p:' + 清路径(值).toLowerCase())
      if (换) 值 = 换
      const 全 = 找本地图(值, 配置) || 值
      try {
        const buf = readFileSync(全)
        if (buf.length > 最大) { 记账(`这张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); return }
        图数据.push({ b64: buf.toString('base64') })
      } catch (error) {
        记账('读图失败，跳过：' + String((error && error.message) || error))
      }
    }
    if (配置.发图) {
      for (const 源 of 抠过.图) 加图(源)
      if (Array.isArray(图们) && 图们.length) {
        const 附件 = ctx.attachments || ctx.get('attachments')
        for (const 块 of 图们) {
          try {
            // ⭐ 优先用我们收下来的**原图**（DSH 那份副本会被转码，GIF 会变静态）
            const 原 = 原图路径('id:' + String((块.attachment && 块.attachment.attachmentId) || ''))
            if (原) { 加图({ kind: 'path', value: 原 }); continue }
            const p = 附件 && typeof 附件.imageHostPath === 'function' ? 附件.imageHostPath(块.attachment) : undefined
            if (!p) { 记账('这张图拿不到本地文件，跳过'); continue }
            加图({ kind: 'path', value: p })
          } catch (error) {
            记账('读图失败，跳过：' + String((error && error.message) || error))
          }
        }
      }
    }
    // ⭐ 本机改动：表情那张图（每轮最多 1 张 —— 这一轮已经有别的图要发就不加了）
    if (表情图 && 配置.发图) {
      if (抠过.图.length + (Array.isArray(图们) ? 图们.length : 0) === 0) 加图({ kind: 'path', value: 表情图 })
      else 记账('这一轮已经有别的图要发了，表情那张就不发了（每轮最多 1 张）')
    }
    // 一条 OneBot 图片段：本地图走 base64，网络图直接把 url 交给 QQ
    const 一段图 = (x) => (x.url ? { type: 'image', data: { file: x.url, url: x.url } } : 图片段(x.b64))

    if (!行) {
      记账('这间会话没绑任何 QQ 聊天，这一轮不发出去（去设置里加一条绑定）')
      return 出
    }
    // ⭐ 2026-10-30（官方线）：官方机器人走自己的发法 —— 500 字一块、图片先 /files 换 file_info、
    //    被动回复窗（收到消息起 5 分钟 / 同一个 msg_id 最多 5 条）。OneBot 那套「段 + base64 图」
    //    在官方线上不存在（没有 at 段、图片不能直接塞 message 数组）。
    if (String(配置.协议 || '') === 'qq-official') {
      const 图参 = 图数据.map((x) => (x && x.url ? { url: x.url } : { 数据: x && x.b64 }))
      const 结果 = await 官方线.发(行, 文字, 图参)
      for (const r of 结果) {
        if (!r.ok) 记账('官方线发送失败（' + String(r.action) + '）：' + String((r.数据 && (r.数据.说 || JSON.stringify(r.数据))) || '原因不明'))
      }
      return 结果
    }
    const 要私聊 = 行.类型 !== '群' && 配置.转私聊
    const 要群 = 行.类型 === '群' && 配置.转群
    if (要私聊) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 私人消息体(段们[i])
        体.user_id = Number(行.号码)
        出.push(await 发一个(配置.NapCat, 'send_private_msg', 体, 配置))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 段等待(段们[i])))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_private_msg', { user_id: Number(行.号码), message: [一段图(x)] }, 配置))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    if (要群) {
      for (let i = 0; i < 段们.length; i++) {
        const 体 = 群消息体(段们[i])
        体.group_id = Number(行.号码)
        出.push(await 发一个(配置.NapCat, 'send_group_msg', 体, 配置))
        if (i < 段们.length - 1) await new Promise((r) => setTimeout(r, 段等待(段们[i])))
      }
      for (const x of 图数据) {
        出.push(await 发一个(配置.NapCat, 'send_group_msg', { group_id: Number(行.号码), message: [一段图(x)] }, 配置))
        await new Promise((r) => setTimeout(r, 发段延迟))
      }
    }
    // ⭐ 本机改动（回声锁）：记下这一轮自己发出去的每条 message_id（下一跳轮询见到就跳过）
    try {
      let 记了 = 0
      for (const x of 出) {
        const id = x && x.数据 && x.数据.data && x.数据.data.message_id
        if (id != null) { 自己发过.add(String(id)); 记了 += 1 }
      }
      if (记了) 存水位()
    } catch (error) {}
    return 出
  }

  /** 一轮真正落地：总开关 / 试运行 在这儿把关。 */
  async function 落地一发(配置, 文字, 图们, 方向 = '', 是QQ唤醒 = false) {
    if (已发轮.size > 300) 已发轮.clear() // 防 Set 无限长
    // ⭐ 0.6.0：方向就是「哪一间会话」—— 下面按它去绑定里反查该发到哪个聊天
    const 这份会话 = String(方向 || '')
    if (!这份会话) return 记账('这一轮认不出是哪间会话，这轮不转')
    配置 = { ...配置, 目标会话: 这份会话 }   // 下游（图片根目录、归档检查）都看这一个
    // ⭐ 盯的会话已经归档了：别转（人已经不在这儿说话了）
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 归档 = new Set((((登记 && 登记.archivedSessionIds) || [])).map(String))
      if (归档.has(会话键(这份会话))) return 记账('这间会话已经归档了，这轮不转（去绑定里换一间）')
    } catch (error) {}
    if (!配置.总开关) return 记账('总开关关着，这轮该转但没转')
    // ⭐ 2026-10-27（深夜静默 · 出站那一半）：静默里一个字都不往外发 —— 夜里安安静静，最像个人。
    //   （入站那一半在 轮询收消息 里拦：压根不叫醒她，省 token 也省得她夜里想事。）
    if (配置.静默两边都停 && 在静默里(配置)) {
      return 记账('静默时段「' + 配置.静默时段 + '」里，这轮不往 QQ 发')
    }
    // ⭐ 本机改动：这一行「只靠 qq_say 说话」（自动发 = false）就**不自动发**，只记一笔账
    const 这行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 会话键(方向)) || null
    if (这行 && 这行.自动发 === false) {
      return 记账('「' + 这行.类型 + ':' + 这行.号码 + '」只靠 qq_say 说话：这一轮不自动发（它想说会自己调）')
    }
    // ⭐ 0.7.0 出站闸一：只发 [QQ]…[/QQ] 里的那一段（块外的解释/路径/思考留在本地）
    let 待发文字 = 文字
    if (配置.只发标记内) {
      const 块 = /\[QQ\]([\s\S]*?)\[\/QQ\]/.exec(String(文字 || ''))
      if (!块 || !String(块[1] || '').trim()) {
        记账('这一轮没写 [QQ]…[/QQ] 块（「只发标记内」开着）—— 这轮不往 QQ 发')
        return
      }
      待发文字 = String(块[1]).trim()
    }
    // ⭐ 0.7.0 出站闸二：只发「被 QQ 消息叫醒的那一轮」（你坐在 DSH 里自己聊的不推到手机）
    if (配置.只回QQ唤醒) {
      if (!是QQ唤醒) {
        记账('这一轮不是 QQ 消息叫醒的（「只回 QQ 唤醒」开着）—— 只在 DSH 里说，不推 QQ')
        return
      }
    }
    const 抠过 = 配置.发图 ? 抠正文图(待发文字) : { 净文字: 待发文字, 图: [] }
    const 几张 = (Array.isArray(图们) ? 图们.length : 0) + 抠过.图.length
    const 图标 = 几张 ? `（还有 ${几张} 张图）` : ''
    const 净文 = String(抠过.净文字 || '')
    if (配置.试运行) {
      return 记账(`试运行：本来要发到 QQ →「${净文.slice(0, 40)}${净文.length > 40 ? '…' : ''}」${图标}`)
    }
    const 结果 = await 发到QQ(配置, 待发文字, 图们, 方向)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    // ⭐ 本机改动：真发出去了 = 她「出声」了 —— 记一笔，半收窗口看的就是这个时刻
    if (全过) 记出声(这行 || 方向)
    if (结果.length === 0) {
      记账('这一边（' + (方向 || '私聊+群') + '）没开或没填号，或者这轮既没有文字也没有图（而且图都没转成）：没地方发')
      return
    }
    记账(`${全过 ? '✅ 已发到 QQ：' : '⚠ 发 QQ 有问题：'}「${净文.slice(0, 50)}${净文.length > 50 ? '…' : ''}」${图标}`)
    for (const r of 结果) {
      if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    }
  }

  /** 盯会话事件：记住这一轮最后一句，在 turn/end 时落地。 */
  function 收到事件(session, event) {
    const 配置 = 读配置()
    if (!(配置.绑定 || []).length) return
    const 键 = 会话键(session && session.id)
    // ⭐ 0.6.0：哪一间会话说的话，就按它的绑定只回那一个聊天
    const 是这条 = (配置.绑定 || []).find((b) => 会话键(b.会话) === 键) || null
    if (!是这条) return
    const 方向 = 键
    // 这一轮的「最后一句」按会话分开记（两个会话同时说话时不会串）
    const 上一轮 = 上一轮们.get(键) || 空轮()
    const 记上一轮 = (v) => 上一轮们.set(键, v)

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) {
        记上一轮(空轮())
        return
      }
      const 文 = String(提取正文(d.message) || '').trim()
      const 图们 = 提取图块(d.message)
      if (文) 记上一轮({ 轮号: d.turn, 文本: 文, 图们 })
      // ⭐ 有的回合是先出图、后出字（或只出图）：别把图丢了
      else if (图们.length) 记上一轮({ 轮号: d.turn, 文本: 上一轮.轮号 === d.turn ? 上一轮.文本 : '', 图们: (上一轮.轮号 === d.turn ? 上一轮.图们 : []).concat(图们).slice(0, 10) })
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 有东西 = 上一轮.文本 || (上一轮.图们 && 上一轮.图们.length)
      // ⚠ 去重的键必须是「会话 + 轮号」：只按轮号的话，换过目标会话就会静默漏发
      const 轮标 = 键 + ':' + String(d.turn)
      if (完成 && 上一轮.轮号 === d.turn && 有东西 && !已发轮.has(轮标)) {
        已发轮.add(轮标)
        // ⚠️ 「这轮是不是 QQ 叫的」在**这里**算一次就消费掉 —— 不然 10 分钟的窗口会把
        //    后面别的轮次也当成 QQ 叫的（实测踩过：群里一条旧消息叫醒之后，之后几轮都往外发）。
        const 醒 = 唤醒时间.get(键) || 0
        const 是QQ唤醒 = 醒 > 0 && Date.now() - 醒 < QqWalake窗口
        唤醒时间.delete(键)
        // 门槛判了「不接」→ 这一轮一个字都不往外发（但会话里照常留着）
        if (静默轮.has(键)) {
          静默轮.delete(键)
          记账('回复门槛：这一轮按判定跳过发送（' + 短id(键) + '）')
        } else {
          void 落地一发(配置, 上一轮.文本, 上一轮.图们, 方向, 是QQ唤醒)
        }
      }
      记上一轮(空轮())
    }
  }

  // ---------- 路由（将来给设置页用；现在也能用来手动试） ----------

  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 短id = (id) => {
    const s = String(id)
    return s.length <= 8 ? s : s.slice(-8)
  }

  /* 拿目标会话活着的 agent：带 / 不带 `session-` 前缀两个方向都试（照 speak-up 的写法）。 */
  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 新id = () => {
    try {
      return randomUUID()
    } catch (error) {
      return 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  /** 手搓一条 user 消息（跟 speak-up 一样：role=user，source.kind 标成 qq，不冒充她亲手打的）。 */
  const 手搓用户消息 = (文案) => ({
    id: 新id(),
    role: 'user',
    content: [{ type: 'text', text: String(文案) }],
    source: { kind: 'qq' },
  })

  /** 现在开着的会话清单（id + 标题），给设置页挑「目标会话」用 —— 不手填。 */
  const 会话清单 = () => {
    const 出 = []
    // ⭐ 归档的会话不列（归档只是藏起来，list() 里还在 —— 得单独查 workspaceRegistry 的名单）
    //   2026-10-20 修：以前完全不看归档，设置页里挑会话时混着一堆已经归档的
    const 归档 = new Set()
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(String(x))
    } catch (error) {}
    try {
      const 会话服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      if (会话服务 && typeof 会话服务.list === 'function') {
        for (const s of 会话服务.list()) {
          if (归档.has(String(s.id))) continue
          let 标题 = ''
          try {
            const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
            标题 = 快照 && 快照.title ? String(快照.title) : ''
          } catch (error) {}
          出.push({ id: String(s.id), 标题 })
        }
      }
    } catch (error) {}
    return 出
  }

  const 概况 = async () => {
    const 配置 = 读配置()
    const 清单 = 会话清单()
    let NapCat状态 = null
    try {
      const r = await fetch(`${配置.NapCat}/get_login_info`, { method: 'POST', headers: 请求头(配置), body: '{}' })
      const j = await r.json()
      if (j && j.status === 'ok') {
        NapCat状态 = { 用户: j.data.user_id, 昵称: j.data.nickname }
        if (Number(j.data && j.data.user_id)) 自己号 = Number(j.data.user_id)   // ⭐ 本机改动（回声锁）
      }
    } catch (error) {
      NapCat状态 = { 错: String((error && error.message) || error) }
    }
    const 在清单里 = (id) => (id && 清单.length ? 清单.filter((x) => 会话键(x.id) === 会话键(id)) : [])
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.标题 || ('…' + 短id(x.id))]))
    const 绑定们 = (配置.绑定 || []).map((x) => ({
      ...x,
      会话标题: 标题表.get(会话键(x.会话)) || '',
      活着: 清单.some((y) => 会话键(y.id) === 会话键(x.会话)),
    }))
    return {
      ok: true, 版本, 配置, 配置文件, NapCat状态, 活着的会话: 清单, 日志,
      // ⭐ 2026-10-25：私聊 / 群两个方向各自的会话（老字段 目标情况 还留着 = 私聊那份）
      私聊情况: 在清单里(配置.私聊会话),
      群情况: 在清单里(配置.群会话),
      目标情况: 在清单里(配置.私聊会话),
      绑定: 绑定们,
    }
  }

  // ── 语音转写依赖：一键装（2026-10-25）─────────────────────────────
  //  她说的对：不能「我替她装就装了」—— 插件页里要有开关 + 一个按钮，点了才装，
  //  装的时候能看见进度和报错。这里只负责**起进程 + 记日志**，前端轮询看进度。
  const ASR家 = join(dirname(配置文件), 'qq-bridge-asr')
  const ASR日志 = join(ASR家, 'install.log')
  const ASRvenv = join(ASR家, '.venv')
  const ASRpython = process.platform === 'win32'
    ? join(ASRvenv, 'Scripts', 'python.exe')
    : join(ASRvenv, 'bin', 'python')
  let ASR装 = { 进行中: false, 步骤: [], 开始于: 0, 结束于: 0, 失败: '', 完成: false, 下载: null }

  const ASR写 = (行) => {
    try {
      mkdirSync(ASR家, { recursive: true })
      writeFileSync(ASR日志, '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + 行 + String.fromCharCode(10), { flag: 'a' })
    } catch (error) {}
  }
  const ASR读日志 = (行数 = 40) => {
    try {
      const 全部 = readFileSync(ASR日志, 'utf8').split(String.fromCharCode(10))
      return 全部.slice(-行数).join(String.fromCharCode(10)).trim()
    } catch (error) { return '' }
  }
  const ASR就绪 = () => existsSync(ASRpython)
  // ⭐ 2026-10-25（她说的「别人哪知道模型目录填什么」）：模型由插件自己下、自己放，
  //   用户不需要知道任何路径。「语音模型目录」那一栏只是**给你看/改**的，不该让人手填。
  const ASR模型根 = join(ASR家, 'models')
  const ASR模型名 = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
  const ASR模型目录 = () => join(ASR模型根, ASR模型名)
  const ASR模型就绪 = () => existsSync(join(ASR模型目录(), 'model.int8.onnx')) && existsSync(join(ASR模型目录(), 'tokens.txt'))
  // ⚠️ 2026-10-25（她实测）：官方那个 tar.bz2 有 **999MB** —— 因为把 fp32 模型也打进去了。
  //    我们只需要 int8 的 model.int8.onnx + tokens.txt（约 230MB + 1MB），
  //    所以改成**按文件下**（HuggingFace 上单个文件，另配 hf-mirror 兜底）。
  const ASR文件 = [
    { 名: 'model.int8.onnx', 约MB: 230 },
    { 名: 'tokens.txt', 约MB: 1 },
  ]
  const ASR文件地址们 = (名) => [
    'https://huggingface.co/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
    'https://hf-mirror.com/csukuangfj/' + ASR模型名 + '/resolve/main/' + 名,
  ]

  /** 起一条命令，输出追加进日志；返回 {码} */
  const ASR跑 = (命令, 参数, 说明) => new Promise((resolve) => {
    ASR写('▶ ' + 说明 + '：' + 命令 + ' ' + 参数.join(' '))
    let 子 = null
    try {
      子 = spawn(命令, 参数, { cwd: ASR家, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
    } catch (error) {
      ASR写('✗ 起不来：' + String((error && error.message) || error))
      return resolve({ 码: -1 })
    }
    子.stdout.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.stderr.on('data', (c) => ASR写(String(c).trim().slice(-400)))
    子.on('error', (e) => { ASR写('✗ ' + String((e && e.message) || e)); resolve({ 码: -1 }) })
    子.on('close', (码) => resolve({ 码: 码 === null ? -1 : 码 }))
  })

  async function 装语音依赖() {
    if (ASR装.进行中) return { ok: false, 说: '正在装，别急' }
    ASR装 = { 进行中: true, 步骤: [], 开始于: Date.now(), 结束于: 0, 失败: '', 完成: false, 下载: null }
    const 推 = (名, 态, 附) => {
      const 已 = ASR装.步骤.find((x) => x.名 === 名)
      if (已) { 已.态 = 态; if (附) 已.附 = 附 } else ASR装.步骤.push({ 名, 态, 附: 附 || '' })
    }
    const 找python = async () => {
      for (const 候选 of (process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]])) {
        const r = await ASR跑(候选[0], [...候选[1], '-V'], '看看有没有 ' + 候选[0])
        if (r.码 === 0) return 候选
      }
      return null
    }
    try {
      mkdirSync(ASR家, { recursive: true })
      ASR写('== 开始装语音识别依赖 ==')
      推('找 Python', '进行中')
      const py = await 找python()
      if (!py) {
        推('找 Python', '失败', '没找到 python / py')
        ASR装.失败 = '这台机器上没找到 Python（装它：https://www.python.org/downloads/）'
        return
      }
      推('找 Python', '完成', py[0])
      if (!ASR就绪()) {
        推('建独立环境', '进行中')
        const r1 = await ASR跑(py[0], [...py[1], '-m', 'venv', ASRvenv], '建 venv')
        if (r1.码 !== 0) {
          推('建独立环境', '失败', '退出码 ' + r1.码)
          ASR装.失败 = '建 venv 失败，看下面日志'
          return
        }
        推('建独立环境', '完成')
      } else 推('建独立环境', '完成', '已经有了')
      推('装 sherpa-onnx', '进行中')
      const r2 = await ASR跑(ASRpython, ['-m', 'pip', 'install', '--no-input', 'sherpa-onnx>=2', 'numpy', 'imageio-ffmpeg'], 'pip install')
      if (r2.码 !== 0) {
        推('装 sherpa-onnx', '失败', '退出码 ' + r2.码)
        ASR装.失败 = '装依赖失败（可能是网速/镜像问题，看日志最后几行）'
        return
      }
      推('装 sherpa-onnx', '完成')
      推('自检', '进行中')
      const r3 = await ASR跑(ASRpython, ['-c', 'import sherpa_onnx, numpy, imageio_ffmpeg; print("sherpa_onnx ok")'], '自检 import')
      if (r3.码 !== 0) {
        推('自检', '失败')
        ASR装.失败 = '装完了但 import 不进来，看日志'
        return
      }
      推('自检', '完成')
      // ④ 语音模型：按文件下（约 230MB + 1MB）—— 有就跳过
      if (ASR模型就绪()) 推('下载语音模型', '完成', '已经有了')
      else {
        mkdirSync(ASR模型目录(), { recursive: true })
        let 全好 = true
        for (const f of ASR文件) {
          const 目标 = join(ASR模型目录(), f.名)
          if (existsSync(目标)) { ASR写('已有 ' + f.名 + '，跳过'); continue }
          推('下载 ' + f.名, '进行中', '约 ' + f.约MB + 'MB')
          let 好 = false
          for (const 地址 of ASR文件地址们(f.名)) {
            ASR写('下载 ' + f.名 + ' ← ' + 地址)
            好 = await (async () => {
              let 写流 = null
              try {
                const r = await fetch(地址, { redirect: 'follow' })
                if (!r || !r.ok) { ASR写('  ✗ HTTP ' + (r && r.status)); return false }
                const 总 = Number(r.headers.get('content-length') || 0)
                写流 = createWriteStream(目标 + '.part')
                let 收 = 0
                const 起2 = Date.now()
                ASR装.下载 = { 文件: f.名, 已收: 0, 总, 百分比: 0, 速度KB: 0 }
                for await (const 块 of r.body) {
                  收 += 块.length
                  if (!写流.write(Buffer.from(块))) await new Promise((res) => 写流.once('drain', res))
                  const 秒 = Math.max(0.5, (Date.now() - 起2) / 1000)
                  ASR装.下载 = { 文件: f.名, 已收: 收, 总, 百分比: 总 ? Math.min(100, Math.round((收 / 总) * 100)) : 0, 速度KB: Math.round(收 / 1024 / 秒), 用时秒: Math.round(秒) }
                  if (收 % (16 * 1024 * 1024) < 块.length) ASR写('  已下 ' + Math.round(收 / 1048576) + 'MB' + (总 ? ' / ' + Math.round(总 / 1048576) + 'MB' : '') + '（' + (ASR装.下载.百分比 || 0) + '%）')
                }
                await new Promise((res) => 写流.end(res))
                写流 = null
                renameSync(目标 + '.part', 目标)
                ASR写('  ✓ ' + f.名 + ' 完成（' + Math.round(收 / 1048576) + 'MB）')
                return true
              } catch (error) {
                try { if (写流) 写流.destroy() } catch (error2) {}
                ASR写('  ✗ ' + String((error && error.message) || error))
                return false
              }
            })()
            if (好) break
          }
          if (!好) { 推('下载 ' + f.名, '失败', '两个源都没成功'); ASR装.失败 = '语音模型没下下来（' + f.名 + '）—— 再点一次会接着下已完成的'; 全好 = false; break }
          推('下载 ' + f.名, '完成')
        }
        if (全好) 推('下载语音模型', ASR模型就绪() ? '完成' : '失败', ASR模型就绪() ? '' : '下完了但文件不对')
        if (!全好 || !ASR模型就绪()) {
          if (!ASR装.失败) ASR装.失败 = '语音模型没下完 —— 再点一次「自动装依赖」会接着下（已完成的会跳过）'
          return
        }
      }
      // ⑤ 把配置里那两栏写好（用户不用知道路径）
      try {
        const 现 = 读配置()
        const 新 = { ...现, 转写命令: ASR命令(ASR模型目录()), 语音模型目录: ASR模型目录() }
        写配置(新)
        ASR写('已把「转写命令 / 语音模型目录」写进配置')
      } catch (error) { ASR写('写配置失败（不影响使用）：' + String((error && error.message) || error)) }
      ASR装.完成 = true
      ASR写('== 装完了 ==')
    } catch (error) {
      ASR装.失败 = String((error && error.message) || error)
      ASR写('✗ 意外错误：' + ASR装.失败)
    } finally {
      ASR装.进行中 = false
      ASR装.结束于 = Date.now()
    }
  }

  /** 装好的那套要用的命令（前端「一键填好」也用这个） */
  const ASR命令 = (模型目录) => {
    const 脚本 = join(PACKAGE_ROOT, 'tools', 'asr_cli.py')
    const 模 = String(模型目录 == null ? (读配置().语音模型目录 || '') : 模型目录).trim()
    return '"' + ASRpython + '" "' + 脚本 + '" "{file}"' + (模 ? ' --模型目录 "' + 模 + '"' : '')
  }

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  // ── 语音转写：装依赖 / 看进度 / 一键填命令 ──────────────────────
  路线(`${路由前缀}/asr-status`, async (req, res) => {
    return 回(res, {
      ok: true,
      就绪: ASR就绪(),
      模型就绪: ASR模型就绪(),
      模型目录: ASR模型目录(),
      进行中: ASR装.进行中,
      步骤: ASR装.步骤,
      完成: ASR装.完成,
      失败: ASR装.失败,
      下载: ASR装.下载,
      用时秒: ASR装.开始于 ? Math.round(((ASR装.结束于 || Date.now()) - ASR装.开始于) / 1000) : 0,
      日志: ASR读日志(40),
      命令: ASR命令(ASR模型就绪() ? ASR模型目录() : ''),
      python: ASR就绪() ? ASRpython : '',
    })
  })

  路线(`${路由前缀}/asr-install`, async (req, res) => {
    await 读体(req)
    记账('点了「装语音识别依赖」—— 后台开始，进度看设置页')
    void 装语音依赖()          // ⚠ 不等它：装依赖可能几分钟，不能把请求挂住（bili 那边踩过这个坑）
    return 回(res, { ok: true, 说: '开始装了，进度会显示在下面（可以关掉设置页，装完日志还在）' })
  })

  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    回(res, await 概况())
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 现在 = 读配置()
    const 新 = { ...现在, ...(来 && typeof 来 === 'object' ? 来 : {}) }
    const 洗好 = 归一化(新)
    if (!写配置(洗好)) return 回(res, { ok: false, 说: `写不进配置文件：${配置文件}` })
    const 状态 = 洗好.总开关 ? (洗好.试运行 ? '（只记账）' : '（真发）') : '（总开关关着）'
    // ⭐ 0.6.0：报「几条绑定」＋ 挡掉了几个重复（同一个会话 / 同一个聊天只能绑一条）
    const 想绑 = Array.isArray(来 && 来.绑定) ? 来.绑定.filter((x) => x && x.会话 && x.号码).length : 0
    const 实绑 = (洗好.绑定 || []).length
    记账(`设置已保存：绑定 ${实绑} 条${想绑 > 实绑 ? '（挡掉 ' + (想绑 - 实绑) + ' 条重复：同一间会话/同一个聊天只能绑一条）' : ''}｜${状态}`
      + (洗好.令牌 ? '｜带接口令牌' : ''))
    回(res, { ...(await 概况()), 说: '保存好了' })
  })

  // 收到 QQ 里你发来的话 → 喂进目标会话，让它照常开一轮。
  // ⚠ 这是「QQ → DSH」那半的**入口函数**：一句正文（+ 图）→ agent.followup 走 DSH 自己的回合。
  // ⭐ 2026-10-22：加了图片。图会先落一份到 `~/.dsh/qq-bridge-inbox/`，再把图交给 DSH 的
  //    attachments；模型能看图就直接看，纯文本模型拿到的是一句占位文字 —— 所以文字里也写上本地路径。
  // ── QQ 里的「分享卡片」和「合并转发的聊天记录」也读成文字（2026-10-25）──────────
  //   以前只认 text / image / mface ⇒ 她一发 B站 卡片、或者转发一段聊天记录，
  //   段里没有文字、也没有图，整条被当成「空消息」丢掉 —— 看着就是「QQ 桥读不了」。
  const 掐短 = (s2, n = 120) => {
    const t = String(s2 == null ? '' : s2).replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
  }
  const 反斜 = (t) => String(t || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const 抽BV号 = (文) => {
    const m = /BV[0-9A-Za-z]{10}/.exec(String(文 || ''))
    return m ? m[0] : ''
  }
  /** 从分享卡片段（json / xml）里抽标题、描述、链接 —— 抽不到也给一句看得懂的话 */
  function 卡片文字(段) {
    const d = (段 && 段.data) || {}
    let 原 = d.data != null ? d.data : (d.content != null ? d.content : (d.xml != null ? d.xml : ''))
    if (原 && typeof 原 === 'object') 原 = JSON.stringify(原)
    原 = 反斜(String(原 || ''))
    const 题们 = []
    let 链接 = ''
    try {
      const j = JSON.parse(原)
      const 摸 = (o, 层 = 0) => {
        if (!o || typeof o !== 'object' || 层 > 6) return
        for (const [k, v] of Object.entries(o)) {
          if (typeof v === 'string') {
            const 值 = 反斜(v).trim()
            if (/^(title|desc|summary|prompt)$/i.test(k) && 值) 题们.push(值)
            if (/^(jumpUrl|qqdocurl|url)$/i.test(k) && /^https?:/i.test(值) && !链接) 链接 = 值
          } else 摸(v, 层 + 1)
        }
      }
      摸(j)
    } catch (e) { /* 不是 JSON 就按 xml 抓 */ }
    if (!题们.length || !链接) {
      const 标题 = /<title>([\s\S]{0,100}?)<\/title>/i.exec(原)
      if (标题 && 反斜(标题[1]).trim()) 题们.push(反斜(标题[1]).trim())
      const 摘要 = /<summary>([\s\S]{0,140}?)<\/summary>/i.exec(原)
      if (摘要 && 反斜(摘要[1]).trim()) 题们.push(反斜(摘要[1]).trim())
      const 链 = /(https?:\/\/[^\s"'<>&]+)/.exec(原)
      if (链 && !链接) 链接 = 链[1]
    }
    const 题 = [...new Set(题们)].slice(0, 2).join(' —— ')
    const bv = 抽BV号(原 + ' ' + 链接)
    const 尾 = [链接 ? '链接 ' + 链接 : '', bv ? 'BV号 ' + bv : ''].filter(Boolean).join('　')
    if (!题 && !尾) return '[分享卡片（里面没抓到内容）]'
    const 头 = bv ? '[分享视频卡片]' : '[分享卡片]'
    return 头 + ' ' + (题 || '（没标题）') + (尾 ? String.fromCharCode(10) + '  ' + 尾 : '')
  }
  /** 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成几行 */
  /**
   * 合并转发的聊天记录：拿 id 去 NapCat 取节点，压成「一行一句」。
   * ⭐ 2026-10-25：分两层处理 —— **外层几句话就几行**，里面那层转发**另起一段、缩进一层**，
   *    不再把内层整段塞进同一行（上一版会挤成一大坨，人看着不直观）。
   *    一条转发里套好几个转发也照样各起一段。
   * ⚠️ 只展开 2 层；第一层里的图可以在「收图」开着时顺手收进来（第二层起只标 [图片]）。
   */
  async function 转发行们(段, 拉任意, 图袋, 层, 预算) {
    const 缩 = '  '.repeat(层 + 1)
    const d = (段 && 段.data) || {}
    const id = String(d.id != null ? d.id : (d.message_id != null ? d.message_id : ''))
    // ⭐ 2026-10-25：NapCat 常常**已经把节点塞在 data.content 里**（尤其套娃的内层）——
    //    优先用现成的，别再多打一次 API（否则内层直接「内容取不到」）。
    let 节点们 = Array.isArray(d.content) && d.content.length ? d.content : []
    if (!节点们.length) {
      if (!id) return [缩 + '[合并转发的聊天记录（没有 id，读不出来）]']
      for (const 体 of [{ id }, { message_id: id }]) {
        const 结果 = await 拉任意('get_forward_msg', 体)
        const 候选 = (结果 && (结果.messages || 结果.message)) || null
        if (Array.isArray(候选) && 候选.length) { 节点们 = 候选; break }
      }
    }
    if (!节点们.length) return [缩 + '[合并转发的聊天记录（内容取不到）]']
    const 行 = [缩 + '[合并转发的聊天记录 · 共 ' + 节点们.length + ' 条]']
    for (const 节 of 节点们.slice(0, 20)) {
      if (预算.行 <= 0) { 行.push(缩 + '  …（后面的没展开）'); break }
      预算.行--
      const 谁 = String((节 && 节.sender && (节.sender.card || 节.sender.nickname)) || (节 && 节.nickname) || '某人')
      const 段们 = Array.isArray(节 && 节.content) ? 节.content : (Array.isArray(节 && 节.message) ? 节.message : [])
      const 文本块 = []
      const 内层 = []
      for (const x of 段们) {
        if (!x) continue
        const 型 = String(x.type || '')
        if (型 === 'text') { 文本块.push(String((x.data && x.data.text) || '')); continue }
        if (型 === 'image' || 型 === 'mface') {
          if (层 === 0 && Array.isArray(图袋)) 图袋.push(x)   // 只收第一层的图
          文本块.push('[图片]')
          continue
        }
        if (型 === 'face') { 文本块.push('[表情]'); continue }
        if (型 === 'record') { 文本块.push('[语音]'); continue }
        if (型 === 'video') { 文本块.push('[视频]'); continue }
        if (型 === 'json' || 型 === 'xml') { 文本块.push('[卡片]'); continue }
        if (型 === 'at') { 文本块.push('@' + String((x.data && (x.data.name || x.data.qq)) || '')); continue }
        if (型 === 'forward') { 内层.push(x); continue }
      }
      const 头 = 缩 + '  ' + 掐短(谁, 20) + '：'
      const 文本 = 文本块.join('').replace(/[ 	]+/g, ' ').replace(/[\r\n]+/g, ' ').trim()
      if (文本) 行.push(头 + 掐短(文本, 240))
      // 这个人的消息**只有一段转发**、没有别的话：也得让人看出是谁转的
      else if (内层.length && 层 === 0) 行.push(头 + '（转发的聊天记录）')
      for (const 内 of 内层) {
        if (层 >= 3) { 行.push(头 + '[（已经套了 4 层，更深的不再展开）]'); continue }
        行.push(...(await 转发行们(内, 拉任意, 图袋, 层 + 1, 预算)))
      }
      if (!文本 && !内层.length) 行.push(头 + '（这条没内容）')
    }
    return 行
  }

  /** 一条合并转发 → 整段文字（行数 / 字数都有上限，别把上下文吃光） */
  async function 转发文字(段, 拉任意, 图袋) {
    const 行们 = await 转发行们(段, 拉任意, 图袋, 0, { 行: 60 })
    let 文 = 行们.join(String.fromCharCode(10))
    if (文.length > 3000) 文 = 文.slice(0, 3000) + String.fromCharCode(10) + '…（太长，剩下的没展开）'
    return 文
  }

  // ── 叫醒 / 开会话（⭐ 本机改动，本机改版移植）──────────────────────────
  //  会话没活着时：先 resume 把它叫醒；叫不醒、而且这一行看着是「要新开一间」的意思（会话是
  //  占位符 `新`，或者行里给了预设 / 会话目录），就 create 开一间，再把新会话号写回配置。
  //  每一条失败路径都记账（不静默）。

  /** 当前默认模型选择（拿不到就 undefined，交给宿主自己的默认） */
  const 当前选 = () => {
    try {
      const 服务 = ctx.agentDefaultModel || (typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined)
      const 选 = 服务 && typeof 服务.currentSelection === 'function' ? 服务.currentSelection() : undefined
      if (选 && typeof 选 === 'object' && 选.provider) return { provider: 选.provider, model: 选.model }
    } catch (error) {}
    return undefined
  }

  /** 预设表（挂预设用）；新老宿主的两种取法都试 */
  const 预设表拿 = () => {
    try {
      const 表 = ctx.agentPresets || (typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined)
      if (表 && typeof 表.resolve === 'function' && typeof 表.mount === 'function') return 表
    } catch (error) {}
    return undefined
  }

  /** ⭐ 叫醒一间会话：xxx / session-xxx 两种写法都试；顺带从会话头里读预设 */
  async function 叫醒(目标, 预设) {
    const 原 = String(目标 == null ? '' : 目标).trim()
    if (!原) return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    const 选 = 当前选()
    const 预设表 = 预设表拿()
    let 想用 = String(预设 || '').trim()
    for (const id of 候选) {
      try {
        // 会话头里有预设就用它（起来的时候顺手挂上，省得少东西）
        try {
          const 观 = ctx.sessionQuery && typeof ctx.sessionQuery.observeSession === 'function'
            ? await ctx.sessionQuery.observeSession(id, {})
            : null
          const 头 = 观 && (观.header || (观.observation && 观.observation.header))
          if (头) {
            const 头预设 = String(头.preset || 头.agentPreset || '').trim()
            if (!想用 && 头预设) 想用 = 头预设
          }
        } catch (error) {
          记账('看会话头没看成（' + 短id(id) + '）：' + String((error && error.message) || error))
        }
        const 布置 = {}
        if (选) 布置.agentOptions = 选
        if (预设表) {
          try {
            const 定 = await 预设表.resolve(想用 || 'whale')
            if (定 && 定.id) 布置.setup = async (agentCtx) => { await 预设表.mount(agentCtx, 定.id) }
          } catch (error) {
            记账('预设挂不上（' + String(想用 || 'whale') + '）：' + String((error && error.message) || error))
          }
        }
        const 回 = await ctx.agents.resume({ resumeSessionId: id, ...布置 })
        const agent = 回 && (回.agent || 回)
        if (agent) return agent
        记账('叫醒没成：resume 没返回 agent（' + 短id(id) + '）')
      } catch (error) {
        记账('叫醒没成（' + 短id(id) + '）：' + String((error && error.message) || error))
      }
    }
    return undefined
  }

  /** ⭐ 开一间新会话（会话是占位符 `新` / 行里给了预设或会话目录时用） */
  /** ⭐ 2026-10-27（记账修复）：把新建的会话归进「它目录所在的那个工作区」。
   *  为什么要补这一步：`ctx.agents.create` 是低层口子，不会替我们记工作区的账 ——
   *  不补，这间会话在侧栏里就躺进「未分类」（主人 10-27 报的那个）；而且「默认工作区」的
   *  接续闹钟是按**工作区自己的会话名单**挑目标的，QQ 屋必须待在它自己的工作区
   *  （/root/默认工作区/QQ消息），不能被默认工作区收进去 —— 收进去就会被当成接续目标，泄回 QQ。
   *  拿不到注册表 / 目录没登记过：只记账、不抛错（归位失败不影响会话本身可用）。 */
  async function 归进工作区(会话号, 目录) {
    const 登记 = ctx.workspaceRegistry || (typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined)
    if (!登记 || typeof 登记.resolveByPath !== 'function') { 记账('没有工作区注册表，会话不归位（' + 短id(会话号) + '）'); return }
    try {
      const 屋 = await 登记.resolveByPath(目录)
      if (!屋) { 记账('目录没登记成工作区，会话不归位（' + 目录 + '）'); return }
      if (typeof 屋.attachSession === 'function') {
        await 屋.attachSession(会话号)
        记账('会话已归进工作区「' + String(屋.name || 屋.path || 屋.id) + '」（' + 短id(会话号) + '）')
      } else 记账('这间工作区没有 attachSession，归位跳过（' + 目录 + '）')
    } catch (error) {
      记账('归位工作区没成：' + String((error && error.message) || error))
    }
  }

  async function 开一间(行) {
    const 预设 = String((行 && 行.预设) || '').trim() || 'whale'
    const 目录项 = String((行 && 行.会话目录) || '').trim() || '/root/默认工作区/QQ消息'
    const id = 'session-' + 新id()
    const 布置 = { sessionId: id, meta: { cwd: 目录项, agentPreset: 预设 } }
    const 选 = 当前选()
    if (选) 布置.agentOptions = 选
    const 预设表 = 预设表拿()
    if (预设表) {
      try {
        const 定 = await 预设表.resolve(预设)
        if (定 && 定.id) 布置.setup = async (agentCtx) => { await 预设表.mount(agentCtx, 定.id) }
      } catch (error) {
        记账('预设挂不上（' + 预设 + '）：' + String((error && error.message) || error))
      }
    }
    try {
      const 回 = await ctx.agents.create(布置)
      const agent = 回 && (回.agent || 回)
      if (agent) {
        记账('给这一行开了一间新会话（' + 短id(id) + '，目录 ' + 目录项 + '，预设 ' + 预设 + '）')
        await 归进工作区(id, 目录项)
        return { id, agent }
      }
      记账('开会话没成：create 没返回 agent（预设 ' + 预设 + '）')
    } catch (error) {
      记账('开会话没成（' + 预设 + '）：' + String((error && error.message) || error))
    }
    return undefined
  }

  /** ⭐ 把新会话号写回配置里那一行（按 类型:号码 认，比拿会话号去比稳） */
  function 写回会话号(行, 新号) {
    if (!行) return
    try {
      const 现 = 读配置()
      const 表 = JSON.parse(JSON.stringify(Array.isArray(现.绑定) ? 现.绑定 : []))
      let 改过 = false
      for (const b of 表) {
        if (String(b.类型 || '') === String(行.类型 || '') && String(b.号码 || '') === String(行.号码 || '')) {
          b.会话 = String(新号)
          改过 = true
        }
      }
      if (!改过) { 记账('没找着那一行，会话号没写回（' + 行.类型 + ':' + 行.号码 + '）'); return }
      if (写配置({ ...现, 绑定: 表 })) 记账('会话号已写回配置（' + 行.类型 + ':' + 行.号码 + ' → ' + 短id(新号) + '）')
    } catch (error) {
      记账('写回会话号失败：' + String((error && error.message) || error))
    }
  }

  /** ⭐ 2026-10-27（按「一场」投递）：一条的老入口 —— 原样留着，转给 转入一批。 */
  async function 转入一条(文字, 图们, 消息id, 行, 发送者) {
    return 转入一批([{ 文字, 图们, 消息id, 发送者, 时刻: 0 }], 行)
  }

  /** ⭐ 2026-10-27（按「一场」投递）：一次投递可以带**好几条** —— 同一跳里到的消息合成一个投递单元，
   *  只叫醒她一次。为什么（主人 2026-10-27 定的口径）：判断「谁在对谁说话」得先有「局」；
   *  一条一条投，她只能在单条上做判断 —— 那正是她当晚刷屏的机制之一。
   *  条们 = [{ 文字, 图们, 消息id, 发送者, 时刻 }]（时刻 = unix 秒，可省）。
   *  只带一条时，走的就是原来那条路，行为零变化。 */
  async function 转入一批(条们, 行) {
    const 配置 = 读配置()
    const 清单 = (Array.isArray(条们) ? 条们 : []).filter(Boolean)
    if (!清单.length) return { ok: false, 说: '这一批里没有可转的东西' }
    // ⭐ 2026-10-25（0.6.0）：传「绑定行」进来 —— 每一行自带类型 / 号码 / 会话 / 称呼
    const 这条 = 行 || (配置.绑定 || [])[0] || null
    let 这间 = String((这条 && 这条.会话) || 配置.私聊会话 || '')
    if (!这间) return { ok: false, 说: '还没绑任何聊天（私聊或群）' }
    if (!配置.总开关) return { ok: false, 说: '总开关关着，先打开' }
    // ⭐ 本机改动（叫醒 / 自动开会话）：会话没活着**不再直接放弃** ——
    //   ① 先叫醒（resume）；② 还是不成、而且这一行看着是「要新开一间」（会话 = 占位符 `新`，
    //   或者行里给了自己的预设 / 会话目录），就给它开一间；③ 把新会话号写回那一行配置。
    let agent = 找agent(这间)
    if (!agent && 这条 && 这条.叫醒 !== false) {
      agent = await 叫醒(这间, 这条.预设)
      if (agent) 记账('那间会话原本没活着（' + 短id(这间) + '），刚把它叫醒了')
    }
    if (!agent) {
      const 占位 = /^(新|new)(\s|:|$)/i.test(这间)
      const 自己给的预设 = String((这条 && 这条.预设) || '').trim()
      const 给了 = Boolean(String((这条 && 这条.会话目录) || '').trim()) || (!!自己给的预设 && 自己给的预设 !== 'whale')
      if (占位 || 给了) {
        const 开 = await 开一间(这条)
        if (开 && 开.agent) {
          写回会话号(这条, 开.id)
          这间 = 开.id
          agent = 开.agent
        }
      }
    }
    if (!agent) return { ok: false, 说: `那间会话叫不起来（${短id(这间)}），先把它打开` }

    // ── 收图：限量、限重，失败就跳过，不挡住文字（上限按**这一批**算，不是按每条算）──
    const 收下 = []
    if (配置.收图) {
      const 上限 = Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
      const 最大 = Math.max(1, Math.min(Number(配置.图上限MB) || 5, 30)) * 1024 * 1024
      for (const 项 of 清单) {
        for (const 段 of (Array.isArray(项.图们) ? 项.图们 : [])) {
          if (收下.length >= 上限) break
          const 序 = 收下.length + 1
          const buf = await 取图字节(段 && 段.data ? 段.data : 段)
          if (!buf || !buf.length) { 记账(`第 ${序} 张图下载失败，跳过`); continue }
          if (buf.length > 最大) { 记账(`第 ${序} 张图太大（${Math.round(buf.length / 1048576)}MB），跳过`); continue }
          const 类 = 看图类(buf)
          收下.push({ 类, b64: buf.toString('base64'), 存: 存一张(`${项.消息id || 'qq'}-${序}`, buf, 类), 字节: buf.length })
        }
        if (收下.length >= 上限) break
      }
    }

    // 称呼跟着这一行走（群里不止一个人，别拿私聊的名字去叫）
    const 谁 = String((这条 && 这条.称呼) || ((这条 && 这条.类型 === '群') ? '群里的人' : '对方'))
    const 说明 = 收下.length
      ? String.fromCharCode(10) + String.fromCharCode(10) + '（这一批带了 ' + 收下.length + ' 张图：'
        + 收下.map((x, i) => `第${i + 1}张 ${Math.round(x.字节 / 1024)}KB` + (x.存 ? `，要发回去就用 ${x.存}` : '')).join('；')
        + '）'
      : ''
    // ⭐ 本机改动（归属头）：群 → 〔QQ 群 …〕★主人·昵称(#号) 20:15： /〔QQ 群 …〕（群友）昵称(#号) 20:15：
    //    私聊 → 〔QQ 私聊〕★主人(#号)：。主人号 = 私聊那一行的号（或这一行「只认」里填的那个号）。
    const 是群2 = Boolean(这条 && 这条.类型 === '群')
    const 只认这行 = String((这条 && 这条.只认) || '').trim()
    // ⭐ 本机改动（补）：主人号的回退链 —— 这一行「只认」里填的号 → 私聊那一行的号 → 配置.私聊QQ
    //    → 绑定表里第一条私聊行的号。少任何一环，群里都会把主人标成「（群友）」。
    const 主人号 = Number(是群2 ? (只认这行 && 只认这行 !== '0' ? 只认这行 : 配置.私聊QQ) : (这条 && 这条.号码))
      || Number((((配置.绑定) || []).find((x) => x && x.类型 === '私聊') || {}).号码) || 0
    // 每一条：归属头（谁说的 + 时刻）+ 原话；多条之间空一行 —— 让她一眼看出「这是一场」
    const 段们 = []
    for (const 项 of 清单) {
      const 原话 = String(项.文字 || '').trim()
      const 发送者 = 项.发送者 || null
      // 上游这里手上只有 发送者={昵称,号码}；归属头要的是 OneBot 那条原始消息的形状（.sender / .user_id）。
      // 上游给「没昵称只有号」的人兜的是 'QQ 850705216' —— 那是兜底，不算昵称，这里滤掉。
      const 合成昵称 = Boolean(发送者 && Number(发送者.号码) && String(发送者.昵称 || '') === 'QQ ' + Number(发送者.号码))
      const 昵 = 发送者 && !合成昵称 ? String(发送者.昵称 || '').trim() : ''
      const 条样 = 发送者
        ? { sender: { card: 昵, nickname: 昵 }, user_id: Number(发送者.号码) || 0 }
        : null
      // 手上没有「谁」（手动 /receive 灌进来的一条）就不标归属 —— 别编一个发言人出来
      const 归属 = 条样 ? 归属头(是群2, (这条 && 这条.号码) || '', 条样, 主人号, 项.时刻) : ''
      if (原话) 段们.push(归属 + 原话)
      else if (收下.length) 段们.push(归属 + '（' + 谁 + '发来了图片，没有配字）')
    }
    const 基础 = 段们.join(String.fromCharCode(10) + String.fromCharCode(10)) + 说明
    if (!基础) return { ok: false, 说: '这一批既没文字也没图，不转' }
    // ⭐ 这一行开了门槛时，顺手告诉她「先读这一场再决定接不接」。
    //    2026-10-27（按「一场」投递）：一批好几条时，判定的对象是**这一批**，不是每一条 ——
    //    这正是「先读局、再看句」落到机制上的那一格。
    const 门槛提示 = Boolean(这条 && 这条.门槛 && 这条.类型 === '群')
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + (清单.length > 1
          ? '（这一批 ' + 清单.length + ' 条是从 QQ 转进来的：先读这一场 —— 谁在对谁说话。'
            + '这批里一条都不是冲你来的，就调 `qq_reply_gate` 传 reply=false，这一轮直接停；'
            + '有冲你来的，只回那一部分，剩下的当没看见，别挨条搭话。）'
          : '（这条是从 QQ 转进来的：先判断是不是在跟你说话 —— 不是就调 `qq_reply_gate` 传 reply=false，这一轮直接停；'
            + '是冲你来的就正常回。）')
      : ''
    // ⭐ 开了「只发 [QQ] 块」时，必须告诉它这个约定 —— 不然它压根不会写这个块，一开开关就一条都发不出去
    const 块提示 = 配置.只发标记内
      ? String.fromCharCode(10) + String.fromCharCode(10)
        + '（这台机器只把正文里 `[QQ]…[/QQ]` 中间那段发到 QQ —— 想让手机收到的就写在里面；'
        + '块外的话只在本机看，不会发出去。）'
      : ''
    const 文案 = 基础 + 门槛提示 + 块提示

    let content = [{ type: 'text', text: 文案 }]
    if (收下.length) {
      const 附件 = ctx.attachments || ctx.get('attachments')
      if (附件 && typeof 附件.admitPromptContent === 'function') {
        try {
          const 待 = content.concat(收下.map((x, i) => ({
            type: 'image', data: x.b64, mediaType: x.类, name: `qq-${(清单[0] && 清单[0].消息id) || 'x'}-${i + 1}.${扩展(x.类)}`,
          })))
          content = await 附件.admitPromptContent(待)
          // ⭐ 记下「附件 id / DSH 那份只读副本 → 我们存的原图」，回发时换回原图（GIF 不会变静态 webp）
          const 图块 = content.filter((x) => x && x.type === 'image' && x.attachment)
          for (let i = 0; i < 图块.length && i < 收下.length; i++) {
            let 副本 = ''
            try { 副本 = typeof 附件.imageHostPath === 'function' ? String(附件.imageHostPath(图块[i].attachment) || '') : '' } catch (error) {}
            记收图(图块[i].attachment && 图块[i].attachment.attachmentId, 副本, 收下[i].存)
          }
        } catch (error) {
          记账('图交给 DSH 没成功（这轮只转文字）：' + String((error && error.message) || error))
          content = [{ type: 'text', text: 文案 }]
        }
      } else {
        记账('宿主没有 attachments 服务，图只能存本地（文字里已经给了路径）')
      }
    }

    try {
      // ⚠⚠ 必须 await：followup 返回 Promise。不接住的话，它 reject 时（会话半死 / agent 已释放）
      //   catch 根本看不到（try 早就退出了）⇒ 未处理的 rejection ⇒ **整个 DSH 宿主退出**
      //   （2026-10-21：speak-up 同一个坑已经被用户报成"装了鱼就死了"，这里一并修）
      await agent.followup({ id: 新id(), role: 'user', content, source: { kind: 'qq' } })
      唤醒时间.set(会话键(这间), Date.now())   // 记一下「这间是被 QQ 叫起来的」
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch (error) {}
      const 图话 = 收下.length ? `（含 ${收下.length} 张图）` : ''
      const 首句 = String((清单[0] && 清单[0].文字) || '').trim()
      const 批量话 = 清单.length > 1 ? `（这一批 ${清单.length} 条）` : ''
      记账(`收到 QQ 里的${收下.length ? '图片' : '话'}${图话} → 转进 DSH${批量话}：「${(首句 || '（没配字）').slice(0, 50)}${首句.length > 50 ? '…' : ''}」`)
      return { ok: true, 说: '转进去了，它会照常开一轮' }
    } catch (error) {
      return { ok: false, 说: `followup 失败：${String((error && error.message) || error)}` }
    }
  }

  /** 只要文字的那条老入口（给 /receive 路由和测试用） */
  async function 转入文字(文字) {
    return 转入一条(文字, [], '')
  }

  // ── 回复门槛（2026-10-25）─────────────────────────────────────────
  //  口径（她定的）：**消息照常进来、照常叫醒**；判断放在"思考的时候" ——
  //  模型调 `qq_reply_gate` 看这条是不是在跟它说话：
  //    · reply = true  → 正常接话；
  //    · reply = false → 我们调 agent.cancel()，这一轮立刻停（界面上会显示成一次中断/报错）。
  //  ⭐ 一个天然的好处：我们的回发**只在 turn/end=completed 时才发**，
  //     被 cancel 的那轮不是 completed ⇒ 一个字都不会漏到 QQ，不用另写抑制。
  //  ⚠️ 工具只在「被 QQ 叫醒后的一小段时间内」有效 —— 她自己在 DSH 界面上聊天时，
  //     模型就算想关闸也关不掉（避免把自己的一轮聊没了）。
  // ⚠️ 2026-10-25：以前是**全局一个时间戳** —— A 群刚被 QQ 叫醒，B 群这轮也会被当成「QQ 叫的」。
  //    现在按会话记：哪个聊天叫醒的，只有那一间算。
  const 唤醒时间 = new Map()   // 会话键 -> 时间戳
  // ⚠️ 2026-10-25（她在手机上实测）：以前用 agent.cancel() 停轮 —— 结果是
  //    「工具调用 · Error: tool call aborted」+ 宿主开始「重试模型请求 (1/5)」，看着像坏了。
  //    现在改成**不停轮、只把这轮的出站掐掉**：工具返回一句「这轮不接」，并在这一轮结束时跳过发送。
  const 静默轮 = new Set()     // 会话键
  const 闸门挂着 = new Map()   // sid -> disposer（DSH 的 tools.register 返回的就是一个收尾函数）
  const QqWalake窗口 = 10 * 60 * 1000

  const 做闸门工具 = (agent, sid) => ({
    name: 'qq_reply_gate',
    description:
      '只在「这一轮是被 QQ 消息叫醒的」时候用。先判断这条消息是不是在跟你说话：' +
      '是在跟别人聊、跟你没关系、或者只是别人之间的对话 —— 就传 reply=false，这一轮会立刻停下，什么都不会发出去。' +
      '如果是冲你来的（叫你的名字、问你、跟你撒娇、@ 你、引用你），传 reply=true 正常接话。',
    parameters: {
      reply: { type: 'boolean', required: true, description: 'true = 这条是在跟我说话，正常回；false = 不关我的事，停掉这一轮' },
      reason: { type: 'string', description: '一句话理由（只写进日志，群里/私聊都看不到）' },
    },
    // ⚠️ 2026-10-25（她报的「门槛没生效」）：DSH 要求每个工具**必须声明 output**，
    //    缺了就注册失败（日志里那句 `tool "qq_reply_gate" must declare output`），
    //    于是门槛工具一直没挂上、面板也看不出来。补上。
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const 配置 = 读配置()
      const 这行 = (配置.绑定 || []).find((b) => 会话键(b.会话) === sid) || null
      if (!这行 || !这行.门槛 || 这行.类型 !== '群') return { ok: false, 说: '这个聊天没开门槛，不用调这个工具' }
      const 醒 = 唤醒时间.get(sid) || 0
      if (!(醒 > 0 && Date.now() - 醒 < QqWalake窗口)) {
        return { ok: false, 说: '这一轮不是 QQ 消息叫起来的，不能用它停轮 —— 正常回就行' }
      }
      // ⚠️ 2026-10-25（她实测）：模型有时把布尔传成字符串 "false"，严格 !== false 会判成"要正常回"。
      //    现在两种写法都认（false / "false" / 0 / "0" 都算"不接"）。
      const 值 = args ? args.reply : undefined
      const 不接 = 值 === false || 值 === 0 || String(值).toLowerCase() === 'false' || String(值) === '0'
      if (!不接) {
        唤醒时间.delete(sid)
        return { ok: true, 说: '好，这条是冲我来的，正常回' }
      }
      唤醒时间.delete(sid)
      静默轮.add(sid)
      const 理由 = String((args && args.reason) || '').trim()
      记账('回复门槛：判定这条不是在跟我说话 → 这轮不回 QQ（' + 短id(sid) + '）' + (理由 ? '，理由：' + 理由 : ''))
      // ⭐ 2026-10-25 第二版（她指出的）：**「停轮」本来就是靠 cancel 实现的** ——
      //    不 cancel 只是掐掉出站，模型还会继续想、继续调工具，白烧 token。
      //    所以要真停，但别让界面显示成 `Error: tool call aborted`：
      //    **先让这个工具正常返回，再在下一个 tick 去 cancel** —— 工具结果已经落地，
      //    就不会被标成 aborted；随后这一轮才被停下。
      静默轮.add(sid)
      const 真停 = Boolean(读配置().门槛真停轮)
      if (!真停) {
        记账('回复门槛：这轮不接（只掐出站；「真停轮」关着）')
        return { ok: true, 说: '好，这轮不接 —— 到此为止，不用再说任何话。' }
      }
      setTimeout(() => {
        try {
          if (typeof agent.cancel === 'function') {
            Promise.resolve(agent.cancel({ kind: 'user' })).catch((error) => {
              记账('   cancel 报错：' + String((error && error.message) || error))
            })
          } else {
            记账('   ⚠ agent.cancel 不在这台宿主上 —— 只能靠「这轮不发」兜住')
          }
        } catch (error) {
          记账('   cancel 抛错：' + String((error && error.message) || error))
        }
      }, 0)
      return { ok: true, 说: '好，这轮不接 —— 到此为止，不用再说任何话。' }
    },
  })

  /** 每一小跳：门槛开着就给「绑了 QQ 的那几间屋」挂上这个工具，关掉就卸下来 */
  function 闸门心跳() {
    try {
      const 配置 = 读配置()
      const 该挂 = new Set()
      // ⭐ 只认每一行自己的门槛（0.8.2 去掉了那个让人犯晕的总开关）
      for (const 行 of (配置.绑定 || [])) {
        if (行.类型 !== '群') continue     // 私聊不判（自己私聊本来就是在跟它说话）
        if (!行.门槛) continue
        const id = String(行.会话 || '').trim()
        if (id) 该挂.add(id)
      }
      // 挂
      for (const id of 该挂) {
        const agent = 找agent(id)
        if (!agent) continue
        const sid = 会话键((agent.session && agent.session.id) || id)
        if (闸门挂着.has(sid)) continue
        try {
          const off = agent.ctx.tools.register(做闸门工具(agent, sid))
          闸门挂着.set(sid, off)
          记账('回复门槛已挂上（' + 短id(sid) + '）')
        } catch (error) {
          记账('回复门槛挂不上（' + 短id(sid) + '）：' + String((error && error.message) || error))
        }
      }
      // 卸
      for (const [sid, off] of 闸门挂着) {
        const 还要 = [...该挂].some((id) => 会话键(id) === sid)
        if (还要) continue
        try { if (typeof off === 'function') off() } catch (error) {}
        闸门挂着.delete(sid)
        记账('回复门槛已卸下（' + 短id(sid) + '）')
      }
    } catch (error) {
      记账('回复门槛心跳出错：' + String((error && error.message) || error))
    }
  }

  /** ⭐ 本机改动：视频抽几帧存到收图目录（有 ffmpeg 才做；没有就返回空数组，调用方退回 [视频]） */
  async function 视频抽帧(段, 序 = 0) {
    const 源 = String((段 && 段.data && (段.data.url || 段.data.file)) || '').trim()
    if (!源) return []
    const ffmpeg = await 找ffmpeg()
    if (!ffmpeg) return []
    try { mkdirSync(收图目录, { recursive: true }) } catch (error) {}
    const 基 = join(收图目录, 'qqv-' + Date.now() + '-' + String(序))
    const 参 = /^https?:/i.test(源) ? ['-headers', 'User-Agent: Mozilla/5.0\r\n', '-i', 源] : ['-i', 源]
    try {
      await new Promise((好, 坏) => {
        const 子 = spawn(ffmpeg, ['-v', 'error', '-y'].concat(参, ['-vf', 'fps=1/2,scale=720:-2', '-frames:v', '3', 基 + '-%d.jpg']), { timeout: 90000 })
        let 错 = ''
        子.stderr.on('data', (d) => { 错 += String(d) })
        子.on('error', 坏)
        子.on('close', (码) => (码 === 0 ? 好('') : 坏(new Error(错.slice(0, 120)))))
      })
    } catch (error) {
      // fps/scale 那套在老 ffmpeg 上可能不支持 —— 退一步：只取第一帧
      try {
        await new Promise((好, 坏) => {
          const 子 = spawn(ffmpeg, ['-v', 'error', '-y'].concat(参, ['-frames:v', '1', 基 + '-1.jpg']), { timeout: 90000 })
          子.on('error', 坏)
          子.on('close', (码) => (码 === 0 ? 好('') : 坏(new Error('抽帧失败'))))
        })
      } catch (error2) {
        记账('视频抽帧失败：' + String((error2 && error2.message) || error2).slice(0, 120))
      }
    }
    const 帧们 = []
    for (let i = 1; i <= 3; i++) {
      const p = 基 + '-' + i + '.jpg'
      try { if (existsSync(p)) 帧们.push(p) } catch (error) {}
    }
    if (!帧们.length) 记账('视频抽帧没出图：' + 源.slice(0, 80))
    return 帧们
  }

  // ── qq_say（⭐ 本机改动，本机改版移植）：她想说才说 ─────────────────────
  //  照门槛那套写法：**按会话动态挂上 / 卸下**（agent.ctx.tools.register 返回的就是 disposer）。
  //  跟门槛的区别：门槛是「投进来之后让模型自己判断要不要接」；这里是「她想说话时的出口」——
  //  这一行 自动发 = false 时，它不自动发，全靠这个工具。
  const 说话挂着 = new Map()   // sid -> disposer

  const 做说话工具 = (agent, sid) => ({
    name: 'qq_say',
    description: '把一句话（可带图）发到 QQ（私聊或群）。这是你唯一对外的说话渠道：不调用它，就不会有任何话发出去；想沉默就别调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要发到 QQ 的正文（原样发出去，别带 markdown 标记）。' },
        images: { type: 'array', items: { type: 'string' }, description: '可选：一起发出去的本地图片路径（要走发图白名单）。' },
      },
      required: ['text'],
    },
    // ⚠ DSH 要求每个工具声明 output；而且 required 只能放**顶层**，写到属性里会被拒
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, 送去: { type: 'string' }, 说: { type: 'string' } },
        required: ['ok', '送去', '说'],
      },
      render: (_args, v) => [{ type: 'text', text: (v && typeof v === 'object' && v.说) ? String(v.说) : (typeof v === 'string' ? v : JSON.stringify(v)) }],
    },
    async execute(args, exec) {
      const 配置 = 读配置()
      if (!配置.总开关) return { ok: false, 送去: '', 说: '总开关关着，这句没发出去' }
      // 按 exec 里的 agent / session 找「这一行」
      const 候选 = []
      try { if (exec && typeof exec.sessionId === 'string') 候选.push(exec.sessionId) } catch (error) {}
      try { if (exec && exec.agent && exec.agent.session && typeof exec.agent.session.id === 'string') 候选.push(exec.agent.session.id) } catch (error) {}
      try { if (exec && exec.agent && typeof exec.agent.id === 'string') 候选.push(exec.agent.id) } catch (error) {}
      try { if (exec && exec.session && typeof exec.session.id === 'string') 候选.push(exec.session.id) } catch (error) {}
      候选.push(sid)
      const 表 = 配置.绑定 || []
      let 行 = null
      for (const 名 of 候选) {
        行 = 表.find((b) => 会话键(b.会话) === 会话键(名)) || null
        if (行) break
      }
      if (!行) {
        记账('qq_say：找不着这一轮是哪条绑定（候选 ' + JSON.stringify(候选.map((x) => 短id(x))) + '），这句没发')
        return { ok: false, 送去: '', 说: '这间会话没绑任何 QQ 聊天，没地方发' }
      }
      if (行.发 === false) {
        记账('qq_say：这一行「发」关着，这句没发')
        return { ok: false, 送去: '', 说: '这一行的「发」关着，这句没发出去' }
      }
      const 图块 = []
      for (const p of (Array.isArray(args && args.images) ? args.images : [])) {
        const 原 = String(p == null ? '' : p).trim()
        if (!原) continue
        let 全 = 原
        try { 全 = existsSync(原) ? 原 : (找本地图(原, 配置) || 原) } catch (error) {}
        if (!图在内吗(全)) { 记账('qq_say：这张图不在允许的目录里，没发：' + 全); continue }
        图块.push(全)
      }
      // 图片用 markdown 图那套塞进正文（发到QQ 自己会把它们抠成图片段发出去）
      let 待发 = String((args && args.text) || '').trim()
      for (const p of 图块) 待发 += (待发 ? String.fromCharCode(10) : '') + '![图](' + p + ')'
      if (!待发) return { ok: false, 送去: '', 说: '没给 text，也没有能发的图' }
      const 结果 = await 发到QQ(配置, 待发, [], 行.会话)
      const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
      if (全过) 记出声(行)
      记账('qq_say：' + (全过 ? '✅ 它自己决定发了' : '⚠ 没发成') + ' → ' + 行.类型 + ':' + 行.号码 + (图块.length ? '（含 ' + 图块.length + ' 张图）' : ''))
      for (const r of 结果) if (!r.ok) 记账('   ' + r.action + ' 失败：' + JSON.stringify(r.数据).slice(0, 140))
      return { ok: 全过, 送去: 行.类型 + ':' + 行.号码, 说: 全过 ? '发出去了' : '没发成，看看桥的日志' }
    },
  })

  /** ⭐ 每一小跳：给「绑了 QQ 的那几间屋」挂上 qq_say，不绑了就卸下来（照门槛心跳） */
  function 说话心跳() {
    try {
      const 配置 = 读配置()
      const 该挂 = new Set()
      for (const 行 of (配置.绑定 || [])) {
        if (行.发 === false) continue
        const id = String(行.会话 || '').trim()
        if (id && !/^(新|new)(\s|:|$)/i.test(id)) 该挂.add(id)
      }
      // 挂
      for (const id of 该挂) {
        const agent = 找agent(id)
        if (!agent) continue
        const sid = 会话键((agent.session && agent.session.id) || id)
        if (说话挂着.has(sid)) continue
        try {
          const off = agent.ctx.tools.register(做说话工具(agent, sid))
          说话挂着.set(sid, off)
          记账('qq_say 已挂上（' + 短id(sid) + '）')
        } catch (error) {
          记账('qq_say 挂不上（' + 短id(sid) + '）：' + String((error && error.message) || error))
        }
      }
      // 卸
      for (const [sid, off] of 说话挂着) {
        const 还要 = [...该挂].some((id) => 会话键(id) === sid)
        if (还要) continue
        try { if (typeof off === 'function') off() } catch (error) {}
        说话挂着.delete(sid)
        记账('qq_say 已卸下（' + 短id(sid) + '）')
      }
    } catch (error) {
      记账('qq_say 心跳出错：' + String((error && error.message) || error))
    }
  }

  /**
   * 轮询 NapCat 的 HTTP 历史接口，把「她新发的私聊 / 群消息」一条条转进 DSH。
   * ⚠ 纯 HTTP 轮询：不连 WebSocket、不依赖 BOT。
   * ⚠ 只认 `私聊QQ` 这个人发的（群也一样按这个号过滤），自己的回话不会自我繁殖。
   */
  /**
   * ⭐ 2026-10-30（官方线 · 入站）：官方机器人是「推」不是「拉」——
   *   没有水位、没有回声锁（平台不会把我们自己发的推回来）、群里能收到就说明被 @ 了
   *   （平台那层已经筛过），所以群里不再按「收档」二次筛（总开关 / 只认 / 静默照旧）。
   *   与轮询那条的共同点：都走 条转片段 + 转入一批，投递口径完全一样。
   */
  // ⭐ 2026-10-30：拉一个 NapCat 接口（合并转发 / 语音落文件用）。官方模式下用不到
  //   （官方事件里不会出现 forward / record 这些段型），调不到也不影响入站。
  const 拉任意通用 = async (action, 体) => {
    const 配置 = 读配置()
    try {
      const r = await fetch(`${配置.NapCat}/${action}`, {
        method: 'POST', headers: 请求头(配置), body: JSON.stringify(体 || {}),
      })
      const j = await r.json()
      return (j && j.status === 'ok' && j.data) || null
    } catch (error) {
      return null
    }
  }

  // ⭐ 2026-10-30：从轮询函数里提出到这一层 —— 官方线（推）与轮询线（拉）共用同一套截面解析。
  const 条转片段 = async (条) => {
    const 配置 = 读配置()
    const 收图上限 = () => Math.max(1, Math.min(Number(配置.收图最多) || 4, 10))
    const 段们 = Array.isArray(条.message) ? 条.message : []
    const 图们 = []
    const 文们 = []
    for (const 段 of 段们) {
      if (!段 || !段.data) continue
      const 型 = String(段.type || '')
      if (型 === 'text') { 文们.push(String(段.data.text || '')); continue }
      if (型 === 'image') { 图们.push(段); continue }
      // ⭐ 本机改动：超级表情带 url 的照旧当图收；**没 url 的**给一句中文占位，别让整条变空气
      if (型 === 'mface') {
        if (段.data && 段.data.url) { 图们.push(段); continue }
        const 超 = String(段.data.summary || 段.data.text || 段.data.qq || '').trim()
        文们.push('〔超级表情' + (超 ? '：' + 超 : '') + '〕')
        continue
      }
      if (型 === 'json' || 型 === 'xml') { 文们.push(卡片文字(段)); continue }
      if (型 === 'forward') {
        // ⭐ 转发里的图**跟着「收图」这个开关走**（不另加开关）：开着收几张，关着只标 [图片]
        const 袋 = 配置.收图 ? [] : null
        try {
          const 文 = await 转发文字(段, 拉任意通用, 袋)
          文们.push(文)
          if (Array.isArray(袋) && 袋.length) {
            const 余量 = Math.max(0, 收图上限() - 图们.length)
            for (const x of 袋.slice(0, 余量)) 图们.push(x)
          }
        } catch (error) { 文们.push('[合并转发的聊天记录（读失败了）]') }
        continue
      }
      if (型 === 'at') { 文们.push('@' + String((段.data && (段.data.name || 段.data.qq)) || '')); continue }
      // ⭐ 本机改动：QQ 表情给一句读得懂的（〔QQ表情：/微笑〕），别只丢一个 [表情]
      if (型 === 'face') {
        const 名 = String(((段.data.raw || {}).faceText) || '').replace(/^\//, '').trim()
        文们.push('〔QQ表情' + (名 ? '：' + 名 : (段.data.id ? '：' + String(段.data.id) : '')) + '〕')
        continue
      }
      if (型 === 'record') {
        // ⭐ 0.8.0：开着「语音转写」且配了命令 → 把语音条变成文字；否则还是 [语音]
        文们.push(await 转写语音(段, 拉任意通用, 配置, {
          家目录: dirname(配置文件), ffmpeg: await 找ffmpeg(), 消息id: 条.message_id,
        }))
        continue
      }
      if (型 === 'video') {
        // ⭐ 本机改动：有 ffmpeg 就抽几帧（图给模型看，路径写进正文）；没有就退回 [视频]
        const 帧们 = await 视频抽帧(段, 图们.length)
        if (帧们.length) {
          文们.push('〔视频〕')
          for (const 帧 of 帧们) 图们.push({ type: 'image', data: { url: 'file://' + 帧 } })
          文们.push('（' + 配置.称呼 + '发来一段视频，抽了 ' + 帧们.length + ' 帧，存在这里：' + 帧们.join('、') + '）')
        } else {
          文们.push('[视频]')
        }
        continue
      }
      // ⭐ 本机改动：别的段型也别当空气 —— 给一句中文占位（位置 / 名片 / 音乐 / 戳一戳 / 骰子 / 猜拳 / 富文本）
      if (型 === 'location') {
        const 地 = String(段.data.title || 段.data.content || 段.data.name || '').trim()
        文们.push('〔位置' + (地 ? '：' + 地 : '') + '〕')
        continue
      }
      if (型 === 'contact') {
        const 卡 = String(段.data.nickname || 段.data.name || '').trim() || String(段.data.qq || 段.data.user_id || '').trim()
        文们.push('〔名片' + (卡 ? '：' + 卡 : '') + '〕')
        continue
      }
      if (型 === 'music') {
        const 曲 = String(段.data.title || 段.data.name || '').trim()
        文们.push('〔音乐' + (曲 ? '：' + 曲 : '') + '〕')
        continue
      }
      if (型 === 'poke') { 文们.push('〔戳一戳〕'); continue }
      if (型 === 'dice') {
        const 点 = 段.data.result == null ? '' : String(段.data.result)
        文们.push('〔骰子' + (点 ? '：' + 点 : '') + '〕')
        continue
      }
      if (型 === 'rps') {
        const 拳 = 段.data.result == null ? '' : String(段.data.result)
        文们.push('〔猜拳' + (拳 ? '：' + 拳 : '') + '〕')
        continue
      }
      if (型 === 'markdown') { 文们.push('〔富文本消息〕'); continue }
      if (型 === 'file') {
        const 件 = String(段.data.name || 段.data.file || '').trim()
        文们.push('〔文件' + (件 ? '：' + 件 : '') + '〕')
        continue
      }
      if (型 === 'reply') continue   // 引用只是个「头」，正文里不加噪音（老行为）
      // 其余不认识的段型：给个占位，别让整条变成空气
      if (型) 文们.push('〔' + 型 + '〕')
    }
    return { 文字: 文们.join(String.fromCharCode(10)).trim(), 图们 }
    }

  async function 官方收一条(条, 行) {
    const 配置 = 读配置()
    if (!配置.总开关) { 记账('官方线来了一条，但总开关关着，没转（' + 短id(行.会话) + '）'); return }
    if (行.收 === false) return
    const 键2 = 行.类型 + ':' + 行.号码
    const 只认 = String(行.只认 || '').trim()
    if (只认 && 只认 !== '0' && 只认 !== String(条.user_id)) {
      记账('「' + 键2 + '」这条按「只认」不看（' + String(条.user_id) + '）')
      return
    }
    const 官方主 = String(配置.官方主人openid || '').trim()
    const 是主人 = !!官方主 && String(条.user_id) === 官方主
    const { 文字, 图们 } = await 条转片段(条)
    // ⭐ 2026-10-30：入站记账（看得见才查得动）
    记账('收到官方消息「' + 键2 + '」：' + (String(文字 || '').slice(0, 60) || '（没文字）') + (图们.length ? '｜图 ' + 图们.length + ' 张' : ''))
    if (!文字 && !图们.length) { 记账('这条没转出内容（' + 键2 + '），没投'); return }
    if (配置.静默两边都停 && 在静默里(配置)) {
      记账('静默时段「' + 配置.静默时段 + '」里，官方线这条不投（不叫醒她）')
      return
    }
    const 昵 = String((条.sender && (条.sender.card || 条.sender.nickname)) || 条.user_id || '')
    const 发送者 = { 昵称: (是主人 ? '主人·' : '') + 昵, 号码: 0 }
    const 结果 = await 转入一批([{ 文字, 图们, 消息id: 条.message_id, 发送者, 时刻: 条.time || 0 }], 行)
    if (!(结果 && 结果.ok)) 记账('官方线这条没转进去（' + 短id(行.会话) + '：' + String((结果 && 结果.说) || '原因不明') + '）')
  }

  // 官方线实例：只在 协议=qq-official 时才启动（见下面的轮询那一段），不是官方模式就不占连接。
  const 官方线 = 开官方线({ 读配置, 收一条: 官方收一条, 记账 })

  async function 轮询收消息() {
    // ⭐ 本机改动（回声锁）：轮询开跑前把自己这个 QQ 号拿一次（失败 60 秒后再试）
    try { await 拿自己号(读配置()) } catch (error) {}
    const 配置 = 读配置()
    // 总开关关 / 一条绑定都没有：只把「上次时间」推到此刻，别开的时候就补一大串旧的
    if (!配置.总开关 || !(配置.绑定 || []).length) {
      for (const k of [...上次时间.keys()]) 上次时间.set(k, Math.floor(Date.now() / 1000))
      return
    }
    // 群里只认「私聊那行绑的那个号」（就是你自己）；没绑私聊行的话，群里谁的话都不转
    const 本人号 = Number(((配置.绑定 || []).find((x) => x.类型 === '私聊') || {}).号码) || 0

    const 拉 = async (action, 体) => {
      try {
        const r = await fetch(`${配置.NapCat}/${action}`, {
          method: 'POST', headers: 请求头(配置), body: JSON.stringify(体),
        })
        const j = await r.json()
        return j && j.status === 'ok' && Array.isArray(j.data && j.data.messages) ? j.data.messages : []
      } catch (error) {
        return []
      }
    }
    // ⭐ 拉任意一个 NapCat 接口（合并转发要单独取一次内容；它的返回不是 data.messages 那种形状）
    const 拉任意 = async (action, 体) => {
      try {
        const r = await fetch(`${配置.NapCat}/${action}`, {
          method: 'POST', headers: 请求头(配置), body: JSON.stringify(体 || {}),
        })
        const j = await r.json()
        return (j && j.status === 'ok' && j.data) || null
      } catch (error) {
        return null
      }
    }
    // ⚠️ 2026-10-25（用户报「读不了 B站 卡片 / 转发记录」）：以前这里只看 text / image / mface，
    //    卡片和合并转发既没文字也没图 ⇒ 整条被当成空消息丢掉。现在它们也会变成文字。

    // ⭐ 2026-10-27：一次投递最多带几条 —— 同一跳里到的消息算「一场」，但也别一口吃太多
    const 单批最多 = 8
    // ⭐ 0.6.0：一行一行地拉 —— 一个聊天 → 一间会话，各自记各自的「看到哪儿了」
    for (const 行 of 配置.绑定) {
      if (行.收 === false) continue   // ⭐ 本机改动：这一行「收」关着（本机旧配置里的字段）
      const 是群 = 行.类型 === '群'
      const 动作 = 是群 ? 'get_group_msg_history' : 'get_friend_msg_history'
      const 体 = 是群
        ? { group_id: Number(行.号码), count: 30 }
        : { user_id: Number(行.号码), count: 10 }
      const 列表 = await 拉(动作, 体)
      const 键2 = 行.类型 + ':' + 行.号码
      // ⚠️ 没记录过这个聊天（比如刚加绑定 / 第一次跑）时，从**此刻**开始算 ——
      //   否则历史消息会全被当成新的补投一遍（她报的那个「没发消息却自己回了」就有这一层）。
      let 上次 = 上次时间.has(键2) ? (上次时间.get(键2) || 0) : Math.floor(Date.now() / 1000)
      // ⭐ 2026-10-27（按「一场」投递）：这一跳该转的先后攒起来，最后一次性投给她
      const 待转 = []
      for (const 条 of 列表.sort((a, b) => (a.time || 0) - (b.time || 0))) {
        if (!条) continue
        // 私聊：只认对面那个号。
        // ⭐ 本机改动（只认）：群里改成读**这一行自己的**「只认」——
        //   ''（默认）= 老规矩，只认主人号；'0' = 谁的话都收；别的值 = 只认那个 QQ 号。
        const 只认 = String(行.只认 || '').trim()
        const 群里认 = 只认 === '0' ? 0 : (只认 ? Number(只认) || 0 : 本人号)
        if (是群 ? (群里认 && Number(条.user_id) !== 群里认) : (Number(条.user_id) !== Number(行.号码))) continue
        if (!是群 && !本人号) continue
        // ⭐ 本机改动（回声锁）：她自己发出去的话不算「新消息」（否则她回一句又被投回来，无限回声）
        if (自己号 && Number(条.user_id) === 自己号) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          continue
        }
        if (条.message_id != null && 自己发过.has(String(条.message_id))) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          continue
        }
        if ((条.time || 0) < 上次) continue           // 旧的，跳过
        if (已转消息.has(条.message_id)) continue     // 转过了
        const { 文字, 图们 } = await 条转片段(条)
        // 纯表情（没图没字）就别转了，记掉别再反复拉
        if (!文字 && !图们.length) { 已转消息.add(条.message_id); 上次 = 条.time || 上次; continue }
        // ⭐ 本机改动（收档）：**投递前的便宜过滤** —— 只判群，私聊不过滤。
        //   全收 = 都投；半收 = 点名了、或她刚在这间说过话（半收分钟以内）；点名 = 只有点名了才投。
        if (是群 && !要收吗(配置, 行, 文字, 本人号, 出声时刻(键2))) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          记账('「' + 键2 + '」这条按收档「' + String(行.收档 || '全收') + '」不收，跳过（不投）')
          continue
        }
        // ⭐ 2026-10-27（深夜静默 · 入站那一半）：静默里这条**不投**（不叫醒她）——
        //   她整夜一个字都不会往外发，早上也不补投（夜里的事就让它过去，别一睁眼回一串旧的）。
        if (配置.静默两边都停 && 在静默里(配置)) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          记账('静默时段「' + 配置.静默时段 + '」里，这条不投（不叫醒她，免得夜里出声）')
          continue
        }
        // ⭐ 2026-10-27（接话概率 / 冷却 · **可选手闸，默认关**）：主人定的口径是「群消息全收，
        //   接不接由她自己决定」—— 桥不替她筛（他明确否掉了概率接话）。只在号太烫时把
        //   接话概率/冷却分钟 收窄才生效；收窄后仍然：被点名（@ / 别名 / 主人号）一定送到她面前。
        const 限这一行 = 是群 || !!配置.私聊也限
        if (限这一行 && !点名了(文字, 配置, 本人号)) {
          const 冷却毫秒 = Math.max(0, Number(配置.冷却分钟) || 0) * 60000
          if (冷却毫秒 > 0 && Date.now() - 出声时刻(键2) < 冷却毫秒) {
            已转消息.add(条.message_id)
            上次 = 条.time || 上次
            记账('「' + 键2 + '」还在冷却里（' + Number(配置.冷却分钟) + ' 分钟），这条不接')
            continue
          }
          const 率 = Math.max(0, Math.min(100, Number(配置.接话概率)))
          if (率 <= 0) {
            已转消息.add(条.message_id)
            上次 = 条.time || 上次
            记账('「' + 键2 + '」接话概率 0%：没被点名的消息一律不接')
            continue
          }
          if (率 < 100 && Math.random() * 100 >= 率) {
            已转消息.add(条.message_id)
            上次 = 条.time || 上次
            记账('「' + 键2 + '」按接话概率 ' + 率 + '% 掷骰子没中，这条不接')
            continue
          }
        }
        // ⚠️ 2026-10-25（她问的）：那间会话要是**当时没开着**（死的），这条不能算「转过了」——
        //   否则她一会儿把它点活了，这条就永远丢了（还不会补）。
        //   所以：**真转进去了**才算数；没转进去就不动「上次」和「已转」，下一跳（4 秒后）自己再来一遍。
        // ⚠️ 2026-10-25（她报的「打开会话就被自动回一条」）：会话关着的时候攒下的旧消息，
        //    隔太久（默认 10 分钟）就别补投了 —— 否则她一点进那间屋，就会突然冒出一条「自动回复」。
        const 太旧 = (条.time || 0) > 0 && (Math.floor(Date.now() / 1000) - 条.time) > (Number(配置.补投窗口分) || 10) * 60
        if (太旧) {
          已转消息.add(条.message_id)
          上次 = 条.time || 上次
          记账('这条 QQ 消息已经是 ' + Math.round((Date.now() / 1000 - 条.time) / 60) + ' 分钟前的了，不再补投（怕一打开会话就冒出一条旧回复）')
          continue
        }
        const 发送者 = {
          昵称: String((条.sender && (条.sender.card || 条.sender.nickname)) || 条.nickname || (条.user_id ? 'QQ ' + 条.user_id : '')),
          号码: Number(条.user_id) || 0,
        }
        待转.push({ 文字, 图们, 消息id: 条.message_id, 发送者, 时刻: 条.time || 0 })
        // 一批最多 8 条：再多就拆成两跳（4 秒后接着来），别一次灌一大坨
        if (待转.length >= 单批最多) break
      }
      // ⭐ 这一跳攒下的一批：一次投递、只叫醒她一次。
      //    能转进去才算数 —— 没转进去就什么都不标，下一跳整个重来（不会漏）。
      if (待转.length) {
        const 结果 = await 转入一批(待转, 行)
        if (结果 && 结果.ok) {
          for (const 项 of 待转) {
            已转消息.add(项.消息id)
            上次 = 项.时刻 || 上次
          }
        } else {
          记账('这一跳有 ' + 待转.length + ' 条没转进去（' + 短id(行.会话) + '：' + String((结果 && 结果.说) || '原因不明') + '），下一跳再试')
        }
      }
      上次时间.set(键2, 上次)
    }

    if (已转消息.size > 300) {
      // 别 clear（clear 会让下一跳把旧的又当新的）—— 只留最近 300 个
      const 全 = [...已转消息]
      for (const id of 全.slice(0, Math.max(0, 全.length - 300))) 已转消息.delete(id)
    }
    存水位()
  }

  路线(`${路由前缀}/receive`, async (req, res) => {
    const 来 = await 读体(req)
    const 文字 = typeof 来.text === 'string' ? 来.text.trim() : ''
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    回(res, await 转入文字(文字))
  })

  // 手动试一发：**真发**（绕过试运行），只发一条固定测试句，动不了已发轮
  路线(`${路由前缀}/test-send`, async (req, res) => {
    await 读体(req)
    const 配置 = 读配置()
    if (!配置.私聊QQ && !配置.群号) return 回(res, { ok: false, 说: '私聊 QQ 和群号都是空的，先保存一个再试' })
    const 文字 = '（这是一条测试消息：DSH → QQ 通了）'
    // ⚠ 2026-10-25（本机修正）：0.9.6 的发到QQ 要「方向=会话」，测试路径得自己挑一行绑定，
    //    否则会走到「这间会话没绑任何 QQ 聊天」。优先私聊行。
    const 测行 = (配置.绑定 || []).find((b) => b.类型 === '私聊' && b.发 !== false) || (配置.绑定 || [])[0] || null
    const 结果 = await 发到QQ(配置, 文字, [], 测行 ? 测行.会话 : '')
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    记账(`手动测试：${全过 ? '✅ 已发' : '⚠ 有问题'}「${文字}」`)
    for (const r of 结果) if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    回(res, { ok: 全过, 说: 全过 ? '测试句已经发到 QQ 了' : '有一步没发出去（看下面的记录）', 记录: 日志 })
  })

  // ── 主动说一句（2026-10-27，主人点头加的口子）────────────────────────────
  //   起因：无声心跳是 `target=new` 的新会话、没绑任何 QQ 聊天 —— `qq_say` 只挂在「绑了 QQ 的
  //   那几间屋」，所以心跳既拿不到工具、也不会被自动转发。心跳想跟主人讨论点事就没嘴了。
  //   这条路由给「任何本机调用方」（心跳、脚本、别的会话）补上那张嘴：POST 一句文字就发。
  //   ⚠ 口令守着：`/root/.dsh/qq-say-token` 里那串（外面猜不到）。**文件没了就拒所有人** ——
  //     这道口子是「以我的名义往主人手机发话」，失败必须关着，不能开着。
  //   ⚠ 该守的门一个不少：总开关 / 试运行 / 深夜静默 / 出站限速（限速在 发到QQ→发一个 里）。
  //     有意**不走** 落地一发 那三道「会话自己说话」的闸（自动发 / 只发标记内 / 只回QQ唤醒）：
  //     那三道是给「被动转发」定的，这里是主动开口，语义跟 qq_say 一样。
  //     宿主只听 192.168.31.220:3080（不是 127.0.0.1），所以同机 curl 也得用这个地址。
  路线(`${路由前缀}/say`, async (req, res) => {
    const 来 = await 读体(req)
    let 该是 = ''
    try { 该是 = String(readFileSync('/root/.dsh/qq-say-token', 'utf8')).trim() } catch (error) { 该是 = '' }
    const 给 = String(req.headers['x-qq-say-token'] || 来.口令 || '').trim()
    if (!该是) return 回(res, { ok: false, 说: '没配口令文件 /root/.dsh/qq-say-token —— 这条口子先关着' })
    if (给 !== 该是) {
      记账(`主动说一句：口令不对，拒了（来源 ${String((req.socket && req.socket.remoteAddress) || '?')}）`)
      return 回(res, { ok: false, 说: '口令不对' })
    }
    const 文字 = String((typeof 来.text === 'string' ? 来.text : 来.文字) || '').trim()
    if (!文字) return 回(res, { ok: false, 说: '没有文字（body 里给 text）' })
    const 配置 = 读配置()
    if (!配置.总开关) return 回(res, { ok: false, 说: '总开关关着，这句没发' })
    if (配置.试运行) {
      记账(`主动说一句（试运行开着，只记账没真发）：「${文字.slice(0, 40)}」`)
      return 回(res, { ok: true, 说: '试运行开着：只记了一笔账，没真发' })
    }
    if (配置.静默两边都停 && 在静默里(配置)) {
      记账(`主动说一句撞上静默时段「${配置.静默时段}」，这句没发`)
      return 回(res, { ok: false, 说: `静默时段「${配置.静默时段}」里不往 QQ 发（保号护栏）` })
    }
    const 绑定们 = 配置.绑定 || []
    const 想类型 = String(来.类型 == null ? '私聊' : 来.类型).trim()
    const 想号码 = 来.号码 == null ? '' : String(来.号码).trim()
    const 行 = 绑定们.find((b) => b.发 !== false
        && (想号码 === '' || String(b.号码) === 想号码)
        && (想类型 === '' || String(b.类型) === 想类型))
      || 绑定们.find((b) => b.发 !== false)
      || null
    if (!行) return 回(res, { ok: false, 说: '绑定里没有能发的行（去设置页加一条）' })
    const 结果 = await 发到QQ(配置, 文字, [], 行.会话)
    const 全过 = 结果.length > 0 && 结果.every((r) => r.ok)
    if (全过) 记出声(行)
    记账(`主动说一句 → ${行.类型}:${行.号码} ${全过 ? '✅ 已发' : '⚠ 没发成'}「${文字.slice(0, 40)}${文字.length > 40 ? '…' : ''}」`)
    for (const r of 结果) if (!r.ok) 记账(`   ${r.action} 失败：${JSON.stringify(r.数据).slice(0, 140)}`)
    return 回(res, { ok: 全过, 说: 全过 ? '发出去了' : '有一步没发成（看桥的记录）', 目标: `${行.类型}:${行.号码}`, 记录: 结果 })
  })

  // ---------- 挂监听 ----------

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        收到事件(session, event)
      } catch (error) {
        记账(`转发时出错：${String((error && error.message) || error)}`)
      }
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  }, 'qq-bridge: 盯伙伴说话')

  // 轮询 NapCat 收「她新发的 QQ」→ 转进 DSH（QQ → DSH 这半，不赖 BOT）
  ctx.effect(() => {
    const 官方模式 = String(读配置().协议 || '') === 'qq-official'
    if (官方模式) 官方线.启动()
    if (typeof ctx.interval !== 'function') {
      记账('拿不到 timer（ctx.interval 不在）—— QQ → DSH 的轮询收消息跑不起来，但 DSH → QQ 照常能用')
      return () => {}
    }
    // ⭐ 2026-10-27（堵重复投递）：轮询原来是 fire-and-forget 且没有重入锁 ——
    //    而「转入」里要下载图片、要叫醒会话，经常超过这 4 秒 ⇒ 下一跳并发跑起来，
    //    同一条被两跳各投一次（「已转」是 Set，所以看着只有一条，其实她被叫醒了两次）。
    //    加个在跑标志：上一跳没跑完，这一跳让开。
    let 在跑 = false
    const 停 = ctx.interval(() => {
      闸门心跳()
      说话心跳()   // ⭐ 本机改动：qq_say 也跟着心跳挂上 / 卸下
      // ⭐ 本机改动：占位符行（会话 = 新 / new）把空屋子补出来 —— 先建屋子、不必等消息
      void 补空屋().catch((error) => {
        try { ctx.logger?.info(`qq-bridge: 补空屋出错：${String((error && error.message) || error)}`) } catch (e3) {}
      })
      if (官方模式) return   // ⭐ 官方线是推送：不拉 NapCat 历史（闸门/说话 心跳照旧挂）
      if (在跑) {
        记账('上一跳轮询还没跑完（在下载图片 / 叫醒会话），这一跳让开 —— 免得同一条被投两遍')
        return
      }
      在跑 = true
      void 轮询收消息()
        .catch((error) => {
          try { ctx.logger?.info(`qq-bridge: 轮询出错：${String((error && error.message) || error)}`) } catch (e2) {}
        })
        .finally(() => { 在跑 = false })
    }, 4000)
    return () => {
      try { 官方线.停() } catch (error) {}
      try {
        if (typeof 停 === 'function') 停()
      } catch (error) {}
    }
  }, 'qq-bridge: 轮询收 QQ 消息')

  // ⭐ 2026-10-27（空屋子也能建）：配置里 `会话` 还是占位符（新 / new）的行，把屋子开出来。
  //    以前只有「有消息来的那一跳」才开间 —— 于是想先建两间空会话待用，根本做不到。
  //    开好之后写回真会话号；开一间里顺带补工作区记账（不然它在侧栏里是「未分类」）。
  //    失败的行一分钟内不重复试（免得每 4 秒刷一条账）；一行同时只跑一个（防并发双建）；
  //    刚开完又被改回占位符（典型：面板浏览器里还拿着旧值、保存时把真号盖回去）→ 5 分钟内复用它。
  const 补屋试过 = new Map()
  const 补屋记 = new Map()
  let 补屋在跑 = false
  async function 补空屋() {
    if (补屋在跑) return
    补屋在跑 = true
    try {
      const 现配置 = 读配置()
      for (const 行 of (现配置.绑定 || [])) {
        const 键 = String(行.类型 || '') + ':' + String(行.号码 || '')
        const 这间 = String((行 && 行.会话) || '').trim()
        if (!/^(新|new)(\s|:|$)/i.test(这间)) { 补屋试过.delete(键); continue }
        // 刚给这行开过、又被改回占位符 —— 直接把刚才那间写回去，别再造一间
        // （2026-10-27 事故：面板来回保存 → 我这边来回建，一口气开了 7 间空屋子）
        const 记 = 补屋记.get(键)
        if (记 && (Date.now() - 记.时) < 300000) {
          记账(`${键} 又被改回占位符了 —— 5 分钟前刚给它开过（${短id(记.号)}），直接复用，不再重复建`)
          写回会话号(行, 记.号)
          continue
        }
        const 上次 = 补屋试过.get(键) || 0
        if (Date.now() - 上次 < 60000) continue
        补屋试过.set(键, Date.now())
        记账(`这一行（${键}）的会话还是占位符「${这间}」—— 先给它开一间空屋子`)
        const 开 = await 开一间(行)
        if (开 && 开.id) { 补屋记.set(键, { 号: 开.id, 时: Date.now() }); 写回会话号(行, 开.id) }
        else 记账(`${键} 的屋子没开成，一分钟后再试`)
      }
    } finally { 补屋在跑 = false }
  }

  记账(`已装好 v${版本}：DSH↔QQ 两半都在｜总开关 ${读配置().总开关 ? '开' : '关'}｜试运行 ${读配置().试运行 ? '开（只记账）' : '关（真发）'}｜收消息 4 秒轮询一次`)

  return { 记账, 概况, 落地一发, 发到QQ, 收到事件, 日志 }
}

// ⭐ 本机改动：新加的纯函数导出出去 —— `node -e "import('file://…').then(m => …)"` 里能直接喂单测
export { 要收吗, 点名了, 归属头, 图在内, 表情查找, 在静默里 }