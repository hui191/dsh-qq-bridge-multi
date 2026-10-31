// DSH「通到 QQ」· 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「通到 QQ」。0.6.0 起分四个页签：
//   总览 / 绑定 / 发消息 / 提示与门槛
// 绑定是核心：一行 = 一个聊天（私聊 或 群）→ 一间 DSH 会话，各回各的，不串。
//
// ⚠ 这里不碰会话、不发消息，只是往宿主那几条 /dsh-qq-bridge/* 路由上读写。

window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const inject = ['slots']

    const B = '/dsh-qq-bridge'
    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json()).catch(() => null)
    const post = (p, body) =>
      fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch(() => null)

    const h = React.createElement

    const S = {
      wrap: {
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.92))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h: { fontSize: 14, fontWeight: 600, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 190, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 220 },
      hint: { opacity: 0.6, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 140,
        boxSizing: 'border-box',
      },
      wide: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      已同步: { margin: '6px 0 10px', fontSize: 12, color: 'var(--dsw-alias-state-business-primary)' },
      未保存: { margin: '6px 0 10px', fontSize: 12, color: '#c0392b', fontWeight: 600 },
      悬浮保存条: {
        position: 'sticky',
        bottom: 0,
        marginTop: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.95))',
        boxShadow: '0 -6px 18px rgba(0,0,0,.18)',
        zIndex: 5,
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      tabBar: { display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 12px' },
      日志行: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap' },
      表头: { display: 'grid', gridTemplateColumns: '70px 120px 1fr 120px 56px 40px', gap: 6, alignItems: 'center', marginBottom: 4 },
      表格行: { display: 'grid', gridTemplateColumns: '70px 120px 1fr 120px 56px 40px', gap: 6, alignItems: 'center', marginBottom: 6 },
      表头字: { fontSize: 11.5, opacity: 0.65 },
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)
    const 行 = (标签, 控件, 说明) =>
      h('div', { style: S.row }, h('div', { style: S.lab }, 标签), h('div', { style: S.ctl }, 控件, 说明 ? 提示(说明) : null))
    const 按钮 = (文字, onClick, 亮, 关) =>
      h('button', { type: 'button', style: 亮 ? S.btnOn : S.btn, onClick, disabled: !!关, title: 文字 }, 文字)
    const 勾 = (值, onChange) => h('input', { type: 'checkbox', checked: !!值, onChange: (e) => onChange(e.target.checked) })
    const 短id = (id) => {
      const s = String(id)
      return s.length <= 8 ? s : s.slice(-8)
    }

    const 页签们 = ['总览', '绑定', '发消息', '提示与门槛']

    function Section() {
      const [态, 设态] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')
      const [更新, 设更新] = React.useState(null)
      const [更新忙, 设更新忙] = React.useState(false)
      const [页, 设页] = React.useState('总览')
      const [asr, 设asr] = React.useState(null)
      const [asr忙, 设asr忙] = React.useState(false)

      React.useEffect(() => {
        拉()
        get('/update').then((r) => r && 设更新(r)).catch(() => {})
        get('/asr-status').then((r) => r && 设asr(r)).catch(() => {})
      }, [])
      // 装依赖的时候每 2 秒看一眼进度（装完就停）
      React.useEffect(() => {
        if (!asr || !asr.进行中) return undefined
        const t = setInterval(() => {
          get('/asr-status').then((r) => { if (r) 设asr(r) }).catch(() => {})
        }, 2000)
        return () => clearInterval(t)
      }, [asr && asr.进行中])

      const 拉 = async () => {
        const s = await get('/state')
        if (s) 设态(s)
      }
      const 改 = (k, v) => {
        设态((旧) => (旧 ? { ...旧, 配置: { ...(旧.配置 || {}), [k]: v } } : 旧))
        设脏(true)
      }
      // —— 绑定：整份数组替换（宿主那边会再规整一遍、并挡掉重复）——
      const 绑定们 = () => {
        const a = 态 && 态.配置 && 态.配置.绑定
        return Array.isArray(a) ? a : []
      }
      const 设绑定 = (下一份) => 改('绑定', 下一份)
      const 改绑定 = (i, 补) => 设绑定(绑定们().map((x, j) => (j === i ? { ...x, ...补 } : x)))
      // ⭐ 本机改动：新加的这条也把新的行字段带上（跟宿主那边的默认值对齐）
      const 加绑定 = () => 设绑定([...绑定们(), {
        类型: '群', 号码: '', 会话: '', 称呼: '', 名字: '', 门槛: false,
        收档: '全收', 半收分钟: 5, 自动发: true, 预设: 'whale', 会话目录: '', 只认: '',
      }])
      const 删绑定 = (i) => 设绑定(绑定们().filter((_, j) => j !== i))

      const 存 = async () => {
        设忙(true)
        const s = await post('/save', (态 && 态.配置) || {})
        设忙(false)
        if (s && s.ok) {
          设态(s)
          设脏(false)
          设说(s.说 || '保存好了')
        } else {
          设说((s && s.说) || '保存失败')
        }
      }
      const 查更新 = async () => {
        设更新忙(true)
        const r = await get('/update?refresh=1')
        if (r) 设更新(r)
        设更新忙(false)
        设说(!r ? '查不到（网络）' : r.hasUpdate ? '有新版本 v' + r.latest : r.ok ? '已经是最新版' : '查不到：' + (r.error || '网络'))
      }
      const 装语音 = async () => {
        设asr忙(true)
        const r = await post('/asr-install', {})
        设说((r && r.说) || '开始了')
        设asr忙(false)
        const s2 = await get('/asr-status')
        if (s2) 设asr(s2)
      }
      const 填语音命令 = async () => {
        const r = await get('/asr-status')
        if (r) 设asr(r)
        if (r && r.就绪 && r.命令) {
          改('语音转写', true)
          改('转写命令', r.命令)
          设说(String(配置.语音模型目录 || '').trim()
            ? '命令已填好（记得点保存）'
            : '命令填好了，但**还没填「语音模型目录」** —— 转写会报「没给模型目录」，填完再点一次这个按钮')
        } else if (r && !r.就绪) 设说('还没装好，先点「自动装依赖」')
        else 设说('读不到状态')
      }

      const 试一句 = async () => {
        设忙(true)
        const s = await post('/test-send', {})
        设忙(false)
        设说((s && s.说) || '没反应')
        await 拉()
      }

      if (!态) return h('div', { style: S.wrap }, h('div', { style: S.h }, '通到 QQ'), h('div', { style: S.dim }, '读取中…'))

      const 配置 = 态.配置 || {}
      const 目标们 = Array.isArray(态.活着的会话) ? 态.活着的会话 : []
      const NapCat = 态.NapCat状态 || null
      const 日志 = Array.isArray(态.日志) ? 态.日志 : []
      const 绑定 = 绑定们()

      // ⭐ 2026-10-27（主人问「为什么只能选现成的会话」）：这里只列**活着的会话** —— 而「新开一间」
      //    不是会话、是一条指令，所以原来在下拉里根本选不着，只能手打。给它一个显式选项：
      //    选「＋ 开一间新的」= 把值写成 `新`，桥会在下一跳（4 秒内）把空屋子开出来，开好写回真会话号。
      const 会话选项 = (值, onChange) =>
        h('select', { style: S.wide, value: 值 || '', onChange: (e) => onChange(e.target.value) },
          h('option', { value: '' }, '（选一间会话）'),
          h('option', { value: '新' }, '＋ 开一间新的（填 `新`，桥自动建空屋子）'),
          ...目标们.map((s) => h('option', { value: s.id }, (s.标题 || '…' + 短id(s.id)) + ' · ' + 短id(s.id))),
          值 && 值 !== '新' && !目标们.some((s) => s.id === 值)
            ? h('option', { value: 值 }, '（当前：' + 短id(值) + '）')
            : null)

      const 页签 = h('div', { style: S.tabBar },
        ...页签们.map((名) => 按钮(名, () => 设页(名), 页 === 名, false)))

      // ⭐ 本机改动：收档下拉（全收 = 都投 / 半收 = 叫它或它刚说过话 / 点名 = 只有叫它才投）
      const 收档选项 = (值, onChange) => h('select', { style: S.small, value: 值 || '全收', onChange: (e) => onChange(e.target.value) },
        h('option', { value: '全收' }, '全收'),
        h('option', { value: '半收' }, '半收'),
        h('option', { value: '点名' }, '点名'))

      // ───────────── 总览 ─────────────
      const 总览页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '开关'),
          行('总开关', 勾(配置.总开关, (v) => 改('总开关', v)), '关着 = 一句都不发（安全默认）。'),
          行('试运行', 勾(配置.试运行, (v) => 改('试运行', v)), '开着只记账、不真发到 QQ。想先看记录就开着它。'),
          行('手机只收「人话」（不发代码/路径）', 勾(配置.只发标记内, (v) => 改('只发标记内', v)), '开着时：只有它写在 [QQ] 这里 [/QQ] 中间的话会发到手机；代码、文件路径、分析过程都留在电脑上，不往手机上推。开之前先让它知道这个写法 —— 开着时转进去的消息会自动提醒它。'),
          行('只回 QQ 叫醒的那一轮', 勾(配置.只回QQ唤醒, (v) => 改('只回QQ唤醒', v)), '开着时：你在 QQ 问一句它回一句；你坐在 DSH 界面里自己聊的，不推到手机。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '现在的绑定（' + 绑定.length + ' 条）'),
          绑定.length === 0
            ? h('div', { style: S.dim }, '还没有绑定。去「绑定」页签加一条：一个私聊 / 一个群 → 一间会话。')
            : h('div', null,
              ...绑定.map((x, i) => h('div', { key: i, style: { marginBottom: 4 } },
                (x.类型 === '群' ? '群 ' : '私聊 ') + String(x.号码 || '?')
                + ' → ' + (x.会话 ? 短id(x.会话) : '（没选会话）')
                + (x.称呼 ? '　称呼：' + x.称呼 : '')
                + (String(x.名字 || '').trim() ? '　名字：' + x.名字 : '')
                + (x.类型 === '群' && x.门槛 ? '　门槛：开' : '')
                // ⭐ 本机改动：只在非默认值时才显示（别把这一行撑太长）
                + (x.类型 === '群' && (x.收档 === '半收' || x.收档 === '点名') ? '　收档：' + x.收档 : '')
                + (x.自动发 === false ? '　自动发：关' : '')
                + (String(x.只认 || '').trim() ? '　只认：' + x.只认 : '')))),
          h('div', { style: { marginTop: 6 } }, 按钮('去绑定', () => 设页('绑定'))),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '自己动手'),
          h('div', null,
            按钮('保存设置', 存, true, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('测试一句', 试一句, false, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('刷新', 拉, false, 忙)),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '「测试一句」会真的发一句去 QQ（绕过试运行），用来确认整条路通没通。'),
          说 ? h('div', { style: { ...S.ok, marginTop: 6 } }, 说) : null,
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '最近 ' + 日志.length + ' 条记录（新的在最下面）'),
          h('div', { style: { marginTop: 6, maxHeight: 220, overflowY: 'auto' } },
            日志.length === 0
              ? h('div', { style: S.dim }, '还没有记录。')
              : 日志.map((条, i) => h('div', { key: i, style: S.日志行 }, 条.时间 + '　' + 条.文本))),
        ),
      )

      // ───────────── 绑定 ─────────────
      const 绑定页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '绑定（一行 = 一个聊天 → 一间会话）'),
          h('div', { style: S.dim },
            'QQ 私聊就填你自己的号；群就填群号。哪一行说的话，就只回那一行的聊天 —— 多群也不会串。'
            + '同一间会话只能绑一条（想绑第二个群，得给它单独一间会话）。'),
          h('div', { style: { ...S.表头, marginTop: 10 } },
            h('div', { style: S.表头字 }, '类型'),
            h('div', { style: S.表头字 }, '号码'),
            h('div', { style: S.表头字 }, '对应会话'),
            h('div', { style: S.表头字 }, '称呼'),
            h('div', { style: S.表头字 }, '门槛'),
            h('div', { style: S.表头字 }, '')),
          绑定.length === 0
            ? h('div', { style: { ...S.dim, margin: '8px 0' } }, '还没有 —— 点下面的「+ 加一条」')
            : h('div', null, ...绑定.map((x, i) => h('div', { key: i, style: { marginBottom: 12 } },
              h('div', { style: S.表格行 },
                h('select', { style: S.wide, value: x.类型 || '群', onChange: (e) => 改绑定(i, { 类型: e.target.value }) },
                  h('option', { value: '私聊' }, '私聊'),
                  h('option', { value: '群' }, '群')),
                h('input', {
                  style: S.wide, value: String(x.号码 || ''), placeholder: x.类型 === '私聊' ? 'QQ 号' : '群号',
                  onChange: (e) => 改绑定(i, { 号码: e.target.value.trim() }),
                }),
                会话选项(x.会话, (v) => 改绑定(i, { 会话: v })),
                h('input', {
                  style: S.wide, value: String(x.称呼 || ''),
                  placeholder: x.类型 === '私聊' ? '对方' : '群里的人',
                  onChange: (e) => 改绑定(i, { 称呼: e.target.value }),
                }),
                h('div', { style: { textAlign: 'center' } },
                  勾(x.门槛, (v) => 改绑定(i, { 门槛: v }))),
                h('div', null, 按钮('删', () => 删绑定(i), false, false))),
              // ⭐ 本机改动：这一行的投递口径（群才有收档/半收分钟/只认；自动发/预设/会话目录两种都有）
              h('div', { style: { paddingLeft: 6 } },
                x.类型 === '群'
                  ? h('div', null,
                    行('收档', 收档选项(x.收档, (v) => 改绑定(i, { 收档: v })), '群用。全收 = 都投进会话；半收 = 叫你 / 点你名字，或者它刚在群里说过话那几分钟内；点名 = 只有叫你才投。'),
                    行('半收分钟', h('input', { type: 'number', min: 1, max: 240, style: S.small, value: String(x.半收分钟 ?? 5), onChange: (e) => 改绑定(i, { 半收分钟: Number(e.target.value) }) }), '只在「半收」时有用：它刚说过话，这几分钟内群里的话还继续投。默认 5。'),
                    行('只认', h('input', { style: S.small, value: String(x.只认 || ''), placeholder: '留空 = 只认主人号', onChange: (e) => 改绑定(i, { 只认: e.target.value.trim() }) }), '留空 = 只认主人那个号（老行为）；填 0 = 群里谁的话都投；填具体 QQ 号 = 只认那个号。'),
                    行('名字', h('input', { style: S.small, value: String(x.名字 || ''), placeholder: '（留空 = 用群号）', onChange: (e) => 改绑定(i, { 名字: e.target.value }) }), '消息头里这个群叫什么（官方线的群号是 32 位 openid，认不出来）。留空 = 显示群号。'))
                  : null,
                行('自动发', 勾(x.自动发 !== false, (v) => 改绑定(i, { 自动发: v })), '关掉 = 这一行它不自动发，只在它主动调 qq_say 时说话。'),
                行('预设', h('input', { style: S.small, value: String(x.预设 || ''), placeholder: 'whale', onChange: (e) => 改绑定(i, { 预设: e.target.value }) }), '这一行新建会话时用的预设。留空 = whale。'),
                行('会话目录', h('input', { style: S.wide, value: String(x.会话目录 || ''), placeholder: '（留空 = /root/默认工作区/QQ消息）', onChange: (e) => 改绑定(i, { 会话目录: e.target.value }) }), '新建会话用的工作目录；这一行的会话没活着时，靠它开一间。会话那格选「＋ 开一间新的」（值 = `新`）就会先建一间空屋子等你用。'))))),
          h('div', { style: { marginTop: 8 } },
            按钮('+ 加一条', 加绑定, false, false),
            h('span', { style: S.dim }, '　'),
            按钮('刷新会话清单', 拉, false, 忙)),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '「门槛」只有群有用：开了之后，那个群里的消息会先让它判断「是不是在跟我说话」，不是就停掉这一轮。'
            + '私聊永远不判（你自己私聊，本来就是在跟它说话）。'
            + '「收档」也是群用的，但它是**投递之前**就先筛掉（更省事）：全收 / 半收 / 点名。两个可以一起用。'),
        ),
      )

      // ───────────── 发消息 ─────────────
      const 发消息页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '连到哪个 QQ 后端'),
          行('接口地址', h('input', { style: S.wide, value: String(配置.NapCat || ''), onChange: (e) => 改('NapCat', e.target.value) }), 'NapCat / SnowLuma 的 HTTP 地址，一般是 http://127.0.0.1:3000。'),
          行('接口令牌', h('input', { type: 'password', style: S.small, value: String(配置.令牌 || ''), onChange: (e) => 改('令牌', e.target.value) }), '后端开了 HTTP 鉴权才填（access_token）；留空 = 不鉴权。'),
          // ⭐ 2026-10-30（第二根线）：QQ 官方机器人 —— openid + WS 推送，跟 OneBot 二选一
          行('这条线', h('select', { style: S.small, value: String(配置.协议 || 'onebot11'), onChange: (e) => 改('协议', e.target.value) },
            h('option', { value: 'onebot11' }, 'OneBot / NapCat（轮询）'),
            h('option', { value: 'qq-official' }, 'QQ 官方机器人（WS 推送）')), '选哪根线。改完保存就会重载插件；官方线不吃接口地址与令牌。'),
          行('官方 AppID', h('input', { style: S.small, value: String(配置.官方AppID || ''), onChange: (e) => 改('官方AppID', e.target.value) }), 'QQ 开放平台机器人页上的 AppID。'),
          行('官方密钥', h('input', { type: 'password', style: S.small, value: String(配置.官方密钥 || ''), onChange: (e) => 改('官方密钥', e.target.value) }), 'AppSecret（AppAccessToken 用它换）。'),
          行('官方沙箱', h('select', { style: S.small, value: 配置.官方沙箱 ? '1' : '',
            onChange: (e) => 改('官方沙箱', e.target.value === '1') }, h('option', { value: '' }, '正式'), h('option', { value: '1' }, '沙箱')), '只有开放平台的沙箱环境才切。'),
          行('官方主人 openid', h('input', { style: S.wide, value: String(配置.官方主人openid || ''), onChange: (e) => 改('官方主人openid', e.target.value) }), '官方线只有 openid（不是 QQ 号）：填了才在消息头里标出「主人」。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '发出去的样子'),
          行('长回复拆成几条发', 勾(配置.长回复拆段, (v) => 改('长回复拆段', v)), '开着（默认）：按空行拆成几条、像真人一条条发。关掉：一整段只发一条，不会刷屏。'),
          行('每段之间隔（毫秒）', h('input', { type: 'number', min: 0, max: 5000, style: S.small, value: String(配置.拆段间隔毫秒 ?? 900), onChange: (e) => 改('拆段间隔毫秒', Number(e.target.value)) }), '只在「拆成几条」开着时有用。默认 900。'),
          行('每段随机抖动（毫秒）', h('input', { type: 'number', min: 0, max: 5000, style: S.small, value: String(配置.拆段抖动毫秒 ?? 1200), onChange: (e) => 改('拆段抖动毫秒', Number(e.target.value)) }), '每段再随机加 0~N 毫秒，另外按这段的字数再等一点（像在打字）。默认 1200。'),
          行('限制发送频率', 勾(配置.发送限速, (v) => 改('发送限速', v)), '开着（默认）：同一个聊天两条之间至少隔一会，且每分钟/每小时有硬上限 —— 防刷屏，也防被当成机器号。'),
          行('最小间隔（秒）', h('input', { type: 'number', min: 0, max: 120, style: S.small, value: String(配置.最小间隔秒 ?? 4), onChange: (e) => 改('最小间隔秒', Number(e.target.value)) }), '两条消息之间至少隔这么久。默认 4。'),
          行('随机抖动（秒）', h('input', { type: 'number', min: 0, max: 30, style: S.small, value: String(配置.抖动秒 ?? 2), onChange: (e) => 改('抖动秒', Number(e.target.value)) }), '额外随机 0~N 秒 —— 固定间隔看起来像机器。默认 2。'),
          行('每分钟上限（条）', h('input', { type: 'number', min: 1, max: 300, style: S.small, value: String(配置.每分钟上限 ?? 6), onChange: (e) => 改('每分钟上限', Number(e.target.value)) }), '同一个聊天一分钟最多几条。默认 6。'),
          行('每小时上限（条）', h('input', { type: 'number', min: 1, max: 3000, style: S.small, value: String(配置.每小时上限 ?? 60), onChange: (e) => 改('每小时上限', Number(e.target.value)) }), '同一个聊天一小时最多几条。默认 60。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '风控护栏（只为保号）'),
          h('div', { style: S.dim }, '这些开关只为一件事：别让 QQ 把这条线判成批量接口（秒回、24 小时待命、一下吐一串最要命）。不为了演得像个人 —— 群里说什么、接不接，都由她自己看着办。'),
          行('深夜静默时段', h('input', { style: S.small, placeholder: '23:00-08:00', value: String(配置.静默时段 || ''), onChange: (e) => 改('静默时段', e.target.value) }), '形如 23:00-08:00（跨零点也认，分隔符也可以是 ~ 或 到）。留空 = 不静默。'),
          行('静默里两边都停', 勾(配置.静默两边都停, (v) => 改('静默两边都停', v)), '开着（默认）：静默时段里 QQ 消息不叫醒它、它也不往 QQ 发 —— 整条线一起睡。夜里攒下的消息不补投。'),
          行('接话概率（%）', h('input', { type: 'number', min: 0, max: 100, style: S.small, value: String(配置.接话概率 ?? 100), onChange: (e) => 改('接话概率', Number(e.target.value)) }), '默认 100 = 全收：群里每条都送到她面前，接不接她自己定。收窄（比如 25）才会替她筛掉一部分 —— 号太烫时才用。'),
          行('冷却（分钟）', h('input', { type: 'number', min: 0, max: 240, style: S.small, value: String(配置.冷却分钟 ?? 0), onChange: (e) => 改('冷却分钟', Number(e.target.value)) }), '默认 0 = 关。设成 N 分钟后，同一个聊天 N 分钟内「没被点名」的消息不再递给她（被点名的不受影响）。'),
          行('私聊也限', 勾(配置.私聊也限, (v) => 改('私聊也限', v)), '把上面两条也用到私聊上。默认关 —— 私聊是一对一说话的地方，照常都送。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '图片'),
          行('收图（QQ → 它）', 勾(配置.收图, (v) => 改('收图', v)), '你在 QQ 里发的图也转给它看。模型看得见图就直接看；纯文本模型只知道「有几张图、存在哪」。'),
          行('发图（它 → QQ）', 勾(配置.发图, (v) => 改('发图', v)), '它这一轮里发的图也发到 QQ。'),
          行('一条最多收几张', h('input', { type: 'number', min: 1, max: 10, style: S.small, value: String(配置.收图最多 ?? 4), onChange: (e) => 改('收图最多', Number(e.target.value)) }), '多出来的不转。一条最多 10 张。'),
          行('单张最大（MB）', h('input', { type: 'number', min: 1, max: 30, style: S.small, value: String(配置.图上限MB ?? 5), onChange: (e) => 改('图上限MB', Number(e.target.value)) }), '超过就跳过（两个方向都按这个）。'),
          行('图片根目录', h('input', { style: S.wide, placeholder: '（留空就行：自动用会话所在的工作区）', value: String(配置.图片根目录 || ''), onChange: (e) => 改('图片根目录', e.target.value) }), '一般不用填。它正文里写 ![名字](相对路径) 时先按这个目录找。'),
          h('div', { style: S.dim }, '收进来的图会存一份到 %USERPROFILE%\\.dsh\\qq-bridge-inbox\\，文字里会带上路径。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '语音转写（QQ 语音条 → 文字）'),
          行('转写语音', 勾(配置.语音转写, (v) => 改('语音转写', v)), '开着时，QQ 里的语音条会交给下面那条命令转成文字再转给它；关着就只记一个 [语音]。'),
          // —— 一键装依赖 ——
          h('div', { style: { ...S.row, alignItems: 'center' } },
            h('div', { style: S.lab }, '语音识别环境'),
            h('div', { style: S.ctl },
              h('div', null,
                按钮(asr忙 ? '…' : (asr && asr.就绪 ? '重装 / 修一下' : '自动装依赖'), 装语音, !(asr && asr.就绪), asr忙 || Boolean(asr && asr.进行中)),
                h('span', { style: S.dim }, '　'),
                按钮('把命令填好', 填语音命令, false, false)),
              h('div', { style: S.hint },
                asr && asr.就绪 && asr.模型就绪
                  ? '环境 + 语音模型都就绪：' + String(asr.python || '')
                  : asr && asr.就绪
                    ? '环境装好了，但语音模型还没下来 —— 再点一次「自动装依赖」会接着下'
                  : '还没装。点「自动装依赖」会建一个独立环境、装 sherpa-onnx + numpy（几十 MB，第一次要几分钟）。'),
              // 进度
              asr && asr.步骤 && asr.步骤.length
                ? h('div', { style: { marginTop: 8 } },
                  ...asr.步骤.map((x, i) => h('div', { key: i, style: { fontSize: 12 } },
                    (x.态 === '完成' ? '✓ ' : x.态 === '失败' ? '✗ ' : '⋯ ') + x.名 + (x.附 ? '（' + x.附 + '）' : ''))))
                : null,
              // —— 下载进度条（模型 230MB，得让人看见下了多少）——
              asr && asr.下载
                ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: { height: 8, borderRadius: 6, background: 'rgba(128,128,128,.25)', overflow: 'hidden' } },
                    h('div', {
                      style: {
                        height: '100%', width: String(asr.下载.百分比 || 0) + '%',
                        background: 'var(--dsw-alias-state-business-primary)', transition: 'width .4s',
                      },
                    })),
                  h('div', { style: { ...S.dim, marginTop: 4 } },
                    (asr.下载.文件 ? '正在下 ' + asr.下载.文件 + '：' : '')
                    + '已下 ' + Math.round((asr.下载.已收 || 0) / 1048576) + 'MB'
                    + (asr.下载.总 ? ' / ' + Math.round(asr.下载.总 / 1048576) + 'MB' : '')
                    + '（' + String(asr.下载.百分比 || 0) + '%）'
                    + (asr.下载.速度KB ? '　约 ' + (asr.下载.速度KB > 1024 ? (asr.下载.速度KB / 1024).toFixed(1) + 'MB/s' : asr.下载.速度KB + 'KB/s') : '')))
                : null,
              asr && asr.进行中 ? h('div', { style: { ...S.dim, marginTop: 4 } }, '正在装…已 ' + String(asr.用时秒 || 0) + ' 秒（每 2 秒刷新一次）') : null,
              asr && asr.失败 ? h('div', { style: { color: '#c0392b', fontSize: 12, marginTop: 4 } }, '✗ ' + asr.失败) : null,
              asr && asr.日志
                ? h('div', { style: { marginTop: 8 } },
                  h('div', { style: S.dim }, '安装日志（最后几行）'),
                  h('div', { style: { ...S.日志行, maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap', marginTop: 4 } }, String(asr.日志)))
                : null)),
          行('转写命令', h('input', {
            style: S.wide,
            placeholder: 'python D:\\asr_cli.py "{file}"',
            value: String(配置.转写命令 || ''),
            onChange: (e) => 改('转写命令', e.target.value),
          }), '模板里必须有 {file}（会换成音频路径，一般是 wav）。命令往 stdout 打一行文字就算成功；非 0 退出码当失败。'),
          行('语音模型目录', h('input', {
            style: S.wide,
            placeholder: '（装依赖时会自动填好，不用手填）',
            value: String(配置.语音模型目录 || ''),
            onChange: (e) => 改('语音模型目录', e.target.value),
          }), '一般不用管：点「自动装依赖」会把语音模型一起下下来、路径自动写好。只有你想换成自己已有的模型（比如 whisper）时才需要改。'),
          行('超时（秒）', h('input', { type: 'number', min: 5, max: 600, style: S.small, value: String(配置.转写超时秒 ?? 60), onChange: (e) => 改('转写超时秒', Number(e.target.value)) }), '超过就杀掉命令、按失败处理（默认 60 秒）。'),
          h('div', { style: S.dim },
            '插件自己不带语音模型（不然包会变成几百 MB）。仓库里给了一个现成接法：tools/asr_cli.py（本机 SenseVoice）；你有 whisper 或云端接口的话，写一条「读 {file}、打一行字」的命令接上就行。'),
        ),
      )

      // ───────────── 提示与门槛 ─────────────
      const 门槛页 = h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '回复门槛'),
          h('div', { style: S.dim },
            '没有「总开关」——直接去「绑定」页签，给想开的那一行打勾就行；一个群开、别的群照常。'
            + '私聊永远不判（你自己私聊本来就是在跟它说话）。'),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '开了之后：那个群的 QQ 消息照样转进来，但会先让它自己判断「这条是不是在跟我说话」——不是就当场把这一轮停掉，什么都不回。'),
          行('判定不接时：真把这一轮停掉', 勾(配置.门槛真停轮, (v) => 改('门槛真停轮', v)), '关（默认）：只把这轮的话拦住、不发到 QQ，界面上什么异常都没有。开：真的停掉这一轮（省 token），但界面上会显示一次 `Error: tool call aborted` —— 那是「停轮」的表现，不是故障。'),
          h('div', { style: { ...S.dim, marginTop: 6 } },
            '⚠ 给某个群打开门槛那一刻，那一间会话的下一次请求会全量重算一遍（因为它多了一个工具）；关着的时候没有影响。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '转发进来会变成什么样'),
          h('div', { style: S.dim }, '分享卡片 → 标题 + 简介 + 链接（B站 视频会额外标 BV 号）；合并转发的聊天记录 → 「谁：说了什么」几行，里面还套一层转发也会展开（最多 2 层）；转发里的图跟着「收图」开关走。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '检查更新'),
          h('div', { style: S.dim },
            !更新 ? '正在看有没有新版…'
              : 更新.hasUpdate ? '仓库里已经有 v' + 更新.latest + ' 了'
                : 更新.ok ? '已经是最新版' : '暂时查不到（' + (更新.error || '网络') + '）—— 这不代表没有问题'),
          h('div', { style: { marginTop: 6 } }, 按钮(更新忙 ? '查…' : '检查更新', 查更新, false, 更新忙)),
          更新 && 更新.hasUpdate
            ? h('div', { style: { marginTop: 8 } },
              h('div', { style: S.dim }, '更新方法：先卸旧版再装新版（直接装可能拿到缓存里的旧副本）。'),
              h('div', { style: S.日志行 }, ['dsh plugin --profile web remove dsh-qq-bridge', 'dsh plugin --profile web add dsh-qq-bridge'].join(String.fromCharCode(10))),
              按钮('复制命令', () => navigator.clipboard.writeText(['dsh plugin --profile web remove dsh-qq-bridge', 'dsh plugin --profile web add dsh-qq-bridge'].join(String.fromCharCode(10))).then(() => 设说('命令已复制')).catch(() => 设说('复制不了，手动选中吧')), false, false))
            : null,
        ),
      )

      return h(
        'div',
        { style: S.wrap },
        h('div', { style: S.h }, '通到 QQ'),
        h('div', { style: S.dim },
          '它在 DSH 里说完一整轮，就把那句原文发到 QQ；你在 QQ 里说的话也会转进来。'
            + '版本 ' + String(态.版本 || '?') + '｜配置文件：' + String(态.配置文件 || '')),
        NapCat && !NapCat.错
          ? h('div', { style: S.已同步 }, '✓ 连着的 QQ：' + NapCat.昵称 + '（' + NapCat.用户 + '）')
          : h('div', { style: S.未保存 }, '⚠ 连不上 NapCat' + (NapCat && NapCat.错 ? '：' + NapCat.错 : '')),
        页签,
        h('div', { style: 脏 ? S.未保存 : S.已同步 },
          脏 ? '⚠ 有改动还没保存 —— 改完点「保存设置」（底下也会浮一条出来）' : '设置已同步 ✓'),
        页 === '总览' ? 总览页 : null,
        页 === '绑定' ? 绑定页 : null,
        页 === '发消息' ? 发消息页 : null,
        页 === '提示与门槛' ? 门槛页 : null,
        脏
          ? h('div', { style: S.悬浮保存条 },
            h('span', { style: { fontWeight: 600, color: '#c0392b' } }, '⚠ 有改动还没保存'),
            h('span', { style: S.dim }, '改完点这里就行'),
            按钮('保存设置', 存, true, 忙))
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () =>
        slots.register(
          { name: 'settings.section', id: 'qq-bridge', order: 54, label: () => '通到 QQ' },
          Section,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
