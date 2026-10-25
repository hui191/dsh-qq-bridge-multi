// DSH「通到 QQ」· 网页半边
//
// 只干一件事：在 **DSH 设置** 左侧栏加一项「通到 QQ」，
// 摆出：总开关 / 试运行 / 目标会话（下拉选，不手填）/ 私聊QQ / 群号 / 转私聊 / 转群，
// 加「测试一句」「保存设置」和一份最近记录。
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
      日志行: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11.5, whiteSpace: 'pre-wrap' },
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

    function Section() {
      const [态, 设态] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')
      const [更新, 设更新] = React.useState(null)
      const [更新忙, 设更新忙] = React.useState(false)

      React.useEffect(() => {
        拉()
        get('/update').then((r) => r && 设更新(r)).catch(() => {})
      }, [])

      const 拉 = async () => {
        const s = await get('/state')
        if (s) 设态(s)
      }
      const 改 = (k, v) => {
        设态((旧) => (旧 ? { ...旧, 配置: { ...(旧.配置 || {}), [k]: v } } : 旧))
        设脏(true)
      }

      const 动绑 = (f) => {
        设态((旧) => {
          if (!旧) return 旧
          const 配 = 旧.配置 || {}
          const 表 = f(Array.isArray(配.绑定) ? 配.绑定 : [])
          设脏(true)
          return { ...旧, 配置: { ...配, 绑定: 表 } }
        })
      }
      const 改绑 = (i, k, v) => 动绑((表) => 表.map((b, j) => (j === i ? { ...b, [k]: v } : b)))
      const 删绑 = (i) => 动绑((表) => 表.filter((b, j) => j !== i))
      const 加绑 = () => 动绑((表) => [...表, { 名: '新绑定', 类型: 'private', 号: '', 目标会话: '新', 收: true, 发: true, 试运行: false, 只认: '', 潜水: false }])
      const 会话号 = (x) => String((x && (x.id || x.会话 || x.sessionId)) || '')
      const 会话名 = (x) => String((x && x.标题) || '（没名）')
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

      return h(
        'div',
        { style: S.wrap },

        h('div', { style: S.h }, '通到 QQ'),
        h('div', { style: S.dim },
          '它在 DSH 里说完一整轮，就把那句原文发到 QQ（两个方向都做了，你在 QQ 里说的话也会转进来）。' +
            '版本 ' + String(态.版本 || '?') + '｜配置文件：' + String(态.配置文件 || ''),
        ),
        NapCat && !NapCat.错
          ? h('div', { style: S.已同步 }, '✓ 连着的 QQ：' + NapCat.昵称 + '（' + NapCat.用户 + '）')
          : h('div', { style: S.未保存 }, '⚠ 连不上 NapCat' + (NapCat && NapCat.错 ? '：' + NapCat.错 : '')),
        // —— 检查更新 ——
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
              h('div', { style: S.日志行 }, ['dsh plugin --profile web remove dsh-qq-bridge','dsh plugin --profile web add dsh-qq-bridge'].join(String.fromCharCode(10))),
              按钮('复制命令', () => navigator.clipboard.writeText(['dsh plugin --profile web remove dsh-qq-bridge','dsh plugin --profile web add dsh-qq-bridge'].join(String.fromCharCode(10))).then(() => 设说('命令已复制')).catch(() => 设说('复制不了，手动选中吧')), false, false))
            : null,
        ),
        h('div', { style: 脏 ? S.未保存 : S.已同步 },
          脏 ? '⚠ 上面有改动还没保存 —— 改完点「保存设置」（有改动时底下还会浮一条出来）' : '设置已同步 ✓',
        ),

        // —— 开关 ——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '开关'),
          行('总开关', 勾(配置.总开关, (v) => 改('总开关', v)), '关着 = 一句都不发（安全默认）。'),
          行('试运行', 勾(配置.试运行, (v) => 改('试运行', v)), '开着只记账、不真发到 QQ。想先看记录就开着它。'),
        ),

        // —— 目标会话（下拉选，不手填）——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '目标会话（盯哪一间屋）'),
          h('select', {
            style: S.input,
            value: 配置.目标会话 || '',
            onChange: (e) => 改('目标会话', e.target.value),
          },
            h('option', { value: '' }, '（还没选）'),
            ...目标们.map((s) =>
              h('option', { value: s.id }, (s.标题 || '…' + 短id(s.id)) + ' · ' + 短id(s.id)),
            ),
          ),
          h('div', { style: { marginTop: 4 } }, 按钮('刷新清单', 拉, false, 忙)),
          h('div', { style: S.dim }, '选你自己平时和它聊天的那一间；它说完话就发到 QQ。'),
        ),

        // —— 绑定表（一个桥带多个 QQ 会话）——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '绑定表（一个桥带多个 QQ 会话）'),
          h('div', { style: S.dim }, '一行一个 QQ：说清「哪个号 / 哪个群的哪些话」交给「哪一间 DSH 会话」。上面「发到哪」那组是老式单目标设置 —— 绑定表非空时以绑定表为准。目标会话填「新」＝它第一次来消息时自动开一间（开好会自动写回这里，不用你打开那间会话）。'),
          ((配置.绑定 || []).map((b, i) =>
            h('div', { key: 'bind' + i, style: { borderTop: '1px solid var(--dsw-alias-border-l2)', marginTop: 8, paddingTop: 8 } },
              行('名字', h('input', { type: 'text', style: S.small, value: String(b.名 || ''), onChange: (e) => 改绑(i, '名', e.target.value) }), null),
              行('类型', h('select', { style: S.small, value: b.类型 === 'group' ? 'group' : 'private', onChange: (e) => 改绑(i, '类型', e.target.value) },
                h('option', { value: 'private' }, '私聊'), h('option', { value: 'group' }, '群')), null),
              行('号', h('input', { type: 'text', style: S.small, value: String(b.号 || ''), onChange: (e) => 改绑(i, '号', e.target.value) }), '私聊填 QQ 号；群填群号。'),
              行('目标会话', h('input', { type: 'text', style: S.input, value: String(b.目标会话 || ''), placeholder: '填「新」＝自动开一间；也可填 session-xxxx', onChange: (e) => 改绑(i, '目标会话', e.target.value) }),
                目标们.length
                  ? h('select', { style: S.small, value: '', onChange: (e) => { if (e.target.value) 改绑(i, '目标会话', e.target.value) } },
                    h('option', { value: '' }, '选现成的会话…'),
                    ...目标们.map((x, k) => h('option', { key: 'sess' + k, value: 会话号(x) }, 会话名(x) + ' · ' + 短id(会话号(x)))))
                  : null),
              行('收（QQ → 它）', 勾(b.收, (v) => 改绑(i, '收', v)), '这个方向的话转进 DSH。'),
              行('发（它 → QQ）', 勾(b.发, (v) => 改绑(i, '发', v)), 'DSH 说完的话发回 QQ。'),
              行('试运行', 勾(b.试运行, (v) => 改绑(i, '试运行', v)), '只记账不真发。'),
              行('只认', h('input', { type: 'text', style: S.small, value: String(b.只认 || ''), placeholder: '留空＝只认上面那个号', onChange: (e) => 改绑(i, '只认', e.target.value) }), '群里只收这个 QQ 号的话；填 0 ＝谁都收。私聊留空即可。'),
              行('收档（群里）', h('select', { style: S.small, value: String(b.收档 || (b.潜水 === true ? '点名' : '全收')), onChange: (e) => 改绑(i, '收档', e.target.value) },
                h('option', { value: '全收' }, '全收：群里每句都投进去'),
                h('option', { value: '半收' }, '半收：点名 / 它刚说过话那段'),
                h('option', { value: '点名' }, '点名：只收 @它、叫它名字的')), '决定它「看得见多少」：全收＝判断依据最全、也最费（每句都开一整轮）；半收＝折中；点名＝最省。私聊不受这个影响。'),
              行('半收窗口（分钟）', h('input', { type: 'number', min: 1, max: 240, style: S.small, value: String(b.半收分钟 ?? 5), onChange: (e) => 改绑(i, '半收分钟', Number(e.target.value)) }), '只对「半收」有效：它刚在群里说过话之后，这么多分钟内的后续消息也投给它。'),
              行('自动发收尾句', 勾(b.自动发 !== false, (v) => 改绑(i, '自动发', v)), '关掉＝这一轮的收尾不再自动发。想说话就在轮次里调 qq_say —— 群里「说不说」就完全交给它自己。'),
              h('div', { style: { marginTop: 4 } }, 按钮('删掉这行', () => 删绑(i), false, false)),
            ))),
          ((配置.绑定 || []).length === 0
            ? h('div', { style: { ...S.dim, marginTop: 6 } }, '（还没有绑定：点下面「加一行绑定」，或者干脆用上面那组老式单目标设置也行。）')
            : null),
          h('div', { style: { marginTop: 8 } }, 按钮('加一行绑定', 加绑, false, false)),
          h('div', { style: { marginTop: 10 } },
            行('发话工具（qq_say）', 勾(配置.工具, (v) => 改('工具', v)), '开着＝它多一个 qq_say 工具：想说才调、不调就不发。配合上面「自动发收尾句」关掉，就是「它自己在群里决定说不说」。')),
        ),

        // —— 称呼 ——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '怎么称呼你'),
          行('称呼', h('input', { type: 'text', style: S.small, value: String(配置.称呼 || '对方'), onChange: (e) => 改('称呼', e.target.value) }), '转给它的话里会用它。比如填「小明」，它收到的就是「小明发来了图片」。'),
        ),

        // —— 发到哪 ——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '发到哪'),
          行('转私聊', 勾(配置.转私聊, (v) => 改('转私聊', v)), '往下面这个 QQ 号私聊发。'),
          行('私聊 QQ 号', h('input', { type: 'text', style: S.small, value: String(配置.私聊QQ || ''), onChange: (e) => 改('私聊QQ', e.target.value) }), '就是你自己的 QQ 号。'),
          行('转群', 勾(配置.转群, (v) => 改('转群', v)), '往下面这个群发。'),
          行('群号', h('input', { type: 'text', style: S.small, value: String(配置.群号 || ''), onChange: (e) => 改('群号', e.target.value) }), '可空。'),
        ),

        // —— 图片 ——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '图片'),
          行('收图（QQ → 它）', 勾(配置.收图, (v) => 改('收图', v)), '你在 QQ 里发的图也转给它看。模型看得见图就直接看；纯文本模型只知道「有几张图、存在哪」。'),
          行('发图（它 → QQ）', 勾(配置.发图, (v) => 改('发图', v)), '它这一轮里发的图也发到 QQ。'),
          行('一条最多收几张', h('input', { type: 'number', min: 1, max: 10, style: S.small, value: String(配置.收图最多 ?? 4), onChange: (e) => 改('收图最多', Number(e.target.value)) }), '多出来的不转。一条最多 10 张。'),
          行('单张最大（MB）', h('input', { type: 'number', min: 1, max: 30, style: S.small, value: String(配置.图上限MB ?? 5), onChange: (e) => 改('图上限MB', Number(e.target.value)) }), '超过就跳过（两个方向都按这个）。'),
          行('图片根目录', h('input', { type: 'text', style: S.input, placeholder: '（留空就行：自动用目标会话所在的工作区）', value: String(配置.图片根目录 || ''), onChange: (e) => 改('图片根目录', e.target.value) }), '一般不用填。它正文里写 ![名字](相对路径) 时，先按这个目录找；留空就用目标会话所在的工作区。'),
          行('OneBot 接口', h('input', { type: 'text', style: S.input, value: String(配置.NapCat || ''), onChange: (e) => 改('NapCat', e.target.value) }), 'NapCat 的 OneBot HTTP 地址。手机侧默认 http://127.0.0.1:3000（走 SSH 隧道）。'),
          行('访问令牌', h('input', { type: 'password', style: S.small, value: String(配置.令牌 || ''), onChange: (e) => 改('令牌', e.target.value) }), '填了就给每个请求带 Authorization: Bearer <令牌>；留空＝不带。'),
          h('div', { style: S.dim }, '收进来的图会存一份到 %USERPROFILE%\\.dsh\\qq-bridge-inbox\\，文字里会带上路径。'),
        ),

        // —— 动作 ——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '自己动手'),
          h('div', null,
            按钮('保存设置', 存, true, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('测试一句', 试一句, false, 忙),
            h('span', { style: S.dim }, '　'),
            按钮('刷新', 拉, false, 忙),
          ),
          h('div', { style: { ...S.dim, marginTop: 4 } }, '「测试一句」会真的发一句去 QQ（绕过试运行），用来确认整条路通没通。'),
          说 ? h('div', { style: { ...S.ok, marginTop: 6 } }, 说) : null,
        ),

        // —— 记录 ——
        h('div', { style: S.card },
          h('div', { style: { ...S.h, margin: '0 0 8px' } }, '最近 ' + 日志.length + ' 条记录（新的在最下面）'),
          h('div', { style: { marginTop: 6, maxHeight: 220, overflowY: 'auto' } },
            日志.length === 0
              ? h('div', { style: S.dim }, '还没有记录。')
              : 日志.map((条, i) => h('div', { key: i, style: S.日志行 }, 条.时间 + '　' + 条.文本)),
          ),
        ),

        // —— 悬浮保存条 ——
        脏
          ? h('div', { style: S.悬浮保存条 },
              h('span', { style: { fontWeight: 600, color: '#c0392b' } }, '⚠ 有改动还没保存'),
              h('span', { style: S.dim }, '改完点这里就行'),
              按钮('保存设置', 存, true, 忙),
            )
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