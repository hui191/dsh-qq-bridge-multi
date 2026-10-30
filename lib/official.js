/**
 * QQ 官方机器人（qq-official）协议层 —— 自家 fork 的第一个「自己完善」增量。
 *
 * 为什么单独一个文件：OneBot 线是「HTTP 轮询 + QQ 号」，官方线是「WS 推送 + openid」，
 * 两边的形状差得远。把官方线关在这里，host.js 只认两个口子：
 *   收 —— 收一条(条, 行)      （跟轮询泵里那条一模一样的形状，下游过滤/投递全复用）
 *   发 —— 发(行, 文字, 图们)  （返回 [{action, ok, 数据}]，跟 OneBot 的 发一个 同形）
 *
 * 协议依据（两份都是 MIT，我只抄「协议形状」，代码自己写）：
 *   · arrow1031-dev/dsh-qq-bot 的 lib/transport/adapters/qq-official.mjs（0.12.7，在我们这台机器上真跑通过）
 *   · dsh-bot-gateway 的 lib/adapters/qqofficial.js（456 行，紧凑版）
 *
 * 与 OneBot 线的硬差别（以后自己别忘）：
 *   1. 下行只有 msg_type 0(文本)/2(markdown)/6(输入中)/7(富媒体)，**没有 at 段**；
 *   2. 图片必须先 POST /v2/{users|groups}/{id}/files 换 file_info，再 msg_type=7 带 media.file_info；
 *      直传 file_data 上限 5MB（base64 也算在里面）；
 *   3. 被动回复窗：收到一条消息起 5 分钟 / 同一 msg_id 最多 5 条（msg_id + 递增 msg_seq）；
 *      窗外官方**可能**不收（要「主动消息」权限），发不出去时我们把 API 的原话带回来，不装死；
 *   4. ID 全是 openid 字符串（user_openid / group_openid / member_openid），**不是 QQ 号、也反查不了**。
 */

const 默认网关 = 'wss://api.sgroup.qq.com/websocket'
const 默认主动图 = 'https://api.bot.qq.com'
const 沙箱图 = 'https://sandbox.api.sgroup.qq.com'

// 群 @ 消息(1<<25) + 单聊消息(1<<26) —— 官方线里这两档才收得到人说的话
const 默认intents = (1 << 25) | (1 << 26)

const 文字每块 = 500          // 官方 content 上限 500 字
const 被动条数 = 5            // 一个 msg_id 最多回 5 条
const 被动分钟 = 5            // 被动回复窗 5 分钟
const 图上限 = 5 * 1024 * 1024 // /files 直传 5MB

const 字 = (v) => (v == null ? '' : String(v))

/** 正文里把 <@openid> / <@!openid> / <@all> 换成人看得懂的写法（官方把「@机器人」本身剥掉了） */
export function 剥提及(正文, 称呼表 = {}) {
  return 字(正文)
    .replace(/<@!?([^>\s]+)>/g, (_全, id) => {
      if (id === 'all') return '@全体成员'
      const 名 = 称呼表[id]
      return 名 ? '@' + 名 : '@'
    })
    .replace(/^\s+/, '')
    .trim()
}

/** 官方事件 → 段（text/image/record/file），跟 OneBot 那条的段形状对齐，好让下游 条转片段 直接吃 */
export function 官方事件转段(内容, 附件们, 称呼表 = {}) {
  const 段们 = []
  const 文 = 剥提及(内容, 称呼表)
  if (文) 段们.push({ type: 'text', data: { text: 文 } })
  for (const 附件 of Array.isArray(附件们) ? 附件们 : []) {
    const 型 = 字(附件 && 附件.content_type).toLowerCase()
    const 址 = 字(附件 && 附件.url)
    if (型.startsWith('image')) {
      if (址) 段们.push({ type: 'image', data: { url: 址, file: 址 } })
      continue
    }
    if (型 === 'voice') {
      const 音址 = 字(附件.voice_wav_url) || 址
      if (音址) 段们.push({ type: 'record', data: { url: 音址, text: 字(附件.asr_refer_text) } })
      continue
    }
    if (型.startsWith('video')) { if (址) 段们.push({ type: 'video', data: { url: 址 } }); continue }
    if (址) 段们.push({ type: 'file', data: { name: 字(附件.filename), url: 址 } })
  }
  return 段们
}

function 切块(文字, 每块) {
  const 行们 = 字(文字).split('\n')
  const 出 = []
  let 当前 = ''
  for (const 行 of 行们) {
    if (当前 && 当前.length + 行.length + 1 > 每块) { 出.push(当前); 当前 = '' }
    if (行.length > 每块) {
      // 单行超长：硬切
      let 剩 = 行
      while (剩.length > 每块) { 出.push(剩.slice(0, 每块)); 剩 = 剩.slice(每块) }
      当前 = 剩
      continue
    }
    当前 = 当前 ? 当前 + '\n' + 行 : 行
  }
  if (当前) 出.push(当前)
  return 出.filter((x) => x !== '')
}

/**
 * 开一条官方线。
 * @param {object} 参数
 * @param {() => object} 参数.读配置   每次要用配置时现读（主人改配置不用重启）
 * @param {(条, 行) => Promise<void>} 参数.收一条  入站回调：条=OneBot 形状、行=命中的绑定行
 * @param {(msg: string) => void} 参数.记账
 * @returns {{ 启动: Function, 停: Function, 状态: Function, 发: Function, 窗: Function }}
 */
export function 开官方线({ 读配置, 收一条, 记账 = () => {} }) {
  const 日志 = (m) => 记账('[官方线] ' + m)

  let 网 = null                 // WebSocket
  let 心跳 = null
  let 序列 = null               // 最近一个 s
  let 停着 = false
  let 重连毫秒 = 1000
  let 重连计时 = null
  let 态 = 'starting'
  let 态说 = '初始化中'
  let token = ''
  let token到 = 0
  let 认身计时 = null           // ⭐ 2026-10-30：IDENTIFY 之后等 READY 的看门狗
  let 认过身 = false

  const 窗 = new Map()          // chatId -> { msgId, 到, 已用 }
  const 收过 = new Set()        // 事件去重（event id）

  function 换态(s, 说) {
    if (态 !== s || 态说 !== 说) 日志(`状态 ${s}：${说}`)
    态 = s
    态说 = 说
  }

  function 图们() {
    const 配置 = 读配置() || {}
    const 沙箱 = 配置.官方沙箱 === true
    return {
      配置,
      沙箱,
      接口: 沙箱 ? 沙箱图 : (字(配置.官方接口) || 默认主动图),
      网关: 字(配置.官方网关),
      appid: 字(配置.官方AppID),
      密钥: 字(配置.官方密钥),
      intents: Number.isFinite(Number(配置.官方intents)) && Number(配置.官方intents) > 0 ? Number(配置.官方intents) : 默认intents,
    }
  }

  async function 取token(强制 = false) {
    const { appid, 密钥, 接口, 沙箱 } = 图们()
    if (!appid || !密钥) throw new Error('官方线还没配 AppID / 密钥')
    if (!强制 && token && Date.now() < token到) return token
    const 址 = (沙箱 ? 沙箱图 : 接口) + '/app/getAppAccessToken'
    // ⭐ 2026-10-30（实测，两次对照）：appId 发成 JSON **数字**会一直吃
    //    HTTP 400 {"code":100002,"message":"internal err"}；发成**字符串**才拿得到 token。
    //    （旧注释「官方要数字型」是我猜的，错了 —— 这个错让我们卡了半小时。）
    //    重试 3 次是给网络抖动留的余地，隔 0.8s / 1.6s。
    let 最后错 = null
    for (let 试 = 0; 试 < 3; 试 += 1) {
      try {
        const 回 = await fetch(址, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: 字(appid), clientSecret: 字(密钥) }),
          signal: AbortSignal.timeout(10000),
        })
        const 文 = await 回.text()
        if (!回.ok) throw new Error(`取 access_token 失败 HTTP ${回.status}：${文.slice(0, 200)}`)
        let 数据 = null
        try { 数据 = JSON.parse(文) } catch { 数据 = null }
        if (!数据 || !字(数据.access_token)) throw new Error('取 access_token 返回异常：' + 文.slice(0, 200))
        token = 字(数据.access_token)
        const 秒 = Number(数据.expires_in) || 7200
        token到 = Date.now() + Math.max(0, 秒 * 1000 - 120000)
        日志('access_token 拿到手（' + 秒 + ' 秒有效）')
        return token
      } catch (错) {
        最后错 = 错
        if (试 < 2) await new Promise((歇) => setTimeout(歇, 800 * (试 + 1)))
      }
    }
    throw 最后错 || new Error('取 access_token 失败')
  }

  // （原先这里有个 jj()：把 appId 转成数字，以为「官方要数字型」—— 猜错了，见上面的实测注释。
  //   appId / clientSecret 一律按字符串原样发。2026-10-30 删。）

  async function 带token(方法, 路径, 体) {
    const { 接口, 沙箱, appid } = 图们()
    const 基 = 沙箱 ? 沙箱图 : 接口
    const 一 = async () => {
      const t = await 取token()
      return fetch(基 + 路径, {
        method: 方法,
        headers: {
          'content-type': 'application/json',
          authorization: 'QQBot ' + t,
          'x-union-appid': 字(appid),
        },
        body: 体 === undefined ? undefined : JSON.stringify(体),
        signal: AbortSignal.timeout(15000),
      })
    }
    let 回 = await 一()
    if (回.status === 401) { await 取token(true); 回 = await 一() }
    if (回.status === 429) {
      let 等 = 1
      try { const j = await 回.json(); 等 = Number(j.retry_after || (j.d && j.d.retry_after)) || 1 } catch { 等 = 1 }
      日志(`被官方限速 429，等 ${等} 秒再试一次`)
      await new Promise((r) => setTimeout(r, Math.min(10, 等) * 1000))
      回 = await 一()
    }
    return 回
  }

  // ── 出站 ────────────────────────────────────────────────────────────────

  function 记窗(chatId, msgId) {
    const 今 = Date.now()
    for (const [键, 值] of 窗.entries()) if (今 >= 值.到) 窗.delete(键)
    if (msgId) 窗.set(chatId, { msgId, 到: 今 + 被动分钟 * 60000, 已用: 0 })
  }

  async function 传图(是群, 号码, 源) {
    const 基 = (源 && 源.url) || ''
    const 体 = { file_type: 1, srv_send_msg: false }
    if (基) 体.url = 基
    else if (源 && (源.数据 || 源.data)) {
      // DSH 发出来的图常常是 base64（没有本地文件），官方 API 直接收 file_data
      const b64 = String(源.数据 || 源.data).replace(/^data:[^,]*,/, '')
      if (b64.length * 0.75 > 图上限) return { ok: false, 说: '图超过 5MB，官方 /files 直传不支持' }
      体.file_data = b64
    } else {
      const 路 = (源 && (源.file || 源.path)) || ''
      let 字节 = null
      try { 字节 = await (await import('node:fs/promises')).readFile(路) } catch (错) { return { ok: false, 说: '图读不到：' + String(错 && 错.message || 错) } }
      if (字节.length > 图上限) return { ok: false, 说: '图超过 5MB，官方 /files 直传不支持（' + Math.round(字节.length / 1048576 * 10) / 10 + 'MB）' }
      体.file_data = 字节.toString('base64')
    }
    const 路径 = (是群 ? '/v2/groups/' : '/v2/users/') + 号码 + '/files'
    try {
      const 回 = await 带token('POST', 路径, 体)
      const 文 = await 回.text()
      if (!回.ok) return { ok: false, 说: `传图失败 HTTP ${回.status}：${文.slice(0, 160)}` }
      let 数据 = null
      try { 数据 = JSON.parse(文) } catch { 数据 = null }
      const fi = 字(数据 && 数据.file_info)
      if (!fi) return { ok: false, 说: '传图没拿到 file_info：' + 文.slice(0, 160) }
      return { ok: true, file_info: fi }
    } catch (错) {
      return { ok: false, 说: '传图抛错：' + String(错 && 错.message || 错) }
    }
  }

  async function 发一段(是群, 号码, 体, 窗信息) {
    const 路径 = (是群 ? '/v2/groups/' : '/v2/users/') + 号码 + '/messages'
    const 全 = { ...体 }
    if (窗信息 && 窗信息.msgId) {
      窗信息.已用 += 1
      if (窗信息.已用 > 被动条数) return { ok: false, 说: `一个消息 id 最多回 ${被动条数} 条，这条超了` }
      全.msg_id = 窗信息.msgId
      全.msg_seq = 窗信息.已用
    }
    try {
      const 回 = await 带token('POST', 路径, 全)
      const 文 = await 回.text()
      if (!回.ok) {
        // 窗外发主动消息被拒、权限不足、频率限制 —— 原话带回去，别装死
        if (窗信息 && 窗信息.msgId) 窗信息.已用 -= 1   // 失败不占额度
        return { ok: false, 说: `HTTP ${回.status}：${文.slice(0, 200)}` }
      }
      return { ok: true, 说: '' }
    } catch (错) {
      if (窗信息 && 窗信息.msgId) 窗信息.已用 -= 1
      return { ok: false, 说: '发送抛错：' + String(错 && 错.message || 错) }
    }
  }

  /**
   * 发一条（文字 + 若干图），形状跟 host.js 的 发一个 对齐。
   * @returns {Promise<Array<{action:string, ok:boolean, 数据:object}>>}
   */
  async function 发(行, 文字, 图们 = []) {
    const 是群 = 字(行 && 行.类型) === '群'
    const 号码 = 字(行 && 行.号码)
    const 名 = 是群 ? 'send_group_msg' : 'send_private_msg'
    const 出 = []
    if (!号码) return [{ action: 名, ok: false, 数据: { 说: '这一行没有 openid（官方线的号码要填 openid）' } }]

    const 窗信息 = 窗.get(号码) || null
    if (!窗信息) 日志(`「${号码}」没有被动窗口了（上次消息超过 ${被动分钟} 分钟），按主动消息试一把`)

    const 正文块 = 切块(文字, 文字每块)
    // 被动窗里最多 5 条：文字块比剩余额度多时，把多的并到最后一块
    let 块们 = 正文块
    if (窗信息) {
      const 剩 = 被动条数 - 窗信息.已用 - 图们.length
      if (剩 > 0 && 正文块.length > 剩) 块们 = [...正文块.slice(0, 剩 - 1), 正文块.slice(剩 - 1).join('\n')]
    }
    for (const 块 of 块们) {
      const r = await 发一段(是群, 号码, { msg_type: 0, content: 块 }, 窗信息)
      出.push({ action: 名, ok: r.ok, 数据: r.ok ? {} : { 说: r.说 } })
      if (!r.ok) break
    }
    for (const 图 of 图们) {
      const 源 = typeof 图 === 'string' ? (/^https?:\/\//i.test(图) ? { url: 图 } : { file: 图 }) : (图 || {})
      const 传 = await 传图(是群, 号码, 源)
      if (!传.ok) { 出.push({ action: 'upload_media', ok: false, 数据: { 说: 传.说 } }); continue }
      const r = await 发一段(是群, 号码, { msg_type: 7, media: { file_info: 传.file_info } }, 窗信息)
      出.push({ action: 名, ok: r.ok, 数据: r.ok ? {} : { 说: r.说 } })
    }
    if (出.length === 0) 出.push({ action: 名, ok: true, 数据: {} })
    return 出
  }

  // ── 入站 ────────────────────────────────────────────────────────────────

  async function 处理事件(名, d) {
    // ⭐ 2026-10-30：任何 dispatch 都在环里留一行 —— 群消息不来时，靠它分辨
    //    「平台没推」「名字不叫 GROUP_AT_MESSAGE_CREATE」「推了但我没认」三种情况。
    const 是群 = 名 === 'GROUP_AT_MESSAGE_CREATE' || 名 === 'GROUP_MESSAGE_CREATE'
    const 单聊 = 名 === 'C2C_MESSAGE_CREATE'
    if (!是群 && !单聊) { 日志('收到不关心的事件：' + 名); return }
    const 事件id = 字(d && d.id)
    if (事件id && 收过.has(事件id)) return
    if (事件id) {
      收过.add(事件id)
      if (收过.size > 500) { for (const x of [...收过].slice(0, 收过.size - 500)) 收过.delete(x) }
    }
    const 作者 = (d && d.author) || {}
    const 号码 = 是群 ? 字(d.group_openid) : 字(作者.user_openid)
    const 说话人 = 是群 ? 字(作者.member_openid) : 字(作者.user_openid)
    const 昵称 = 字(作者.username) || 说话人
    记窗(号码, 事件id)   // 被动回复窗：就着这一条回
    const 段们 = 官方事件转段(d && d.content, d && d.attachments)
    const 条 = {
      time: Math.floor(Date.now() / 1000),
      message_id: 事件id,
      user_id: 说话人,          // openid 字符串（不是 QQ 号）
      sender: { card: 昵称, nickname: 昵称 },
      message: 段们,
      官方: true,
      官方群: 是群 ? 号码 : '',
      群里被点名: 名 === 'GROUP_AT_MESSAGE_CREATE',   // ⭐ 只有 @ 事件算被点名；GROUP_MESSAGE_CREATE 是全量群消息
    }
    const 配置 = 读配置() || {}
    const 绑定们 = Array.isArray(配置.绑定) ? 配置.绑定 : []
    // 命中哪一行：类型 + 号码（官方线的「号码」就是 openid）
    const 行们 = 绑定们.filter((行) => 字(行.类型) === (是群 ? '群' : '私聊') && 字(行.号码) === 号码)
    if (!行们.length) {
      日志(`收到 ${是群 ? '群' : '私聊'}（${号码}）的消息，但没有任何绑定行认这个 openid —— 先在绑定里加一行（号码填 ${号码}）`)
      return
    }
    for (const 行 of 行们) {
      try { await 收一条(条, 行) } catch (错) { 日志('交给下游时抛错：' + String(错 && 错.message || 错)) }
    }
  }

  async function 处理帧(帧) {
    if (!帧 || typeof 帧 !== 'object') return
    if (帧.s !== undefined && 帧.s !== null) 序列 = 帧.s
    if (帧.op === 10) {
      const 间隔 = Number(帧.d && 帧.d.heartbeat_interval) || 30000
      if (心跳) clearInterval(心跳)
      心跳 = setInterval(() => {
        try { if (网 && 网.readyState === 1) 网.send(JSON.stringify({ op: 1, d: 序列 })) } catch { /* 断了自己会重连 */ }
      }, 间隔)
      try {
        const t = await 取token()
        const intents = 图们().intents
        if (网 && 网.readyState === 1) 网.send(JSON.stringify({ op: 2, d: { token: 'QQBot ' + t, intents, shard: [0, 1], properties: {} } }))
        换态('connected', '已连上网关')
        重连毫秒 = 1000
        // ⭐ 2026-10-30：发完 IDENTIFY 若 20 秒还不见 READY，就当这次连接白建，断开重来。
        //    不然会停在「WS 连着、其实没认上身」的假活状态里（实测踩过：4009 之后一直是它）。
        认过身 = false
        if (认身计时) clearTimeout(认身计时)
        认身计时 = setTimeout(() => {
          认身计时 = null
          if (认过身 || 停着) return
          日志('IDENTIFY 发出后 20 秒没等到 READY，断开重连')
          try { if (网) 网.close() } catch { /* 而已 */ }
        }, 20000)
      } catch (错) {
        换态('error', String(错 && 错.message || 错))
        日志('发 IDENTIFY 失败：' + String(错 && 错.message || 错) + '（断开重连）')
        try { if (网) 网.close() } catch { /* 而已 */ }
      }
      return
    }
    if (帧.op === 11) return
    if (帧.op === 7 || 帧.op === 9) {
      日志(`网关让重连（op ${帧.op}）`)
      try { if (网) 网.close() } catch { /* 而已 */ }
      return
    }
    if (帧.op === 0) {
      if (帧.t === 'READY') {
        认过身 = true
        if (认身计时) { clearTimeout(认身计时); 认身计时 = null }
        const 自 = 帧.d && (帧.d.user && 帧.d.user.id)
        if (自) 日志('网关 READY（self=' + 自 + '）')
      }
      await 处理事件(帧.t, 帧.d || {})
    }
  }

  async function 连() {
    if (停着) return
    const { appid, 密钥, 网关 } = 图们()
    if (!appid || !密钥) { 换态('error', '没配 AppID / 密钥'); return }
    换态('starting', '连接中…')
    let 址 = 网关
    try {
      if (!址) {
        const 回 = await 带token('GET', '/gateway', undefined)
        const 文 = await 回.text()
        let 数据 = null
        try { 数据 = JSON.parse(文) } catch { 数据 = null }
        址 = 字(数据 && 数据.url) || 默认网关
      }
    } catch (错) {
      日志('取网关地址失败，用默认地址兜：' + String(错 && 错.message || 错))
      址 = 默认网关
    }
    try {
      网 = new WebSocket(址)
    } catch (错) {
      换态('error', '建 WS 抛错：' + String(错 && 错.message || 错))
      排重连()
      return
    }
    网.addEventListener('open', () => { 日志('WS 物理连接建立（' + 址 + '）') })
    网.addEventListener('message', (ev) => {
      let 帧 = null
      try { 帧 = JSON.parse(ev.data) } catch { return }
      处理帧(帧).catch((错) => 日志('处理帧抛错：' + String(错 && 错.message || 错)))
    })
    网.addEventListener('close', (ev) => {
      if (心跳) { clearInterval(心跳); 心跳 = null }
      if (认身计时) { clearTimeout(认身计时); 认身计时 = null }
      网 = null
      if (!停着) { 换态('reconnecting', '连接断了（code ' + 字(ev && ev.code) + '），准备重连'); 排重连() }
    })
    网.addEventListener('error', () => { 日志('WS 报错（详情看不出来，多半是网络或凭证）') })
  }

  function 排重连() {
    if (停着) return
    if (重连计时) clearTimeout(重连计时)
    const 等 = 重连毫秒
    重连毫秒 = Math.min(30000, 重连毫秒 * 2)
    重连计时 = setTimeout(() => { 重连计时 = null; 连().catch((错) => { 换态('error', String(错 && 错.message || 错)); 排重连() }) }, 等)
  }

  return {
    启动() {
      停着 = false
      连().catch((错) => { 换态('error', String(错 && 错.message || 错)); 排重连() })
    },
    停() {
      停着 = true
      if (重连计时) { clearTimeout(重连计时); 重连计时 = null }
      if (心跳) { clearInterval(心跳); 心跳 = null }
      try { if (网) 网.close() } catch { /* 而已 */ }
      网 = null
      换态('disabled', '停了')
    },
    状态() { return { 态, 说: 态说, 窗: 窗.size } },
    发,
    窗,
  }
}
