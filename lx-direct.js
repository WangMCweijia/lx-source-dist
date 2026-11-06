/*!
 * @name 狐兔
 * @description 多网关并发择优，按真实音质选路
 * @version 2.16.4
 * @author 狐兔
 * @homepage https://lxmusic.toside.cn/desktop/custom-source
 */

const { EVENT_NAMES, request, on, send } = globalThis.lx

const log = (...a) => {
  // 只走 console.log —— 洛雪自己会把它转成日志：
  //   logcat 里是 `D UserApi Log: [log]'[direct]', ...`，App 内日志面板同源。
  //
  // 2026-11-03 真机实测教训：曾试过 send(EVENT_NAMES.log, line)，因为
  // 手机端 EVENT_NAMES 里根本没有 log 这个键，退化成字符串 'log' 后被拒：
  //   E UserApi : load script error: UnhandledPromiseRejectionException:
  //               The event is not supported: log
  // 这个异常把整个脚本的加载搞挂了。自定义源的事件只有 request / inited /
  // updateAlert 这几个，其余一律不能 send。
  try {
    console.log('[direct]', ...a)
  } catch (e) {}
}

// 版本号只认头注释 @version（洛雪解析后通过 currentScriptInfo 给出），
// 拿不到才用这里的兜底常量。日志、更新提示、更新地址全部读这一个值 ——
// v2.14.0 就是漏改了一处写死的 'v2.12.0'，真机日志里显示成旧版本，
// 差点把"到底装没装上"这件事判断错。
const MY_VER = (() => {
  try {
    const v = globalThis.lx && globalThis.lx.currentScriptInfo && globalThis.lx.currentScriptInfo.version
    if (v) return String(v)
  } catch (e) {}
  return '2.16.4'
})()

/* ============================================================================
 * 用户配置 —— 只有 QQ 需要填。不填就是匿名，QQ 官方接口会回 104003
 * ==========================================================================*/
// 浏览器登录 y.qq.com 后 F12 → Network → 任意请求 → Request Headers → Cookie，
// 把 uin=xxx; qm_keyst=xxx 这两段抠出来粘进下面。有会员号能出 FLAC
const USER_COOKIE = {
  tx: '',
}
const QQ_UIN = ''

// 构建时注入：CI 探测连续失败 2 次的网关会被写进这个数组，运行期直接跳过
const DISABLED_GW = []
// 构建时间，日志里能看出线上这份是哪天打的
const BUILT_AT = '2026-11-03T06:14:57.675Z'

/* ============================================================================
 * 网关清单（由 gw-table.mjs 内联而来，不要在这里改）
 * ==========================================================================*/
// 网关清单 —— 唯一真相。
// 换网关、加平台、调顺序，都只改这个文件，然后 node build.mjs 重新生成 lx-direct.js。
// probe.mjs 也 import 这里，所以测的和跑的一定是同一份配置。

// HYW 公益聚合的共享卡密。写死在它自己开源脚本里，公开的。
// 哪天失效了去 https://github.com/Macrohard0001/HYWmusic_source 找最新版里的
// CARD_KEY 常量换掉，然后 node build.mjs
const HYW_KEY = '6C1F-53W0-GRKI-EVFG'

/* ---------------------------------------------------------------------------
 * MD5
 *
 * 酷狗 trackercdn 的 key = md5(hash + 'kgcloudv2')。洛雪没有暴露 crypto 给
 * 自定义源（不同版本能用的东西不一样），所以自带一份，只依赖字符串。
 * -------------------------------------------------------------------------*/
const md5 = (() => {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const K = []
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0

  const hex = (n) => {
    let s = ''
    for (let i = 0; i < 4; i++) {
      const b = (n >>> (i * 8)) & 0xff
      s += (b < 16 ? '0' : '') + b.toString(16)
    }
    return s
  }

  return (input) => {
    const str = String(input)
    const bytes = []
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i)
      if (c < 0x80) bytes.push(c)
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
      else if (c < 0xd800 || c >= 0xe000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
      else {
        i++
        c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff))
        bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
      }
    }

    const len = bytes.length
    const words = []
    for (let i = 0; i < len; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8))
    words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8))
    const total = (((len + 8) >>> 6) + 1) * 16
    while (words.length < total) words.push(0)
    words[total - 2] = (len * 8) | 0
    words[total - 1] = Math.floor(len / 0x20000000) | 0

    let a = 0x67452301
    let b = 0xefcdab89
    let c = 0x98badcfe
    let d = 0x10325476
    for (let i = 0; i < total; i += 16) {
      const oa = a
      const ob = b
      const oc = c
      const od = d
      for (let j = 0; j < 64; j++) {
        let f
        let g
        if (j < 16) {
          f = (b & c) | (~b & d)
          g = j
        } else if (j < 32) {
          f = (d & b) | (~d & c)
          g = (5 * j + 1) % 16
        } else if (j < 48) {
          f = b ^ c ^ d
          g = (3 * j + 5) % 16
        } else {
          f = c ^ (b | ~d)
          g = (7 * j) % 16
        }
        const tmp = d
        d = c
        c = b
        const sum = (a + f + K[j] + (words[i + g] || 0)) | 0
        const sh = S[j]
        b = (b + ((sum << sh) | (sum >>> (32 - sh)))) | 0
        a = tmp
      }
      a = (a + oa) | 0
      b = (b + ob) | 0
      c = (c + oc) | 0
      d = (d + od) | 0
    }
    return hex(a) + hex(b) + hex(c) + hex(d)
  }
})()

/* ---------------------------------------------------------------------------
 * estTier：按"实际字节数 / 时长"反推真实码率
 *
 * 网关自报的档位一律不可信，实测三例：
 *   · 酷狗 trackercdn 请求 flac 回 .mp3，bitRate 字段照样报 2000+
 *   · a.aa.cab 的 C400 前缀自称 320k AAC，269 秒的《晴天》只有 3.13MB（≈93kbps）
 *   · HYW 的 320k 档回 RS0x 试听却写 actualQuality=320k
 * 只有"体积 ÷ 时长"骗不了人。分界取 500kbps 是因为 16bit/44.1k 无损
 * 实测最低也在 700kbps 以上，320k 有损封顶 320，中间留了足够冗余。
 * -------------------------------------------------------------------------*/
const estTier = (bytes, sec, ext) => {
  const e = String(ext || '').toLowerCase()
  if (e === 'flac' || e === 'wav' || e === 'ape') return 3
  // mflac/mgg/qmc 是 QQ 的加密容器，字节数虽然是无损量级但解不开，
  // 调用方在 isReal 里已经按扩展名拦掉，这里给 0 表示"不可用"
  if (e === 'mflac' || e === 'mgg' || e === 'qmc' || e === 'mgg1') return 0
  const b = Number(bytes) || 0
  const s = Number(sec) || 0
  if (!b || !s) {
    // 算不出码率时只信扩展名。m4a 不给 320k 待遇 —— 走这条路的
    // 基本都是第三方转码的低码率 AAC
    return e === 'mp3' ? 2 : e === 'm4a' ? 1 : 1
  }
  const kbps = (b * 8) / s / 1000
  if (kbps > 500) return 3
  if (kbps > 200) return 2
  return 1
}

/* ---------------------------------------------------------------------------
 * normQ：把"高于无损"的档位归一化成 flac
 *
 * 洛雪除了 128k/320k/flac 还会往下问 hires / master / atmos / atmos_plus /
 * flac24bit。除了 HYW（它真的按档位去问上游），其余网关只认三档，收到
 * 不认识的字符串就落进 else 分支变成最低档：
 *   kugou  -> 'lq'   = 128k
 *   qqauth -> 'M500' = 128k
 *   gdstudio -> '128' = 128k
 * 用户点"母带"实际拿到 128k，一半原因就在这。这里统一收到 flac。
 * -------------------------------------------------------------------------*/
const normQ = (q) => {
  const s = String(q || '').toLowerCase()
  if (s === '320k') return '320k'
  if (s === '128k') return '128k'
  // flac / flac24bit / hires / master / atmos / atmos_plus 一律按无损要
  return 'flac'
}

// 查询串构造。不用 URLSearchParams 是因为要保证空值也编码成 name=
// （HYW 服务端缺 name 会退化成只按 id 找，命中率明显下降）
const qs = (o) =>
  Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
    .map((k) => k + '=' + encodeURIComponent(String(o[k])))
    .join('&')

/* ---------------------------------------------------------------------------
 * 星海 xh 网关的三个小工具
 *
 * xhB64/xhToken：星海 v3.2.11 的 X-Token = base64(JSON{device_id,ip,
 * timestamp,random})。洛雪沙箱没有 btoa/Buffer，自带一份 base64。
 * token 载荷是纯 ASCII，不用处理 UTF-8；ip 固定 0.0.0.0 即可
 * （实测与真 IP token 同样 trusted）。
 *
 * xhQ：把洛雪档位映射成星海各平台认识的档位。星海五平台档位表不同
 * （kg 到 master、tx 到 atmos_plus、mg 只到 flac），目标档位平台不支持
 * 时落到该平台实际能给的最高档 —— 和星海自己 mapQuality 的行为一致。
 * -------------------------------------------------------------------------*/
const xhB64 = (str) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = []
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += chars[b0 >> 2]
    out += chars[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? chars[b2 & 63] : '='
  }
  return out
}
let xhDev = ''
const xhToken = () => {
  if (!xhDev) xhDev = 'lx-online-' + String(new Date().getTime() % 100000000) + String(Math.floor(Math.random() * 1000000))
  return xhB64(
    JSON.stringify({
      device_id: xhDev,
      ip: '0.0.0.0',
      timestamp: Math.floor(new Date().getTime() / 1000),
      random: String(Math.random()).slice(2, 12),
    })
  )
}
const XH_AVAIL = {
  kg: ['128k', '320k', 'flac', 'hires', 'atmos', 'master'],
  tx: ['128k', '192k', '320k', 'flac', 'hires', 'atmos', 'atmos_plus', 'master'],
  mg: ['128k', '320k', 'flac'],
}
const XH_ORDER = ['master', 'atmos_plus', 'atmos', 'hires', 'flac', '320k', '192k', '128k']
const xhQ = (source, q) => {
  const avail = XH_AVAIL[source] || XH_AVAIL.kg
  const s = String(q || 'flac').toLowerCase()
  if (avail.indexOf(s) >= 0) return s
  // flac24bit 星海不认，和它 mapQuality 一样落到 hires
  const alias = s === 'flac24bit' ? 'hires' : s
  if (avail.indexOf(alias) >= 0) return alias
  for (let i = 0; i < XH_ORDER.length; i++) if (avail.indexOf(XH_ORDER[i]) >= 0) return XH_ORDER[i]
  return '128k'
}

//
// ---------------------------------------------------------------------------
// 质量等级 tier（并发竞速时按它择优，数字大的赢）
//   4  24bit / Hi-Res FLAC
//   3  16bit 无损 FLAC
//   2  320k 有损
//   1  128k 有损
//   0  只能确认能播，不知道码率（试听片段一律判 0 并丢弃）
//
// hold 是"愿意为它多等多久"（毫秒）。质量越高越值得等：Hi-Res 2.5 秒
// 换来 110MB，值；320k 让用户等 2.5 秒就不值。
// ---------------------------------------------------------------------------
const GW = {
  /* ---------------- 酷我 ---------------- */
  kwofficial: {
    label: '酷我官方 mobi.s',
    // 真·无损通道（国内直连，不经任何第三方）。
    //
    // 之前这里写着"br=2000kflac 会返回 mgg 加密容器，所以 flac 档一律不走"，
    // 那条结论是错的。真相：请求里漏了 format 参数时服务端默认 format=mgg
    // （加密容器 + ekey），一旦显式带上 &format=flac 就直接给明文 FLAC 直链。
    // 实测《晴天》228908：
    //   br=2000kflac&format=flac -> Content-Type: audio/x-flac
    //   Content-Range: bytes 0-63/55397039，魔数 66 4c 61 43 = "fLaC"
    // 于是酷我在 cwww / hyw 全断的情况下也拿得到真无损 —— 这正是用户
    // "酷我本来能播 flac，现在只有 320k"要的东西。
    build: (p) => {
      const q = String(p.quality || '').toLowerCase()
      // 所有"高于 flac"的档位也走 flac：只有 HYW 有 Atmos/母带，酷我最高就是无损
      const wantFlac = q === 'flac' || /^(hires|atmos|atmos_plus|master|flac24bit)$/.test(q)
      const br = wantFlac ? '2000kflac' : q === '128k' ? '128kmp3' : '320kmp3'
      return {
        url:
          'http://mobi.kuwo.cn/mobi.s?f=web&user=0' +
          '&source=kwplayer_ar_8.5.5.0_apk_keluze.apk' +
          '&type=convert_url_with_sign&rid=' +
          encodeURIComponent(p.id) +
          '&br=' +
          br +
          '&format=' +
          (wantFlac ? 'flac' : 'mp3'),
        // 实测 150~180ms，1600 = 9 倍余量，同时压在外层竞速硬上限(2400)之内
        options: { method: 'GET', headers: { 'User-Agent': 'okhttp/3.10.0' }, timeout: 1600 },
      }
    },
    pick: (b, p) => {
      const d = (b && b.data) || null
      if (!d || !d.url) return null
      const fmt = String(d.format || '').toLowerCase()
      // mgg 是酷我的加密容器，播放器解不了，拿到也不能用
      if (fmt === 'mgg') return null
      let tier = 0
      // 先信服务端声明的 format：它说 flac 就是真无损
      if (fmt === 'flac' || fmt === 'ape' || fmt === 'wav') tier = 3
      // 再按 trackmedia 文件名兜底：F000xxx=无损、M800xxx=320k、M500xxx=128k
      if (!tier) {
        const m = /trackmedia\/([FM])(\d{3})/i.exec(String(d.url))
        if (m) tier = m[1].toUpperCase() === 'F' ? 3 : m[2] === '800' ? 2 : 1
      }
      if (!tier) tier = (p && p.quality) === '128k' ? 1 : 2
      return { url: d.url, tier: tier }
    },
    // 它现在能给无损，必须标 3：raceAll 的 highPending 靠这个字段判断
    // "还有没有能出无损的通道没回"，标 2 会让它被当成低档候选提前收工
    tier: 3,
    hold: 250,
    native: ['kw'],
  },

  cwww: {
    label: 'c.wwwweb.top',
    build: (p) => ({
      url: 'https://c.wwwweb.top/music/url',
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: p.source, musicId: p.id, quality: normQ(p.quality) }),
        // 1.5 秒 = 正常耗时(235~500ms)的 3 倍。关键不是"够不够"，而是
        // "挂了要多久能判死"：设 3 秒时它和竞速硬上限(2.4s)一起把洛雪
        // 3 秒窗口吃光，酷我/酷狗/咪咕全部卡在 2.4 秒边缘，稍有抖动就
        // 整档失败。1.5 秒判死后 highPending 归零，立刻交手里已有的 320k
        timeout: 1500,
      },
    }),
    // { code:200, quality:'flac', url:'http://...' }
    pick: (b) => {
      if (!b || Number(b.code) !== 200 || !b.url) return null
      const q = String(b.quality || '').toLowerCase()
      return { url: b.url, tier: q.indexOf('flac') >= 0 ? 3 : q.indexOf('320') >= 0 ? 2 : 1 }
    },
    tier: 3,
    hold: 600,
    // kg/tx 会返回 200 + gitcode 上的假 mp3，靠白名单拦
    native: ['kw', 'wy'],
  },

  /* ---------------- 网易 meting ---------------- *
   * 国内可达、无需登录，302 直落 m701/m801.music.126.net（网易自家 CDN），
   * 实测 br=999 给真 FLAC（《起风了》115MB / 2830kbps 的 24bit 母带）。
   * 这是酷我 cwww / hyw 都连不上时唯一还能拿到无损的路。
   *
   * 为什么不直接让播放器跟随 302：洛雪的 request 会跟随跳转并把整个文件
   * 读进内存，母带 115MB 直接把这一轮拖死。所以用 Range 只要前 64 字节，
   * 靠文件头判档：fLaC=无损、ID3/OggS=有损，比任何自报字段都准。
   * ------------------------------------------------------------------*/
  wymeting: {
    label: '网易meting',
    build: (p) => ({
      url:
        'https://api.qijieya.cn/meting/?type=url&id=' +
        encodeURIComponent(p.id) +
        '&server=netease&br=' +
        (normQ(p.quality) === 'flac' ? '999' : normQ(p.quality) === '320k' ? '320' : '128'),
      options: {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-63' },
        // 1.5 秒。它是网易唯一稳定通道，但正常 300ms 就回；
        // 6 秒超时意味着它挂的时候会把整个无损层拖死
        timeout: 1500,
      },
    }),
    pick: (b) => {
      const head = typeof b === 'string' ? b.slice(0, 8) : ''
      // 没拿到可辨识的文件头就不认。meting 挂掉时它回空 body 或 HTML 错误页
      if (head.indexOf('fLaC') === 0) return { url: null, tier: 3 }
      if (head.indexOf('ID3') === 0 || head.indexOf('OggS') === 0 || head.indexOf('RIFF') === 0)
        return { url: null, tier: 2 }
      return null
    },
    tier: 3,
    hold: 700,
    // 播放器拿到的就是这个 meting 地址，它 302 到网易 CDN。isReal 对 stream
    // 型直接放行，不去比对 CDN 域名白名单
    stream: true,
    // 回包是音频前 64 字节，不是 JSON。probe 要走原始文本分支
    binary: true,
    native: ['wy'],
  },

  /* ---------------- 网易 ---------------- */
  gdstudio: {
    label: 'music-api.gdstudio.xyz',
    build: (p) => ({
      url:
        'https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=' +
        encodeURIComponent(p.id) +
        '&br=' +
        (normQ(p.quality) === 'flac' ? '999' : normQ(p.quality) === '320k' ? '320' : '128'),
      options: { method: 'GET', timeout: 2000 },
    }),
    pick: (b) => {
      if (!b || typeof b.url !== 'string' || !b.url) return null
      const mb = Number(b.size) ? Number(b.size) / 1048576 : 0
      const br = Number(b.br) || 0
      // 24bit Hi-Res 实测 110MB / br 999，普通无损 38MB。
      // 单曲超过 60MB 基本只可能是 24bit 或整轨，按 4 级算
      return { url: b.url, tier: mb > 60 || br >= 999 ? 4 : 3, sizeMB: mb }
    },
    tier: 4,
    hold: 2600,
    native: ['wy'],
  },

  // injaho(api.injahow.cn meting) 已移除：它 302 直接跳到音频，洛雪的 request
  // 拿回来的 body 是二进制音频而不是 URL，自定义源没法把"流"当链接返回。
  // 只能用它的 302 Location，但客户端不暴露重定向链。

  /* ---------------- 酷狗 ---------------- */
  kugou: {
    label: '酷狗 trackercdn',
    // 匿名可用的老接口。key = md5(hash + 'kgcloudv2')，md5 用内联实现（见 template）
    build: (p) => ({
      url:
        'https://trackercdn.kugou.com/i/v2/?key=' +
        md5(p.id + 'kgcloudv2') +
        '&hash=' +
        encodeURIComponent(p.id) +
        '&br=' +
        (normQ(p.quality) === 'flac' ? 'flac' : normQ(p.quality) === '320k' ? 'hq' : 'lq') +
        '&appid=1005&pid=2&cmd=25&behavior=play',
      options: { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', Cookie: 'kg_mid=2333' }, timeout: 1000 },
    }),
    pick: (b, p) => {
      // status=1 才有 url；status=2 是"无版权/VIP 专用"，匿名拿不到。
      // 主流原版曲几乎全是 status=2 —— 这条路只对免费曲有效
      if (!b || Number(b.status) !== 1) return null
      // url 有时是字符串有时是数组，两种都见过
      const u = Array.isArray(b.url) ? b.url[0] : b.url
      if (!u) return null
      const bytes = Number(b.fileSize) || 0
      const sizeMB = bytes ? bytes / 1048576 : 0
      const noQuery = String(u).split('?')[0]
      const ext = ((/\.(\w+)(?:$|\?)/.exec(noQuery) || [])[1] || '').toLowerCase()
      // 它自报的 timeLength 优先，拿不到用请求里的时长
      const sec = Number(b.timeLength) || Number(p && p.sec) || 0
      // bitRate 字段不可信（请求 flac 回 .mp3 也报 2000+），一律按体积反推。
      // 之前写死 "m4a 一律算 320k"，导致酷狗回的低码率 m4a 冒充 320k，
      // 用户点 320k 拿到 93kbps 的流还显示"成功"
      const tier = estTier(bytes, sec, ext)
      if (!tier) return null
      return { url: String(u), tier: tier, sizeMB: sizeMB }
    },
    tier: 3,
    hold: 700,
    native: ['kg'],
  },

  /* ---------------- 聚合（HYW 公益） ---------------- */
  hyw: {
    label: 'HYW 公益聚合',
    // 实测唯一能给 QQ 整曲 FLAC 的通道：《晴天》返回 F0000 前缀 .flac，
    // 55,397,039 字节，文件头 fLaC。它服务端挂着 QQ 账号池，按歌名+歌手
    // 反查自己库里的同一首（所以 url 里的 mid 和你传入的 songmid 常常不一样）
    //
    // 必须用 http:// 不能 https:// —— 这台机器是裸 IP + Let's Encrypt 证书，
    // subject 为空，Electron 的证书校验必然失败（UNABLE_TO_VERIFY_LEAF_SIGNATURE）
    build: (p) => ({
      url:
        'http://103.79.184.97/api/music/url?' +
        qs({
          platform: p.source,
          source: p.source,
          id: p.id,
          quality: p.quality,
          name: p.name || '',
          singer: p.singer || '',
          interval: p.interval || '',
          key: HYW_KEY,
        }),
      options: {
        method: 'GET',
        headers: { 'User-Agent': 'lx-music-desktop/2.11.0' },
        // 3.2 秒。竞速硬上限 2.4 秒，网关超时必须贴着它走 —— 设 4.5 秒时
        // 洛雪早在 3 秒处判失败了，这条通道等于不存在
        // 1.6 秒。它要么 1.3 秒内给直链，要么连接层直接失败 —— 2600 毫秒
        // 以上的等待从来不会换来结果，只会拖死整层
        timeout: 1600,
      },
    }),
    pick: (b, p) => {
      if (!b) return null
      if (Number(b.code) !== 200) return null
      const u = b.url || b.data
      if (!u || typeof u !== 'string') return null
      // 320k 档它经常回 RS02（60 秒试听）却自称 actualQuality=320k，
      // 只能看 URL 前缀，不能信它自报的档位
      if (/\/RS0\d/i.test(u.split('?')[0])) return null
      // 咪咕走它自己的中转：/api/music/proxy?platform=mg&url=<咪咕CDN>
      // 直接 200 回音频流（不是 302），所以 CDN_HOST 白名单认不出来。
      // 真实码率只能从内层 url 的文件名看：
      //   MP3_320_16_Stero        真 320k
      //   全曲试听/Mp3_64_22_16   64k 试听片段，不是整曲
      if (/\/api\/music\/proxy\?/i.test(u)) {
        let inner = u
        try {
          inner = decodeURIComponent(u)
        } catch (e) {}
        if (/试听|Mp3_64|_64_/i.test(inner)) return null
        const t = /MP3_320|_320_/i.test(inner) ? 2 : /flac|FLAC/.test(inner) ? 3 : 1
        return { url: u, tier: t }
      }
      const q = String(b.actualQuality || b.quality || '').toLowerCase()
      const declared = /24bit|hi-?res|master|atmos/.test(q) ? 4 : q.indexOf('flac') >= 0 ? 3 : q.indexOf('320') >= 0 ? 2 : 1
      const noQuery = String(u).split('?')[0]
      const ext = ((/\.(\w+)(?:$|\?)/.exec(noQuery) || [])[1] || '').toLowerCase()
      let tier = estTier(Number(b.size) || Number(b.fileSize) || 0, Number(p && p.sec) || 0, ext)
      // 0 = 加密容器（mflac/mgg），解不开，别交给播放器
      if (!tier) return null
      // flac 家族靠扩展名分不出 16bit / 24bit，这一档保留它自报的等级
      if (tier === 3 && declared >= 3) tier = declared
      return { url: u, tier: tier }
    },
    tier: 3,
    hold: 2600,
    // HYW 真按档位去问上游（服务端挂账号池），母带层可以直发原档
    hiQ: true,
    native: ['kw', 'wy', 'tx', 'mg'],
  },

  /* ---------------- QQ ---------------- */
  qqauth: {
    label: 'QQ 官方 vkey（需填 cookie）',
    // 匿名 uin=0 一律返回 104003，必须带登录态 cookie。
    // 把 cookie 填进 template.js 的 USER_COOKIE.tx 才生效，没填时自动跳过
    build: (p) => ({
      url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: (typeof USER_COOKIE === 'object' && USER_COOKIE.tx) || '',
        },
        body: JSON.stringify({
          comm: { uin: (typeof QQ_UIN === 'string' && QQ_UIN) || '0', format: 'json', ct: 24, cv: 0 },
          req_1: {
            module: 'vkey.GetVkeyServer',
            method: 'CgiGetVkey',
            param: {
              filename: [
                (normQ(p.quality) === 'flac' ? 'F000' : normQ(p.quality) === '320k' ? 'M800' : 'M500') + p.id + (normQ(p.quality) === 'flac' ? '.flac' : '.mp3'),
              ],
              guid: '10000',
              songmid: [p.id],
              songtype: [0],
              uin: (typeof QQ_UIN === 'string' && QQ_UIN) || '0',
              loginflag: 1,
              platform: '20',
            },
          },
        }),
        timeout: 1000,
      },
    }),
    pick: (b) => {
      const d = (((b || {}).req_1 || {}).data) || {}
      const list = d.midurlinfo || []
      const sip = (d.sip || [])[0] || ''
      const info = list[0] || {}
      if (!info.purl) return null
      const name = String(info.filename || '')
      // RS0x 是 60 秒试听，不是整曲。宁可报失败也别让用户听一分钟断掉
      if (/^RS0/i.test(name)) return null
      return { url: sip + info.purl, tier: /\.flac$/i.test(name) ? 3 : 2 }
    },
    tier: 3,
    hold: 900,
    native: ['tx'],
  },

  // vkeys(api.vkeys.cn) 不作取链网关：免费层的取链接口只回 RS0x 的 60 秒试听，
  // 且要先按关键词搜出自己的数字 id（传 songmid 会报"id 必须是整数"）。
  // 但它 /v2/music/tencent 的**搜索**是好的（500ms、字段干净），
  // 现在只当 QQ 搜索的兜底，见 template.js 的 searchQq。

  aacab: {
    label: 'a.aa.cab',
    // HelloWorld 源里的备用通道。按"歌名 歌手"搜索而不是按 songmid，
    // 拿回来的是 C400 前缀 m4a（320k AAC 整曲，不是试听）
    //
    // 它只给 320k，type 参数写 flac / hires 一样回 C400，所以 tier 固定 2
    build: (p) => ({
      url:
        'https://a.aa.cab/qq.music?msg=' +
        encodeURIComponent(((p.name || '') + ' ' + (p.singer || '')).trim()) +
        '&n=1&type=flac',
      options: { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 1500 },
    }),
    pick: (b, p) => {
      const d = (b && b.data) || null
      if (!d || !d.music) return null
      // 它是关键词搜索，可能搜出翻唱。歌名和歌手对不上的一律丢
      // 归一化写在这里而不是复用外面的 norm()，是为了这个文件能单独被 probe.mjs
      // import 而不依赖 template.js 的作用域
      const nm = (s) =>
        String(s || '')
          .toLowerCase()
          .replace(/[\s\-_·・.,，。()（）[\]【】'"、/|]/g, '')
      if (p && p.name && nm(d.song) !== nm(p.name)) return null
      if (p && p.singer && d.singer) {
        const A = nm(d.singer).split(/[&/]+/)
        const B = nm(p.singer).split(/[&/]+/)
        if (!A.some((x) => x && B.some((y) => y && (x === y || x.includes(y) || y.includes(x))))) return null
      }
      const u = String(d.music)
      if (/\/RS0\d/i.test(u.split('?')[0])) return null
      // 前缀是它唯一可靠的结构信息：F0=flac 家族，C4=m4a，M8=mp3。
      // 但前缀只说明容器，不说明码率 —— 用户实测《晴天》269 秒拿回
      // 3.13MB 的 C4（≈93kbps），被当 320k 报成功。所以按体积再核一遍，
      // 拿不到体积时按 m4a 保守算 128k，让它只当"有声音"的兜底
      const pref = /\/F0/i.test(u) ? 'flac' : /\/C4/i.test(u) ? 'm4a' : /\/M8/i.test(u) ? 'mp3' : ''
      const tier = estTier(Number(d.size) || 0, Number(d.interval) || Number(p && p.sec) || 0, pref)
      if (!tier) return null
      return { url: u, tier: tier }
    },
    tier: 2,
    hold: 500,
    // 它按 IP 限频，明文回 min_interval_ms:200。设 1200 时排队会积压 ——
    // 洛雪七档连着问，第十个请求要等 12 秒，整条 cross 链被拖死
    // （线上产物实测 2392ms -> 14068ms）。500 = 声明值的 2.5 倍，
    // 配合 askGw 里的"排队超过 800ms 就放弃本档"，宁可少问一次也不拖
    minGap: 500,
    native: ['tx'],
  },

  /* ---------------- 星海取流（token 协议） ----------------
   * 星海 v3.2.11 协议：先 /ip.php 拿出口 IP，再 base64({device_id,ip,
   * timestamp,random}) 做 X-Token，附 X-Client 头请求 /lx/api/。
   * 实测 ip=0.0.0.0 的 token 同样有效，所以 build 里同步生成即可，
   * 不用先跑一趟异步取 IP。
   *
   * 这条通道纠正了 2026-11-03 前的一个误判：旧探测裸打 /lx/api/ 吃
   * 503「未授权调用暂时受限」/ 403「仅对认证用户开放」，被当成死通道
   * （见文件尾留档）。带上协议头后——
   *   kg  flac/hires/atmos/master 全档返回真酷狗 CDN
   *       （fs.youthandroid2.kugou.com / fsandroid.tx.kugou.com），
   *       文件名带 quflac/quhigh/quviper_atmos(quviper_clear) 档位标记，
   *       这是目前唯一能给酷狗母带/全景声的本平台通道
   *   tx  概率触发「触发人机验证」403，赌赢了给真 QQ 链接
   *   mg  时好时坏（502 取流失败），是咪咕唯一的本平台希望
   * 忙时 503「服务器繁忙」，按限频/熔断流程自动跳过即可。
   * 它对未授权设备有 QPS 配额，minGap 拉开请求间隔。
   */
  xh: {
    label: '星海取流',
    build: (p) => {
      const srcMap = { kg: 'kg', tx: 'qq', mg: 'migu' }
      const src = srcMap[p.source] || p.source
      const q = xhQ(p.source, p.quality)
      let url
      if (src === 'kg') {
        // kg 走 mainHash 通道：songmid 和 mainHash 都填 hash（星海自己
        // 也是这么拼的：songmid = musicInfo.songmid || musicInfo.id）
        url =
          'https://yy.zddyr.top/lx/api/?source=kg&quality=' + q +
          '&songmid=' + encodeURIComponent(p.id) +
          '&albumId=&mainHash=' + encodeURIComponent(p.id)
      } else {
        url =
          'https://yy.zddyr.top/lx/api/?source=' + src +
          '&name=' + encodeURIComponent(p.name || '') +
          '&singer=' + encodeURIComponent(p.singer || '') +
          '&songmid=' + encodeURIComponent(p.id) +
          '&interval=' + encodeURIComponent(p.interval || '') +
          '&albumName=&quality=' + q
      }
      return {
        url: url,
        options: {
          method: 'GET',
          headers: {
            'User-Agent': 'lx-music',
            'X-Token': xhToken(),
            'X-Client': 'XingHaiMusicSource/v3.2.11 (Windows)',
          },
          // 实测 1~2s 出链。竞速硬上限 2.4s，贴着它走
          timeout: 2200,
        },
      }
    },
    pick: (b, p) => {
      if (!b || Number(b.code) !== 200 || !b.url) return null
      // ekey/encrypted 非空 = 加密容器（mgg/mflac），播放器解不了
      if (b.ekey || b.encrypted) return null
      const u = String(b.url)
      const noQuery = u.split('?')[0]
      const ext = ((/\.(\w+)(?:$|\?)/.exec(noQuery) || [])[1] || '').toLowerCase()
      if (ext !== 'flac' && ext !== 'mp3' && ext !== 'm4a' && ext !== 'aac') return null
      // 档位以酷狗 CDN 文件名标记为准（和 F000/M800 一样是结构性证据）：
      //   quviper_clear   蝰蛇超清母带      -> 4
      //   quviper_atmos   蝰蛇全景声        -> 4
      //   quhigh          Hi-Res 24bit      -> 4
      //   quflac          16bit 无损        -> 3
      //   qu320 / qu128   有损              -> 2 / 1
      let tier = 0
      if (/quviper_clear|quviper_atmos|quhigh|qu24/i.test(u)) tier = 4
      else if (/quflac/i.test(u)) tier = 3
      else if (/qu320/i.test(u)) tier = 2
      else if (/qu128/i.test(u)) tier = 1
      // 文件名没标记时退到自报 format，最后才按扩展名保守估
      if (!tier) {
        const fmt = String(b.format || '').toLowerCase()
        if (fmt === 'flac') tier = ext === 'flac' ? 3 : 2
        else if (/320/.test(String(b.quality || ''))) tier = 2
        else tier = ext === 'mp3' ? 2 : 1
      }
      return { url: u, tier: tier }
    },
    // 能出母带(4)，必须标 4：raceAll 的 highPending 靠它判断
    // "还有没有能出高档的通道没回"
    tier: 4,
    hold: 2200,
    // 未授权设备有 QPS 配额，七档连问要错峰
    minGap: 250,
    // 认原档（master/atmos/hires 直通上游），母带层可以真发母带请求
    hiQ: true,
    native: ['kg', 'tx', 'mg'],
  },

  // 已死，留档不要删 —— 免得下次又去试一遍。
  // haitangw   POST musicserver.haitangw.cc/v1/music/resolve-url -> APP_UPGRADE_REQUIRED
  // nmobi      flac 档返回 mgg 加密容器（format:"mgg" + ekey）
  // heheda     music-api.heheda.top -> 402 DEPLOYMENT_DISABLED
  // imetro     401，要付费 key
  // xingzhige  返回 HTML 落地页，不是 API
  // 咪咕 v3    整站 301 到 /v5/ 前端，audioPlayer/getPlayInfo 已下线
  //
  // [更正 2026-11-03] yyzddyr 不是死的：旧探测裸打 /lx/api/ 被 503/403
  // 劝退，实际它要求 X-Token/X-Client 协议头，见上方 xh 网关。
  // 同理 zrcdy.dpdns.org 是星海新推荐域但 /lx/api/ 新版（要 name+songmid）
  // 全 500，老格式 410，暂不可用。
}

/* ---------------------------------------------------------------------------
 * ROUTE：平台 -> 网关
 *   direct  用本平台自己的 id 直接问。全部并发，按 tier 择优
 *   only    只在指定档位参与
 *   search  是否允许"拿歌名+歌手去别家搜同名曲"这条兜底
 * -------------------------------------------------------------------------*/
const ROUTE = {
  kw: {
    // hq 层三路并发，全部都能出真无损：
    //   kwofficial 国内直连（mobi.kuwo.cn），带 format=flac 就给明文 FLAC
    //              55.4MB。不经过任何第三方，用户侧一定通 —— 排第一
    //   cwww      酷我自己库，真 FLAC 52.83MB，《晴天》229ms。境外 EdgeOne
    //              节点，用户侧可能不通，作为第二路
    //   hyw       同一首给直链 kw-er.kuwo.cn/.../trackmedia/F000xxx.flac（实测 1.3s）
    //              对无版权曲回 HTTP 410，那是曲目级拒绝不是平台下线
    // 三路都挂才降 320k —— 官方 mobi.s 同一条接口 br=320kmp3
    direct: [
      { gw: 'kwofficial', as: 'kw' },
      { gw: 'cwww', as: 'kw' },
      { gw: 'hyw', as: 'kw' },
    ],
    // 酷我没有的曲仍可去别家捞，cross 里会自动跳过 as==='kw' 的项
    search: true,
  },
  wy: {
    direct: [
      // wymeting 走网易自家 CDN，国内直连，150ms 出 flac；cwww/hyw 是境外中转，
      // 用户侧经常整段不通，所以 meting 排第一
      { gw: 'wymeting', as: 'wy' },
      { gw: 'gdstudio', as: 'wy', only: ['flac'] },
      { gw: 'cwww', as: 'wy' },
      { gw: 'hyw', as: 'wy' },
    ],
    search: true,
  },
  kg: {
    // xh（星海）排第一：唯一能给酷狗 master/atmos 的本平台通道，
    // 返回真酷狗 CDN；忙时 503 自动让位给并发的后两路
    // hyw 对 kg 回 500「酷狗所有音源均获取失败」，留着无妨 —— 会并发失败自动跳过，
    // 万一哪天它修好了就白捡一条
    direct: [
      { gw: 'xh', as: 'kg' },
      { gw: 'kugou', as: 'kg' },
      { gw: 'hyw', as: 'kg' },
    ],
    search: true,
  },
  tx: {
    // hyw 是唯一实测能给 QQ 整曲无损的路，排第一
    // xh 的 qq 通道概率触发人机验证，赌赢给真 QQ 链接，白捡
    // aacab 只给 320k 整曲（不是试听），HYW 挂掉时至少还有声音
    direct: [
      { gw: 'hyw', as: 'tx' },
      { gw: 'xh', as: 'tx' },
      { gw: 'aacab', as: 'tx' },
      { gw: 'qqauth', as: 'tx', needCookie: 'tx' },
    ],
    search: true,
  },
  mg: {
    // xh 的 migu 通道是咪咕唯一的本平台取流口（时好时坏）
    // hyw 对 mg 回 403「当前音质不在您的权限范围内」，实际靠跨平台兜底
    direct: [
      { gw: 'xh', as: 'mg' },
      { gw: 'hyw', as: 'mg' },
    ],
    search: true,
  },
}

// 只放行已知音乐 CDN。网关对不支持的源会回 200 + gitcode 上的假 mp3，
// 不拦就会"成功"播出一段噪音，比直接报错更难查
const CDN_HOST = /(^|\.)(kuwo\.cn|126\.net|163\.com|kugou\.com|kgimg\.com|kglink\.com|trackercdn\.com|migu\.cn|qqmusic\.qq\.com|qqmusic\.cn|stream\.qq\.com|tencentmusic\.com)$/
const AUDIO_EXT = /\.(flac|mp3|m4a|aac|ogg|wav)$/i

// 搜索接口
// 酷我必须走 https：http://search.kuwo.cn 会被部分运营商/公共 DNS 劫持成
// 空白页或 302 落地页，parseLoose 解不出来就当"搜不到"，跨平台兜底整条废掉。
// 这正是"酷狗/咪咕在别人机器上全灭、我本机却好好的"的原因 —— 本地网络干净，
// 用户侧 http 被劫。https 版本实测同样返回单引号字面量，解析逻辑不用改
const KW_SEARCH = 'https://search.kuwo.cn/r.s'
// /api/search/get/web 对高频调用回 {code:405,"操作频繁"}，洛雪七档连问必中；
// /api/search/get 同源不限，cloudsearch/pc 带 hr/fl 字段可预判有无无损
const WY_SEARCH = 'https://music.163.com/api/search/get'
const WY_SEARCH2 = 'https://music.163.com/api/cloudsearch/pc'
const KG_SEARCH = 'https://songsearch.kugou.com/song_search_v2'
// QQ 匿名搜索：不需要任何 cookie/token，实测官方版稳定排第 1 条
const QQ_SEARCH = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp'
// gdstudio 的聚合搜索（types=search），转发网易库但和取链同源 ——
// 拿到 id 直接能问 types=url，不用再经过网易那个抖动的老接口
const GD_SEARCH = 'https://music-api.gdstudio.xyz/api.php'

/* ---------------------------------------------------------------------------
 * CROSS_CFG：原平台取不到时，按这个顺序去别家搜同名曲
 *
 * 顺序是踩过坑定的：
 *   酷我  正版库，FORMATS 字段明确标有没有 FLAC，翻唱过滤最可靠 → 第一
 *   酷狗  正版库，但匿名 trackercdn 对 VIP 曲只回 mp3，免费曲能用 → 第二
 *   网易  老搜索接口(api/search/get/web)的相关性排序极差 —— 搜"晴天 周杰伦"
 *         前 50 条全是翻唱自媒体，官方版(186016)根本进不了候选，误配翻唱
 *         的风险大于收益 → 只能垫底
 * gws 是命中同名曲后用来取链的网关组，多路并发竞速。
 * -------------------------------------------------------------------------*/
/* ---------------------------------------------------------------------------
 * CROSS_CFG：原平台拿不到目标音质时，去别家搜同名曲
 *
 * 顺序按"这家能给出的最高真实音质"排，不按命中率：
 *   1) 酷我 —— cwww 走酷我库，实测《晴天》官方版 52.83MB 真 FLAC 229ms，
 *      是所有免费匿名通道里唯一稳定给整曲无损的。搜索必须带 vipver=1，
 *      否则官方版排序靠后被 KTV/翻唱挤出前 30 条
 *   2) QQ  —— c.y.qq.com 匿名搜索最靠谱（官方版稳定排第 1），但取链
 *      只有 aacab 的 320k；作为"至少有声音"的第二档
 *   3) 网易 —— gdstudio 与取链同源，能给 FLAC，但网易曲库缺周杰伦系
 *   4) 酷狗 —— trackercdn 对 VIP 曲任何 hash 都 status=2，实测只剩 128k，
 *      放最后纯当补漏
 * -------------------------------------------------------------------------*/
const CROSS_CFG = [
  { label: '酷我', as: 'kw', searcher: 'kw', gws: ['cwww', 'hyw', 'kwofficial'] },
  { label: 'QQ', as: 'tx', searcher: 'qq', gws: ['hyw', 'xh', 'aacab'] },
  { label: '网易', as: 'wy', searcher: 'wy', gws: ['wymeting', 'gdstudio', 'cwww'] },
  { label: '酷狗', as: 'kg', searcher: 'kg', gws: ['xh', 'kugou', 'hyw'] },
]

/* ============================================================================
 * 工具
 * ==========================================================================*/

// 洛雪的 request 是回调式，包一层 Promise。body 优先取第三个参数，
// 拿不到再退 resp.body —— 不同版本客户端给的位置不一样
const http = (url, options) =>
  new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    const t = setTimeout(() => done(null), Number(options && options.timeout) || 4500)
    try {
      request(url, options || {}, (err, resp, body) => {
        clearTimeout(t)
        if (err) return done(null)
        let b = body
        if (b === undefined || b === null) b = resp && resp.body
        // 能解析成对象的最好；解析不了的原样往下传，交给 parseLoose 兜底。
        // 这里如果直接 return null，酷我搜索（单引号字面量）会永远空结果
        if (typeof b === 'string') {
          try {
            b = JSON.parse(b)
          } catch (e) {}
        }
        done(b === undefined ? null : b)
      })
    } catch (e) {
      clearTimeout(t)
      done(null)
    }
  })

// 酷我搜索返回的是单引号对象字面量，不是合法 JSON
// 把单引号对象字面量转成合法 JSON。
//
// 为什么不能直接 new Function：洛雪手机端跑在 React Native / Hermes 上，
// **Hermes 默认禁用 eval 和 new Function**。桌面端（Chromium）允许，所以
// 本机怎么测都是好的；手机端走到那一行直接抛异常，被 catch 吞掉后返回 null，
// 于是酷我搜索恒为空数组 —— 日志只留下一句"酷我 无可用同名曲"，看着像
// 没搜到，实际是搜到了 30 条却一条都没解析出来。
//
// 酷狗/咪咕全靠"跨平台借酷我"，而跨平台第一步就是这条搜索，所以这一条
// 在手机端一断，那两个平台就是整列秒失败。2026-11-03 用 adb 实测确认：
// 手机与电脑请求同一个 URL，响应都是 30 条 / 76171 字节，逐字节相同。
//
// 纯字符扫描，不用任何 eval，两行逻辑就能覆盖这种格式：
//   {'KEY':'value','N':1,...}
// 字符串内的 " 要转义，\' 要当成普通单引号继续留在字符串里
const squoteToJson = (t) => {
  let out = ''
  let inStr = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (inStr) {
      if (c === '\\') {
        // 原样保留转义对，避免把 \' 拆坏
        out += c + (t[i + 1] || '')
        i++
        continue
      }
      if (c === "'") {
        out += '"'
        inStr = false
        continue
      }
      if (c === '"') {
        out += '\\"'
        continue
      }
      out += c
    } else if (c === "'") {
      out += '"'
      inStr = true
    } else {
      out += c
    }
  }
  return out
}

const parseLoose = (v) => {
  if (v && typeof v === 'object') return v
  const t = typeof v === 'string' ? v.trim() : ''
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch (e) {}
  // 单引号字面量（酷我搜索）—— 必须先走这条，不能依赖 new Function
  try {
    return JSON.parse(squoteToJson(t))
  } catch (e) {}
  // 兜底：只在允许 eval 的运行环境（桌面端）生效，手机端会抛错
  try {
    return new Function('return (' + t + ')')()
  } catch (e) {}
  return null
}

const isReal = (u, stream) => {
  if (!u || typeof u !== 'string' || !/^https?:\/\//i.test(u)) return false
  if (stream) return true // 302 型网关：地址本身是分发器，播放器自己跟随跳转
  // HYW 对咪咕回的是它自己的中转 /api/music/proxy?platform=mg&url=<咪咕CDN>，
  // 直接 200 吐音频流而不是 302。host 不在音乐 CDN 白名单里，但链是真的 ——
  // 之前一律按"非音乐CDN"丢掉，咪咕就只剩跨平台一条路
  if (/\/api\/music\/proxy\?/i.test(u)) return true
  const noQuery = u.split('?')[0]
  const host = (noQuery.split('/')[2] || '').toLowerCase()
  if (!host || !CDN_HOST.test(host)) return false
  return AUDIO_EXT.test(noQuery)
}

// 直链判定：路径本身带音频扩展名，播放器能直接 Range 取、能显示时长、
// 洛雪源测试器也能一眼认出格式。中转形态（/api/music/proxy?url=<CDN直链>）
// 不满足，同档位时优先选直链的那个。
const isDirectUrl = (u) => AUDIO_EXT.test(String(u || '').split('?')[0])

const norm = (s) =>
  String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\\u0026|&amp;/gi, '&')
    .toLowerCase()
    .replace(/[\s\-_·・.,，。()（）[\]【】'"、/|]/g, '')

// 目标本身是录音室版时，候选里的 Live / 伴奏 / DJ 一律不要。
// 中文平台的标记词必须一起列：酷狗会把音乐会 Live 版标题写成"现场"
// 目标本身是录音室版时，候选里的 Live / 伴奏 / DJ 一律不要。
// 词表是被酷我/酷狗的命名方式一条条打出来的：
//   "晴天 (KTV版伴奏)" / "晴天 (纯净版) (伴奏)" / "晴天(抒情钢琴版)" /
//   "晴天（吉他弹唱）Cover" / "晴天 (0.8x)" / "晴天 (DJ阿lo版)"
// 词表是被酷我/酷狗的命名方式一条条打出来的。实测漏网的两种：
//   "再也没有⪼ars to your beautiful (KJ炸鸡 prohouse mashup)" —— mashup 拼接曲
//   "晴天 (女声版)" / "晴天 (降速版)" —— 换人、变速
// 这类标题都能"包含"原歌名，光靠包含判断拦不住
const BADWORD = /(live|伴奏|remix|mashup|串烧|混音|dj.{0,8}版|翻唱|karaoke|inst\.|instrumental|纯音乐|片段|剪辑|铃声|现场|音乐会|演唱会|cover|ktv|弹唱|吉他版|钢琴版|八音盒|0\.8x|加速版|降速版|慢摇|清唱|童声|女声版|男声版|口哨|笛子|二胡|古筝版)/i

const artistHit = (a, b) => {
  const cut = (s) =>
    String(s || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .split(/[&,，、/|;；]+/)
      .map((x) => norm(x))
      .filter(Boolean)
  const A = cut(a)
  const B = cut(b)
  if (!A.length || !B.length) return false
  return A.some((x) => B.some((y) => x === y || x.includes(y) || y.includes(x)))
}

const toSec = (info) => {
  const d = Number(info && info.duration)
  if (d > 0) return d
  const m = /^(\d+):(\d{1,2})$/.exec(String((info && info.interval) || ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0
}

const pickId = (info, source) => {
  if (!info) return ''
  // 字段名必须对齐洛雪官方源的标准 musicInfo：
  //   酷我 -> songmid（数字 rid），网易 -> id，酷狗 -> hash，
  //   QQ -> songmid（字母 mid），咪咕 -> copyrightId
  // 之前 kw 只认 rid/info.id，而洛雪传的是 songmid —— 原链路永远拿不到
  // rid，秒级全灭后全靠跨平台搜索碰运气，这才是 KW 常年"接口挂了"的真因
  if (source === 'kw') return String(info.songmid || info.rid || info.id || '')
  if (source === 'wy') return String(info.id || info.songmid || '')
  if (source === 'kg') return String(info.hash || info.songmid || info.id || '')
  if (source === 'tx') return String(info.songmid || info.mid || info.id || '')
  if (source === 'mg') return String(info.copyrightId || info.songmid || info.id || '')
  return String(info.id || info.songmid || info.rid || info.hash || '')
}

/* ============================================================================
 * 跨平台：原平台取不到时，拿歌名+歌手去别家搜同名曲
 *
 * 三家搜索接口的字段名完全不同，先抹平成同一种候选结构再比较。
 * ==========================================================================*/

const searchKw = async (name, singer) => {
  // 三个必踩的点（都是实测出来的）：
  //   1) 字段名是 SONGNAME / ARTIST / DURATION，不是 NAME —— 之前取 NAME
  //      恒为空串，pickBest 的名字比对全部失败，跨平台搜索等于白跑
  //   2) 必须带 vipver=1。不带时官方版被 KTV/翻唱/片段挤到 30 条之外，
  //      带上是《晴天》官方版第 1 条（228908，FORMATS 含 ALFLAC）
  //   3) rn=20 太小，官方版常常在第 21-30 位
  const q = encodeURIComponent(((name || '') + ' ' + (singer || '')).trim())
  const u =
    KW_SEARCH +
    '?all=' + q + '&ft=music&itemset=web_2013&client=kt&pn=0&rn=30' +
    '&rformat=json&encoding=utf8&vipver=1'
  const body = await http(u, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2000 })
  const d = parseLoose(body)
  const list = ((d && d.abslist) || [])
    .filter((it) => it && (it.DC_TARGETID || it.MUSICRID))
    .map((it) => ({
      id: String(it.DC_TARGETID || String(it.MUSICRID || '').replace('MUSIC_', '')),
      title: String(it.SONGNAME || '').replace(/&nbsp;/g, ' ').trim(),
      artist: String(it.ARTIST || ''),
      sec: Number(it.DURATION) || 0,
      hq: /ALFLAC|FLAC/i.test(String(it.FORMATS || '')),
    }))
  // 诊断：只在"解析不出东西"或"首条不可用"时才打。
  // 手机端"酷我 无可用同名曲"有两种完全不同的成因，只有这行能区分：
  //   abslist 0 / 过滤后 0  -> 没解析出来（字段名或编码问题）
  //   过滤后 30 但 title 空 / hq=false -> 解析出来了但字段对不上
  //   有 30 条且首条正常，但 norm() 归一化后是空串 -> 正则把汉字也删了
  // 正常时不打，七档测试下来一行都不多
  if (!list.length || !list[0].title || !list[0].hq) {
    const f = d && d.abslist && d.abslist[0]
    log(
      '酷我搜索异常: abslist',
      (d && d.abslist && d.abslist.length) || 0,
      '过滤后',
      list.length,
      '首条',
      f ? JSON.stringify(String(f.SONGNAME || f.NAME || '').slice(0, 10)) : 'null',
      'norm后',
      f ? JSON.stringify(norm(String(f.SONGNAME || f.NAME || '')).slice(0, 10)) : '',
      'hq',
      list[0] ? list[0].hq : false
    )
  }
  return list
}

const searchWy = async (name, singer) => {
  // 网易有三条搜索入口，按"当前可用性"排序，不是按理论质量：
  //   1) /api/search/get      —— 不限频，300ms 稳定回包
  //   2) /api/cloudsearch/pc  —— 带 hr / fl 字段，能预判这首有没有无损
  //   3) gdstudio 聚合        —— 与取链同源，但常 2~3 秒
  //
  // 原来用的是 /api/search/get/web，2026-11 起它对连续调用直接回
  // {code:405,"操作频繁，请稍候再试"}。洛雪七档串行问下来第一档就撞上，
  // 跨平台的网易通道整条空掉 —— WY 平台自己的 flac 失败也是这个原因
  const variants = singer ? [name + ' - ' + singer, name + ' ' + singer, name] : [name]

  for (let i = 0; i < variants.length; i++) {
    const q = variants[i]

    for (let k = 0; k < 2; k++) {
      const base = k === 0 ? WY_SEARCH : WY_SEARCH2
      const body = await http(base + '?s=' + encodeURIComponent(q) + '&type=1&offset=0&limit=30', {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' },
        timeout: 2000,
      })
      const songs = (body && body.result && body.result.songs) || []
      const list = songs
        .map((x) => {
          // 两套接口字段名不同：search/get 给 artists/duration，
          // cloudsearch 给 ar/dt；hr 存在说明这首有 Hi-Res
          const ar = x.artists || x.ar || []
          return {
            id: String(x.id || ''),
            title: String(x.name || ''),
            artist: ar.map((a) => a.name || '').join('/'),
            sec: Math.round((Number(x.duration || x.dt) || 0) / 1000),
            hq: true,
            // 有 hr/fl 字段时能提前知道这首有没有无损；没有就交给网关实测
            unknown: !x.hr && !x.privilege,
          }
        })
        .filter((x) => x.id)
      if (list.length) return list
    }

    // 第三源：gdstudio 聚合搜索（无时长字段，sec 填 0 交给 pickBest 跳过校验）
    const g = await http(
      GD_SEARCH + '?types=search&source=netease&name=' + encodeURIComponent(q) + '&count=30&pages=1',
      { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 2000 }
    )
    if (Array.isArray(g) && g.length) {
      const gl = g
        .filter((x) => x && x.id)
        .map((x) => ({
          id: String(x.id),
          title: String(x.name || ''),
          artist: (x.artist || []).join('/'),
          sec: 0,
          hq: true,
          unknown: true,
        }))
      if (gl.length) return gl
    }
  }
  return []
}

const searchKg = async (name, singer) => {
  const kw = encodeURIComponent(((name || '') + ' ' + (singer || '')).trim())
  const u =
    KG_SEARCH +
    '?keyword=' +
    kw +
    '&page=1&pagesize=20&platform=WebFilter&tag=em&filter=2&iscorrection=1&privilege_filter=0'
  const body = await http(u, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', Cookie: 'kg_mid=2333' },
    timeout: 2000,
  })
  const list = ((body && body.data) || {}).lists || []
  return list
    .filter((x) => x && x.FileHash)
    .map((x) => ({
      id: String(x.FileHash),
      title: String(x.SongName || ''),
      artist: String(x.SingerName || ''),
      sec: Number(x.Duration) || 0,
      // Privilege=10（VIP 标记）不能信：实测《晴天》标 10，trackercdn 照样给
      // 30MB FLAC。之前在这里过滤，把能拿无损的曲全判死了 —— 交给取链阶段，
      // status=2 / 降级 mp3 让 trackercdn 自己说话
      hq: true,
    }))
}

// QQ 搜索：两条通道
//
//  1) c.y.qq.com/soso/fcgi-bin/client_search_cp —— 官方匿名接口，不需要任何
//     cookie，命中率最高。缺点是会限频，连打几发就回 500 空响应（实测
//     洛雪测试器一轮七档刚好会撞上）。
//  2) api.vkeys.cn/v2/music/tencent —— 第三方，回包字段干净（mid/song/singer），
//     500ms 稳定，但要带 num 参数。作为 1 的兜底。
//
// 只有 mid，没有别的平台 id —— 取链交给 hyw / aacab。
const searchQq = async (name, singer) => {
  const q = ((name || '') + ' ' + (singer || '')).trim()

  // 第一条：官方匿名接口
  const u = QQ_SEARCH + '?w=' + encodeURIComponent(q) + '&format=json&n=30&p=1&cr=1&new_json=1&t=0'
  const body = await http(u, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://y.qq.com/' },
    timeout: 1800,
  })
  const songs = (body && body.data && body.data.song && body.data.song.list) || []
  const list = songs
    .filter((x) => x && x.mid)
    .map((x) => ({
      id: String(x.mid),
      title: String(x.name || x.title || ''),
      artist: (x.singer || []).map((s) => s.name || '').join('/'),
      sec: Number(x.interval) || 0,
      hq: true, // QQ 的可用档位要问过 aacab/hyw 才知道
    }))
  if (list.length) return list

  // 第二条：vkeys 兜底。它 interval 是 "4分6秒" 这种中文，解析出来给 pickBest 校验
  const v = await http('https://api.vkeys.cn/v2/music/tencent?word=' + encodeURIComponent(q) + '&num=20', {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 1800,
  })
  const arr = (v && v.data) || []
  return arr
    .filter((x) => x && x.mid)
    .map((x) => {
      const m = /(\d+)\s*分\s*(\d+)/.exec(String(x.interval || ''))
      return {
        id: String(x.mid),
        title: String(x.song || ''),
        artist: String(x.singer || ''),
        sec: m ? Number(m[1]) * 60 + Number(m[2]) : 0,
        hq: true,
      }
    })
}

const SEARCHERS = { kw: searchKw, wy: searchWy, kg: searchKg, qq: searchQq }

const CROSS = CROSS_CFG.map((c) => ({
  label: c.label,
  as: c.as,
  gws: c.gws || [c.gw], // 兼容旧的单网关写法
  search: SEARCHERS[c.searcher],
}))

// 从一批候选里挑一个。返回 null 表示这批里没有能用的
const pickBest = (list, name, singer, sec) => {
  const n = norm(name)
  let best = null

  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    if (!it || !it.id) continue
    const t = norm(it.title)
    if (!t || !n) continue

    // 标题必须相等或互相包含（"淘汰" ↔ "淘汰 (Live)" 会被下一行拦掉）
    if (!(t === n || t.includes(n) || n.includes(t))) continue
    if (!BADWORD.test(name) && BADWORD.test(it.title)) continue
    // 标题长度暴涨 = 串烧 / mashup / 组曲。这类标题里一定包含原歌名，
    // 前面的判断拦不住，只能按长度比例砍：
    //   "再也没有" 4 字 -> "再也没有⪼ars to your beautiful (KJ炸鸡 mashup)" 40+ 字
    // 留 1.8 倍 + 6 字的余量，"晴天 (Live)"、"晴天 - 周杰伦" 这类正常扩展能过
    if (n.length >= 2 && t.length > n.length * 1.8 + 6) continue
    if (!artistHit(it.artist, singer)) continue

    // 时长只当排序权重，不当硬门槛。同一个录音室版本，酷我按整轨报 285 秒、
    // 酷狗按音频报 269 秒，差 16 秒是常态 —— 卡 10 秒会把正确版本全滤掉。
    // 只有差到 45 秒以上才认为不是同一首（那是串烧、组曲、合集）。
    // 候选没报时长（gdstudio 搜索就没有）时跳过校验，只信标题+歌手
    const d = sec && it.sec ? Math.abs(it.sec - sec) : 0
    if (sec && it.sec && d > 25) continue

    // 酷我 FORMATS 里没有 ALFLAC 就是真没有：实测 485806788《平凡之路》标的是
    // AAC48|MP3128|MP3H，请求 flac 只回 320k mp3。网易不知道，放行
    if (!it.hq && !it.unknown) continue

    const score = (t === n ? 40 : 20) + Math.max(0, 30 - d)
    if (!best || score > best.score) best = { cand: it, score }
  }
  return best
}

// 搜到一次就记住。降档时会连问三个档位，不记就会把同一次搜索打三遍
const crossCache = new Map()
// 纯搜索结果缓存。和 crossCache 不同，它只存"这四家分别搜到了哪些候选"，
// 不带质量结论 —— 所以 flac 层搜过的结果，320k 层和 128k 层可以直接复用。
// 洛雪七档测试 = 七次 resolveLayer，以前每一档都把四家搜索重打一遍，
// 光搜索就是 7×4=28 个请求，把 c.y.qq.com / search.kuwo.cn 全打进限频，
// 后面几档反而更慢。现在同一首歌一轮只真搜一次，其余 6 档秒回。
const searchCache = new Map()
const SEARCH_TTL = 30 * 60 * 1000
// 跨平台结果缓存 30 分钟：搜索是四家 HTTP 请求，同一首歌反复点不能反复搜
const CROSS_TTL = 30 * 60 * 1000

const searchOnce = async (label, name, singer, fn) => {
  const k = label + '|' + norm(name) + '|' + norm(singer)
  const c = searchCache.get(k)
  if (c && Date.now() - c.t < SEARCH_TTL) return c.list
  const list = await fn()
  // 空结果也缓存，但只留 60 秒 —— 平台抖一下回空，30 分钟锁死就再也搜不到了
  if (list && list.length) searchCache.set(k, { list, t: Date.now() })
  else searchCache.set(k, { list: [], t: Date.now() - SEARCH_TTL + 60 * 1000 })
  return list
}

// 取一份网关通用的元信息。HYW 靠 name + singer 反查它自己的库，
// 只给 id 会大幅降低命中率；interval 用来核验时长，防止拿到同名不同版本
const metaOf = (info) => {
  const sec = toSec(info)
  return {
    name: String((info && info.name) || ''),
    singer: String((info && info.singer) || ''),
    interval: sec ? Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2) : '',
    sec: sec,
  }
}

/* 跨平台兜底：拿歌名 + 歌手去别家搜同名曲，一律按 flac 要。
 *
 * 关键改动（v2.5.0）：调用时机从"原平台完全失败"改成"原平台拿到的音质
 * 不达标"。酷狗 trackercdn 对 VIP 曲永远回 128k —— 那也算"成功"，
 * 旧逻辑于是永远轮不到跨平台，用户在酷狗平台点无损永远只有 128k，
 * 而 cwww 明明能给同一个曲目 52.83MB 真 FLAC。
 *
 * 搜索段四家并发（洛雪测试器 5 秒就放弃，串行必超时），
 * 命中后所有平台的候选混进一次竞速，由 raceAll 按真实 tier 择优。 */
const tryCross = async (source, meta, q, wantTier, hardMs) => {
  const quality = q || 'flac'
  const need = wantTier || 3
  const ck = source + '|' + norm(meta.name) + '|' + norm(meta.singer) + '|' + meta.sec + '|' + quality
  const cached = crossCache.get(ck)
  if (cached && Date.now() - cached.t < CROSS_TTL) return cached

  // 跳过与源平台相同的项 —— 在酷狗平台里再去酷狗搜一遍没有意义
  const pool = CROSS.filter((c) => c.as !== source)
  if (!pool.length) return null

  // 逐家"搜索 + 取链"各自推进，任何一家先给出真无损立刻收工。
  // 之前是 Promise.all 等四家搜索全回来再统一取链 —— 慢的那家（网易
  // gdstudio 常 2 秒）把总耗时拖到 5 秒以上，洛雪测试器 5 秒就判失败。
  // 现在酷我（最快，0.5 秒搜索 + 0.2 秒取链）一家命中就出结果。
  const got = await new Promise((done) => {
    let left = pool.length
    let best = null
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      clearTimeout(hard)
      if (settle) clearTimeout(settle)
      done(v)
    }
    // 整体硬超时。必须比外层 raceAll 的硬上限短 —— 否则外层先收工，
    // 这条跨平台通道跑到一半就被丢掉，等于白搜（以前 3000 配 2400
    // 就是这个问题：跨平台永远出不了结果，酷狗/咪咕因此全档失败）
    const hard = setTimeout(() => finish(best), hardMs || 1800)

    // 降级收工计时器：手里一旦有了"够用但不是目标档"的结果，就从那一刻
    // 起再等 1.2 秒。必须用计时器而不是在回包里判断 elapsed ——
    // 慢通道回来后如果没有后续事件，判断就永远不会再被触发，
    // 结果仍旧干等到 3 秒硬超时（酷狗/咪咕只剩一条低档通道时就是这样）
    let settle = null
    const armSettle = () => {
      if (settle || !best) return
      settle = setTimeout(() => finish(best), 1200)
    }

    pool.forEach((src) => {
      ;(async () => {
        try {
          let hit = pickBest(
            await searchOnce(src.label, meta.name, meta.singer || '', () =>
              src.search(meta.name, meta.singer)
            ),
            meta.name,
            meta.singer,
            meta.sec
          )

          // 带歌手搜不到就只搜歌名 —— 有些歌的演唱者字段是"群星"或者挂了一堆
          // 合作者，带歌手反而把原版挤出前 30 条
          if (!hit && meta.singer) {
            hit = pickBest(
              await searchOnce(src.label + '#n', meta.name, '', () => src.search(meta.name, '')),
              meta.name,
              meta.singer,
              meta.sec
            )
          }

          if (!hit) {
            log(src.label, '无可用同名曲', meta.name, meta.singer)
          } else {
            log(src.label, '匹配', meta.name, '->', hit.cand.title, hit.cand.sec + 's')
            const cands = src.gws
              .filter((g) => GW[g])
              .map((g) => ({
                gw: g,
                tier: GW[g].tier || 2,
                params: {
                  source: src.as,
                  id: hit.cand.id,
                  quality: quality,
                  name: meta.name,
                  singer: meta.singer,
                  interval: meta.interval,
                  sec: meta.sec,
                },
              }))
            // 内部取链给 1.2 秒：跨平台整体只有 1.7~1.9 秒，
            // 这里如果按默认 2.4 秒跑，外层收工时它还没回，搜到的候选白费。
            // 上限还要压在本轮预算内：预算只有 1.1 秒时（低档直连把时间
            // 吃掉后），1.2 秒的内部 race 会被外层硬超时整锅丢掉 ——
            // mg 128k 实测「酷我 tier1 已到手却被判整层无结果」就是这么来的。
            // wantTier=need：这一层够用就 400ms 快速收工，别陪着慢通道
            // （hyw 超时 1.6s）干等
            const one = await raceAll(cands, null, null, Math.max(400, Math.min(1200, (hardMs || 1800) - 200)), need)
            if (one) {
              one.from = '跨平台'
              log('跨平台', src.label, '命中 tier', one.tier)
              if (!best || one.tier > best.tier) best = one
              // 够这一层用了就不必再等同行的另外几家
              if (best.tier >= need) return finish(best)
              // 不够这一层，先记下"再等 1.2 秒就交这个"
              armSettle()
            }
          }
        } catch (e) {
          log(src.label, '跨平台异常', String(e && e.message).slice(0, 40))
        }
        if (--left === 0) finish(best)
      })()
    })
  })

  // 够本层门槛才落缓存。key 里带 quality，所以 320k 的结果不会串到
  // 无损那一层去 —— v2.5 那种"一次低档 cross 锁死后面七档"不会再出现。
  // 无损留 30 分钟，低档留 5 分钟：低档结果本来就是网关抖动的产物
  if (got && got.tier >= need) {
    crossCache.set(ck, { ...got, from: '跨平台', t: Date.now() })
  }
  return got || null
}

/* ============================================================================
 * 调度
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * 档位映射 / 期望等级 / 降级阶梯
 *
 * 洛雪会按平台元数据把档位逐个问过来，除了 128k/320k/flac 之外还有
 * hires / atmos / atmos_plus / master / flac24bit 这些"高于无损"的档。
 * 老版本的表里只有四个键，查不到的档直接落到 `QMAP[want] || '320k'`，
 * 于是用户点"母带"实际发出去的是 320k 请求、拿到 320k 就判达标收工 ——
 * 这就是"选高音质反而降到 320K/128K"的全部原因。
 *
 * 现在的规则，按用户要求固定：
 *   请求任何高于 flac 的档 -> 原档（只有 HYW 真支持）与 flac 一起发，
 *                              flac 也不行才 320k，再不行才 128k
 *   请求 flac             -> flac -> 320k -> 128k
 *   请求 320k             -> 320k（先要它自己）-> flac（往上补）-> 128k
 *   请求 128k             -> 128k -> 320k -> flac
 *
 * need 是"这一档最低可接受的真实等级"，不达标就继续往上找。
 * -------------------------------------------------------------------------*/
const QMAP = {
  master: 'master',
  atmos_plus: 'atmos_plus',
  atmos: 'atmos',
  hires: 'hires',
  flac24bit: 'flac24bit',
  flac: 'flac',
  '320k': '320k',
  '128k': '128k',
}

const WANT_TIER = {
  master: 3,
  atmos_plus: 3,
  atmos: 3,
  hires: 3,
  flac24bit: 3,
  flac: 3,
  '320k': 2,
  '128k': 1,
}

// AIM_TIER：竞速"等不等得起"的门槛，和 need（最低可接受）分开。
//
// need 永远是"这一档最低可接受的真实等级"（master 档收到 16bit flac 算
// 达标，只是降级），而 AIM 是"值得等到什么时候"：点母带/全景声/Hi-Res
// 时值得等 tier4 的通道跑完再收工。两者共用一个值的后果是：flac 先回来
// 就触发"已够档收工"，tier4 的母带请求被自己掐掉 —— 点母带永远拿 flac。
const AIM_TIER = {
  master: 4,
  atmos_plus: 4,
  atmos: 4,
  hires: 4,
  flac24bit: 4,
  flac: 3,
  '320k': 2,
  '128k': 1,
}

const LADDER = {
  master: ['master', 'flac', '320k', '128k'],
  atmos_plus: ['atmos_plus', 'flac', '320k', '128k'],
  atmos: ['atmos', 'flac', '320k', '128k'],
  hires: ['hires', 'flac', '320k', '128k'],
  flac24bit: ['flac24bit', 'flac', '320k', '128k'],
  flac: ['flac', '320k', '128k'],
  '320k': ['320k', 'flac', '128k'],
  '128k': ['128k', '320k', 'flac'],
}

// 运行时熔断表：gwId -> { fails, until }。见 askGw 内注释
const breaker = {}
const LAST_CALL = {}
const GW_QUEUE = {}
// 每条限频网关当前有几个请求在排队。超过 2 个就放弃本档 —— 见 askGw
const GW_PENDING = {}

// 单个网关取链。返回 { url, tier, sizeMB } 或 null
const askGw = async (gwId, params) => {
  const gw = GW[gwId]
  if (!gw) return null
  if (DISABLED_GW.indexOf(gwId) >= 0) return null
  // 运行时熔断：CI 的禁用名单是机房视角靠不住，这里以用户本机真实请求为准。
  // 网关连续 3 次"无响应"（超时/网络错误）就本地拉黑 10 分钟，
  // 期间不参与竞速 —— hyw 挂掉时每个请求白等 9s 超时、把洛雪测试器 5s
  // 窗口全拖死的问题就是这么解的。成功一次立即清零。
  // 注意："无链接"（VIP 无版权 status=2）不算故障 —— 那是曲目的客观状态，
  // 计数会把 cwww 这种好网关在测试 VIP 曲时误拉黑
  if (breaker[gwId]) {
    const b = breaker[gwId]
    if (Date.now() > b.until) delete breaker[gwId]
    else return null
  }
  let req
  try {
    req = gw.build(params)
  } catch (e) {
    log(gw.label, '构造请求失败', String(e && e.message))
    return null
  }
  const t0 = Date.now()
  // 有限频的网关先排队。a.aa.cab 明文回 min_interval_ms=200，两发并发就
  // 直接"请求过于频繁"，此后它对该曲彻底沉默 —— 而它正是 QQ 平台
  // HYW 挂掉时唯一的兜底
  if (gw.minGap) {
    // 必须是串行队列，不能只是"看看上次多久前"。并发请求同时进到这个分支，
    // 读到的 prev 是同一个值，于是全部同时放行 —— 实测就是这么撞上
    // "请求过于频繁"的。挂到同一条 promise 链上才真正排队
    //
    // 排队的上限只能按"前面有几个在等"算，不能按"要等多少毫秒"算：
    // minGap 本身就是 500ms，任何 wait 都到不了 800，按时间判断等于没判断
    // （上一版就是这么写错的，线上实测耗时仍然从 2367ms 递增到 5310ms）。
    // 洛雪七档连着问 → 前面已经有 2 个在排队就放弃本档，外层还有别的通道
    const queued = GW_PENDING[gwId] || 0
    if (queued >= 2) {
      log(gw.label, params.source, params.quality, '限频排队已满(2)，本档跳过')
      return null
    }
    GW_PENDING[gwId] = queued + 1
    const prevChain = GW_QUEUE[gwId] || Promise.resolve()
    const mine = prevChain.then(async () => {
      const wait = gw.minGap - (Date.now() - (LAST_CALL[gwId] || 0))
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      LAST_CALL[gwId] = Date.now()
    })
    GW_QUEUE[gwId] = mine.catch(() => {})
    await mine
    GW_PENDING[gwId] = (GW_PENDING[gwId] || 1) - 1
  }
  const body = await http(req.url, req.options)
  if (!body) {
    const b = breaker[gwId] || (breaker[gwId] = { fails: 0, until: 0 })
    b.fails++
    // 阈值从 3 提到 5、冷却从 10 分钟压到 2 分钟：洛雪测试器一口气问七档，
    // 同一网关瞬间挨好几发，3 次就拉黑会让后面几档直接无网关可用
    if (b.fails >= 5) {
      b.until = Date.now() + 2 * 60 * 1000
      log('熔断', gw.label, '连续 5 次无响应，暂停 2 分钟')
    } else {
      log(gw.label, params.source, params.quality, '无响应', (Date.now() - t0) + 'ms', '(' + b.fails + '/5)')
    }
    return null
  }
  breaker[gwId] && (breaker[gwId].fails = 0)
  let r = null
  try {
    // 第三参是这次真实请求。有限频网关（wymeting 的 Range 探测）只读文件头
    // 判档，URL 就是请求地址本身，需要它回填
    r = gw.pick(body, params, req)
  } catch (e) {
    r = null
  }
  if (!r) {
    log(gw.label, params.source, params.quality, '无链接', (Date.now() - t0) + 'ms', JSON.stringify(body).slice(0, 80))
    return null
  }
  // pick 允许直接返回字符串（老写法），统一成对象
  if (typeof r === 'string') r = { url: r, tier: gw.tier || 2 }
  // 只有文件头、没有落地地址的网关（wymeting）用请求地址本身当播放地址
  if (r && !r.url) r.url = req.url
  if (!isReal(r.url, gw.stream)) {
    log(gw.label, params.source, '非音乐CDN，丢弃', String(r.url).slice(0, 60))
    return null
  }
  r.gw = gwId
  r.tier = Number(r.tier) || 1
  // 成功也要留痕。以前只在失败时打日志，用户贴过来的日志里只有"失败"，
  // 看不出到底是"通道挂了"还是"通道给了但被我降级丢掉了" —— 酷我掉 320k
  // 那个 bug 就是靠猜才拖了三轮。现在每条通道的最终裁决都在日志里：
  //   ✔ c.wwwweb.top  kw flac -> tier3 52.8MB 235ms
  log(
    '✔',
    gw.label,
    params.source,
    params.quality,
    '→ tier' + r.tier,
    (r.sizeMB ? r.sizeMB + 'MB' : ''),
    Date.now() - t0 + 'ms'
  )
  return r
}

/* ---------------------------------------------------------------------------
 * 多路并发择优
 *
 * 同一首歌同时问所有网关。规则按"这一轮只跑一次"重新算过：
 *   1) 已经有全场最高档的结果        -> 再等 400ms 收同档更大体积的，收工
 *   2) 只拿到次级，但还有高档在路上   -> 等到 3400ms（要的是真无损，值得等）
 *   3) 没有高档通道                 -> 1000ms
 *   4) 硬上限 3600ms
 *
 * 为什么敢等到 3.4 秒：解析结果按"需求等级"整层缓存，洛雪那套七档串行测试
 * 只会真正算一次（hq 层一次 + 320k/128k 各一次），第一档多等两秒换后面
 * 六档全秒回，总耗时反而从 14 秒降到 3~4 秒。v2.6.1 是反过来做的：
 * 每档只给 1.8 秒，七档各跑一遍，于是每一档都在"网关刚热身就被掐断"的
 * 状态下取结果，看到的就是什么都拿不到或者全掉 320k。
 * -------------------------------------------------------------------------*/
// 硬上限压到 2.4 秒。实测洛雪源测试器单档只给约 3 秒（日志里 master
// 00:02:47 发起、00:02:50 就判"获取 URL 失败"，5 个高档位在同一秒集体失败），
// 而以前这里是 3600 —— 我们还在跑，洛雪早就放弃了，结果一律是失败。
// 现在窗口必须短于洛雪的，宁可先交 320k，也不能交不出来。
const RACE_HARD = 2400
// 低档 2.2 秒。五平台同时跑时跨平台要"搜索 + 取链"两跳，2.2 秒是
// 搜索命中后还有 1 秒取链的底线
const RACE_HARD_LOW = 2200

// 阶段一（只问本平台）的硬上限。必须明显短于整层窗口，否则本平台一挂就
// 把时间吃光，阶段二（跨源）根本来不及跑。
//   2400 - 1300 - 100 = 1000ms 留给跨源（酷我 0.5s 搜索 + 0.2s 取链够用）
//   2200 - 1000 - 100 = 1100ms 留给低档跨源
// 候选全部快速失败时 raceAll 会立刻收工，不会真等满这个值；
// 只有"某条通道卡住不返回"才会吃满 —— 那种情况本来也等不出结果
const DIRECT_HARD = 1300
const DIRECT_HARD_LOW = 1000

const raceAll = (cands, onLate, extraP, hardMs, wantTier) =>
  new Promise((resolve) => {
    // 每个候选带上「它最高能给到几档」。收工判断必须知道还有没有高档候选
    // 在路上 —— 只按"手里已经有 320k 就再等 1.1 秒"是会主动丢结果的：
    // cwww 的 FLAC 只要慢过 1.1 秒就被掐断，交出去的是 kwofficial 的 320k。
    // 这正是 2.10.0 的症状（酷我七档全是 10.29MB 的 320k），而通道本身
    // 实测 235ms 就能给 52.8MB 真无损 —— 是我自己不要的
    const jobs = cands.map((c) => ({ tier: c.tier || 2, run: () => askGw(c.gw, c.params) }))
    // 跨平台那条通道当成一个额外候选参与同一轮竞速，不另开等待逻辑
    if (extraP) jobs.push({ tier: 3, run: () => extraP })
    if (!jobs.length) return resolve(null)

    let best = null
    let pending = jobs.length
    // 还没回来的高档候选数。>0 表示"更值的结果还在路上"，这时提前收工
    // 等于主动降级。归零后才能按档位快速收工
    let highPending = jobs.filter((j) => j.tier >= 3).length
    let done = false
    let acc = null

    const maxTier =
      cands.reduce((m, c) => Math.max(m, c.tier || 0), 0) || (extraP ? 3 : 1)
    const t0 = Date.now()

    const finish = () => {
      if (done) return
      done = true
      if (acc) clearTimeout(acc)
      clearTimeout(hard)
      resolve(best)
    }

    // 每次 best 变化重设"什么时候可以收工"
    const schedule = () => {
      if (acc) clearTimeout(acc)
      if (!best) return
      let target
      // 已经够这一层用了就直接收 —— 点 320k 的人不需要我们再等无损回来
      if (best.tier >= maxTier || (wantTier && best.tier >= wantTier)) target = 400
      // 手里有 320k（或更低），但还有能出无损的通道没回 —— 等到硬上限。
      // 这不是"多等一会儿更保险"，而是只有这样才能拿到无损：cwww /
      // wymeting 都在 300ms 量级，用户侧偶发抖动到 1~2 秒很常见，
      // 固定等 1.1 秒等于把"抖动"直接判成"通道挂了"
      else if (highPending > 0) target = hardMs || RACE_HARD
      // 高档候选全都回来了，剩下的都是同级或更低 —— 快速收工
      else if (best.tier >= 2) target = 500
      else target = 700
      const remain = Math.max(0, target - (Date.now() - t0))
      acc = setTimeout(finish, remain)
    }

    const better = (r) => {
      if (!best) return true
      if (r.tier !== best.tier) return r.tier > best.tier
      // 同档再比"是不是直链"。HYW 的 /api/music/proxy?platform=x&url=y 是
      // 中转流：无 Content-Length、URL 里没有扩展名，洛雪的源测试器会把
      // 它判成"疑似FLAC"（拿得到 30MB 的 flac 却标 FAIL）。
      // 内层本来就是 CDN 直链，能直连就直连 —— 体积、扩展名、拖动进度都正常。
      const rd = isDirectUrl(r.url)
      const bd = isDirectUrl(best.url)
      if (rd !== bd) return rd
      return (r.sizeMB || 0) > (best.sizeMB || 0)
    }

    // 低档也有跨平台兜底，窗口要够它跑完"搜索 + 取链"两跳
    const hard = setTimeout(finish, hardMs || RACE_HARD)

    jobs.forEach((job) => {
      Promise.resolve()
        .then(job.run)
        .then((r) => {
          pending--
          // 高档候选回来了（不论成败）都要重算收工时间：
          // 最后一个能出无损的通道一旦结束，就没必要再干等到硬上限
          if (job.tier >= 3 && highPending > 0) highPending--
          if (r && better(r)) {
            if (done) {
              // 已经返回了，好结果迟到 -> 补进缓存，下一档直接用
              if (onLate) onLate(r)
            } else {
              best = r
              schedule()
            }
          } else if (!done && best) {
            schedule()
          }
          if (pending === 0 && !done) finish()
        })
        .catch(() => {
          pending--
          if (job.tier >= 3 && highPending > 0) highPending--
          if (!done && best) schedule()
          if (pending === 0 && !done) finish()
        })
    })
  })

/* ---------------------------------------------------------------------------
 * 结果缓存
 *
 * 按"需求等级"分三层：hq（无损及以上）/ 320k / 128k。
 * 三层各自只解析一次，洛雪七档串行问下来 = 三次解析 + 四次直接命中。
 *
 * 三个 TTL 各有理由：
 *   TTL          无损结果留 10 分钟，这是稳定事实
 *   TTL_DEGRADED 只拿到 320k/128k 的 hq 结果留 2 分钟 —— 留短了会让七档
 *                重复打网关，留长了用户会以为这个平台永远没有无损。
 *                2 分钟刚好盖住一轮测试，又不耽误下次点播重新争取
 *   TTL_EMPTY    整层解析全空留 20 秒。没有它，七档全失败会连打七轮网关，
 *                把本来只是抖一下的通道打成真熔断
 * -------------------------------------------------------------------------*/
const cache = new Map()
const inflight = new Map()
const TTL = 10 * 60 * 1000
const TTL_DEGRADED = 120 * 1000
// 空结果只锁 2 秒。8 秒太久了：洛雪七档是挨着问的，第一档解析空掉之后
// 后面五个高档位全部命中这个空缓存"秒回失败"（用户日志里 00:02:50 那一秒
// 连出 10 条"获取 URL 失败"就是这么来的）。2 秒只够挡住同一档的重复请求，
// 不会把后面几档的希望一起锁死
const TTL_EMPTY = 2 * 1000

const cacheKey = (source, info, need, want) =>
  source +
  '|' +
  pickId(info, source || '') +
  '|' +
  norm((info && info.name) || '') +
  '|' +
  // hq 桶按档位等级一分为二：hq4（母带/全景声/Hi-Res 共享）与 hq（flac）。
  // 不拆的话先播 flac（tier3 写进 hq）再点母带会直接命中这份 flac，老毛病
  // 回来；拆太细（hq:master/hq:atmos/...）则洛雪四个高档位各解析一遍，
  // 星海的 QPS 配额直接被打爆。tier4 的结果满足所有高档 want，同桶共享是对的
  (need >= 3
    ? AIM_TIER[want] >= 4
      ? 'hq4'
      : 'hq'
    : need === 2
      ? '320k'
      : '128k')

// 写入时比档位，低档结果不能覆盖已经拿到的高档结果；
// 空结果也不覆盖已有的可用结果（一次抖动不该毁掉 10 分钟的好缓存）
const putCache = (key, r) => {
  const cur = cache.get(key)
  if (cur && cur.url && (!r || !r.url)) return
  if (cur && cur.url && r && (cur.tier || 0) > (r.tier || 0)) return
  cache.set(
    key,
    r
      ? { url: r.url, tier: r.tier || 0, gw: r.gw, from: r.from, t: Date.now() }
      : { url: null, t: Date.now() }
  )
}

/* ---------------------------------------------------------------------------
 * 单层解析：把所有能给这一层的通道一次性问完
 *
 * 每个网关只问一次，问它在这个需求等级下能给出的最高档：
 *   普通网关   -> flac（要最高的，降级由 pick 之后的档位比较决定）
 *   only 网关  -> need>=2 问 320k，need==1 问 128k（酷我官方只认这两个）
 *
 * 调度分两阶段，本平台优先：
 *   阶段一 只问本平台直连。能给到这一层就直接交付，别家一概不碰。
 *   阶段二 本平台给不到（全空，或只给到更低档），才去别家搜同名曲。
 *
 * 以前是"need>=3 时跨源无条件并发"，理由是酷狗 trackercdn 对 VIP 曲只回
 * 128k、咪咕 hyw 只给 320k、QQ 无损是加密 mflac，直连物理上给不了无损，
 * 等它失败再开始搜等于白扔一到两秒。但代价被低估了：酷我跨源通道 400ms
 * 就回真 FLAC，永远是它赢 —— 于是腾讯/酷狗/咪咕的歌听起来其实全是酷我
 * 库里那份录音，现场版、重制版、时长都可能是另一版。省一两秒不值这个价。
 * -------------------------------------------------------------------------*/
const resolveLayer = async (source, info, need, want) => {
  const t0 = Date.now()
  // 竞速门槛：点母带/全景声/Hi-Res 时值得等 tier4 的通道跑完再收工
  const aim = AIM_TIER[want] || need
  const cfg = ROUTE[source] || { direct: [], search: true }
  const id = pickId(info, source)
  if (!id) return null

  const sec = toSec(info)
  const meta = {
    name: String((info && info.name) || ''),
    singer: String((info && info.singer) || ''),
    interval: sec ? Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2) : '',
    sec: sec,
  }

  const cands = []
  const used = {}
  ;(cfg.direct || []).forEach((r) => {
    // 需要 cookie 的网关，没配就跳过，别让它白跑一次必失败的请求
    if (r.needCookie && !USER_COOKIE[r.needCookie]) return
    const g = GW[r.gw]
    if (!g) return
    // 要哪一层就问哪一层。用户点 128k 却拉回 52MB 无损，是白白多下 40MB，
    // 手机流量下这一条比"音质不够"更容易被投诉
    let q = need >= 3 ? 'flac' : need === 2 ? '320k' : '128k'
    if (r.only && r.only.indexOf(q) < 0) {
      // 只支持低档的网关（酷我官方 only:['320k','128k']）在无损层也要进来，
      // 问它能给的最高档。以前是直接跳过，结果 cwww/hyw 一挂，无损层连
      // "有声音"的兜底都没有，洛雪直接报"获取 URL 失败"—— 用户看到的
      // 整列失败就是这么来的。现在它给 320k，raceAll 里比不过 flac 就
      // 自然降级，比什么都不给强
      q = r.only[0]
    }
    const mk = (gwId, quality) => ({
      gw: gwId,
      tier: g.tier || 2,
      params: {
        source: r.as,
        id: id,
        quality: quality,
        name: meta.name,
        singer: meta.singer,
        interval: meta.interval,
        sec: sec,
      },
    })
    // 原档候选先入列。限频网关的排队上限是 2（GW_PENDING），原档/flac/320k
    // 三条一起发必有一条被"限频排队已满"挤掉 —— v2.16.2 第一版把原档排最后，
    // 被挤掉的恰恰是它，点母带拿到的还是 flac。原档 > flac > 320k 保底，
    // 按这个优先级占坑。
    //
    // 高于 flac 的档位（母带/全景声/Hi-Res）只对认档位的网关（hiQ）发原档：
    // 目前只有星海 xh（真按档位回 quviper_clear/quviper_atmos）和 HYW
    // （服务端挂着账号池真按档位要）。其余网关 build 内部 normQ 会把原档
    // 收成 flac，发两条是重复请求。
    const wantRaw = !!(g.hiQ && need >= 3 && want && want !== 'flac')
    if (wantRaw && used[r.gw + '|' + want] === undefined) {
      used[r.gw + '|' + want] = 1
      cands.push(mk(r.gw, want))
    }
    if (used[r.gw + '|' + q]) return
    used[r.gw + '|' + q] = 1
    cands.push(mk(r.gw, q))
    // 保底：无损层对每个"能出无损"的网关同时再发一条 320k。
    //
    // 为什么必须这么做：实测这些网关对同一首曲，flac 请求会 410 / 403 /
    // 卡到超时，而 320k 请求 200~400ms 就回 —— 酷我要 VIP 版权才给 F000，
    // 但免费层永远有 M800。只发一条 flac 时，它一失败就该层全空，
    // 洛雪看到的是"五档全部获取 URL 失败"；双发之后最坏也是 1 秒内
    // 拿到 320k 降级返回，用户听得到声音。
    //
    // 只对 tier>=3 的网关注入 —— 本来就只出 320k 的（kwofficial/aacab）
    // 再发一条是纯浪费，还会撞限频。原档已占坑的网关也不再发（见上）
    if (!wantRaw && need >= 3 && (g.tier || 0) >= 3 && q === 'flac' && used[r.gw + '|320k'] === undefined) {
      used[r.gw + '|320k'] = 1
      cands.push(mk(r.gw, '320k'))
    }
  })

  // 三层都挂跨平台。低档以前只走直连，酷狗/咪咕/网易的低档一旦抖一下
  // 就直接没声（它们各自的低档通道本来就只剩一条：酷狗 trackercdn、
  // 咪咕 hyw 中转、网易 163 直链），而酷我的 320k/128k 一直是稳的
  const canCross = cfg.search !== false
  const q = need >= 3 ? 'flac' : need === 2 ? '320k' : '128k'

  const onLate = (late) => {
    // 迟到的真无损覆盖掉刚才那个降级结果 —— 后面几档立刻变成无损
    if (late && late.tier >= 3 && need >= 3) {
      putCache(cacheKey(source, info, 3, want), late)
      log('后台补更优', GW[late.gw] ? GW[late.gw].label : late.from || late.gw, 'tier', late.tier)
    }
  }

  // ---- 阶段一：本平台 ----
  const directHard = need >= 3 ? DIRECT_HARD : DIRECT_HARD_LOW
  // 竞速门槛传 aim 而不是 need：点母带时 aim=4，flac 先回来不会触发
  // "已够档收工"，会等 tier4 的原档通道跑完（或到硬上限）再交
  let got = cands.length ? await raceAll(cands, onLate, null, directHard, aim) : null

  if (got && got.tier >= need) {
    log('命中', source, GW[got.gw] ? GW[got.gw].label : got.from || got.gw, 'tier', got.tier, '本平台')
    return got
  }

  // ---- 阶段二：本平台这一层走不通，才跨源 ----
  const full = need >= 3 ? RACE_HARD : RACE_HARD_LOW
  const elapsed = Date.now() - t0
  if (canCross) {
    const budget = full - elapsed - 100
    if (budget >= 600) {
      log(
        '本平台未达 tier',
        need,
        got ? '现有 tier ' + got.tier : '无结果',
        '转跨源，预算',
        budget + 'ms'
      )
      const cr = await tryCross(source, meta, q, need, budget)
      // 跨源只在"更好"时才采用。本平台已经拿到 320k，别家再来一份 320k
      // 不换 —— 同档位当然用本平台自己那份，曲库版本更对
      if (cr && (!got || cr.tier > got.tier)) got = cr
    } else {
      log('本平台未达 tier', need, '窗口已用尽', elapsed + 'ms', '不做跨源')
    }
  }

  if (got) {
    log('命中', source, GW[got.gw] ? GW[got.gw].label : got.from || got.gw, 'tier', got.tier)
  } else {
    // 整层全空。这是"获取 URL 失败"的唯一来源，打出来才能定位是哪一层、
    // 用了多久、走了几条直连 —— 只报"失败"的话日志里什么都看不出来
    log('整层无结果', source, 'need', need, '直连', cands.length, '路', (Date.now() - t0) + 'ms')
  }
  return got
}

const resolve = async (source, info, want) => {
  const need = WANT_TIER[want] || 1
  const aim = AIM_TIER[want] || need
  const key = cacheKey(source, info, need, want)

  const hit = cache.get(key)
  if (hit) {
    const ttl = !hit.url ? TTL_EMPTY : hit.tier >= 3 ? TTL : TTL_DEGRADED
    if (Date.now() - hit.t < ttl) {
      if (!hit.url) {
        log('短时无可用源', source, want, '（2 秒内不重试）')
        return null
      }
      if (hit.tier < aim) log('降级', source, want, '-> tier', hit.tier, '（已试过高档）')
      else log('缓存命中', source, want, 'tier', hit.tier)
      return hit.url
    }
  }

  // 同一层同时只有一个解析在跑。洛雪切歌时可能并发问同一首，
  // 不去重就是两份一模一样的请求砸同一批网关
  let p = inflight.get(key)
  if (!p) {
    const mine = resolveLayer(source, info, need, want)
      .then((got) => {
        putCache(key, got)
        return got
      })
      .catch((e) => {
        log('解析异常', String((e && e.message) || e).slice(0, 60))
        putCache(key, null)
        return null
      })
      .then((v) => {
        if (inflight.get(key) === mine) inflight.delete(key)
        return v
      })
    p = mine
    inflight.set(key, p)
  }

  const got = await p
  if (!got) {
    // 本层全空，再看一眼低档缓存 —— 用户可能先播了 320k 再切无损，
    // 那一层的结果还在 2 分钟有效期内，拿它顶上比报错强
    if (need > 1) {
      const lows = need >= 3 ? [2, 1] : [1]
      for (let i = 0; i < lows.length; i++) {
        const c = cache.get(cacheKey(source, info, lows[i]))
        if (c && c.url && Date.now() - c.t < TTL_DEGRADED) {
          log('回落到低档缓存', source, want, '-> tier', c.tier)
          return c.url
        }
      }
    }
    return null
  }
  if (got.tier < aim) log('降级', source, want, '-> tier', got.tier, '（已试过高档）')
  return got.url
}

/* ============================================================================
 * 接口
 * ==========================================================================*/

const QL = {
  kw: ['128k', '320k', 'flac'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  // kg/tx 的高档位是星海 xh 真给的（酷狗 quviper_clear/quviper_atmos 真母带、
  // QQ atmos 走 qq 通道），和玉宁熙对外声明一致。咪咕上游只到 flac，不虚标
  kg: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master'],
  tx: ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master'],
  mg: ['128k', '320k', 'flac'],
}

on(EVENT_NAMES.request, async ({ source, action, info }) => {
  if (action !== 'musicUrl') throw new Error('仅支持取播放链接')
  maybeRecheck()
  const musicInfo = (info && info.musicInfo) || {}
  const want = (info && info.type) || '320k'
  const u = await resolve(source, musicInfo, want)
  if (!u) throw new Error('直连源取链失败：' + String(musicInfo.name || ''))
  return u
})

log('狐兔 v' + MY_VER + ' 构建于', BUILT_AT, DISABLED_GW.length ? '已禁用: ' + DISABLED_GW.join(',') : '全部网关启用')

/* ============================================================================
 * 启动自检：把"这台机器能连上哪些通道"直接打进日志
 *
 * 之前每一次排查都是同一个死循环：用户贴"酷我只有 320k"，我在自己机器上
 * 测 cwww 是 235ms 真无损，于是只能猜"大概是用户侧网络不通"。猜错一轮
 * 就白改一版，来回三四次。
 *
 * 现在脚本自己报：六条通道逐条 ✔ 可达 / ✘ 连不上 + 耗时。用户只要贴这几行，
 * "通道挂了"和"通道给了但被代码丢了"就能一眼分开 —— 前者要换通道，
 * 后者才需要改代码。
 *
 * 判据故意粗：网关根路径能拿到任何 HTTP 响应就算可达。这里要区分的是
 * "网络层通不通"，不是"这个网关对某首歌赞不赞"，后者由每次取链的
 * ✔/无响应/无链接 三态日志回答。
 * ==========================================================================*/
// 自检不是"ping 一下根路径"，而是**真的取一次链**。
//
// 理由：ping 通只能证明网络到得了，证明不了"能不能产出真无损"，而这
// 恰恰是用户唯一关心的东西。前几轮反复出现"我这儿通道正常、用户那儿
// 只有 320k"，就是因为只看了连通性。
// 现在酷我官方那条直接打 rid=228908（《晴天》）要 flac，校验返回的
// data.format 是不是 flac —— ✔ 就代表酷我无损在你这台机器上是真的能用。
const KW_PROBE =
  'http://mobi.kuwo.cn/mobi.s?f=web&user=0' +
  '&source=kwplayer_ar_8.5.5.0_apk_keluze.apk' +
  '&type=convert_url_with_sign&rid=228908&br=2000kflac&format=flac'

const HEALTH = [
  {
    name: '酷我官方 mobi.s  无损',
    url: KW_PROBE,
    // 必须判到 format=flac 才算过：只回 200 但给 mp3 的话，酷我无损照样没有
    judge: (b) => b && b.data && /flac/i.test(String(b.data.format || '')),
    okText: '真无损',
  },
  {
    name: 'c.wwwweb.top     酷我/网易',
    url: 'https://c.wwwweb.top/',
  },
  {
    name: 'api.qijieya.cn   网易meting',
    url: 'https://api.qijieya.cn/',
  },
  // 必须用真实 API 路径探测：它的根路径不响应（2.5 秒超时），但 api.php
  // 实测 1.1 秒就回。用根路径会把一条好通道误报成"连不上"
  {
    name: 'gdstudio.xyz     网易备用',
    url: 'https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=a&count=1',
  },
  { name: 'a.aa.cab         QQ 兜底', url: 'https://a.aa.cab/' },
  { name: 'trackercdn       酷狗', url: 'https://trackercdn.kugou.com/' },
  // 同理：裸 IP 的 80 端口只挂了 /api/music/url，根路径不响应。
  // 不带 key 会回 401，但"能回 HTTP"就说明网络层通了 —— 这正是要判的
  { name: 'HYW 中转         QQ/酷我', url: 'http://103.79.184.97/api/music/url?platform=kw' },

  // ---- 搜索接口自检（酷狗/咪咕唯一的活路，2026-11-03 起必须单列）----
  //
  // 现状：酷狗 trackercdn 对 VIP 曲一律 status=2「The Resource Needs to be Paid」，
  // v1/v2 两代接口、128k/320k/flac/sq 四种 hash 全试过，都是同一句；
  // 咪咕没有可用的直连接口（listenSong.do 要 18 位 contentId，getPlayInfoV2 已 301）；
  // hyw 中转那台裸 IP 现在 ICMP 都不可达。
  //
  // 也就是说这两个平台**完全靠跨平台借酷我的音源**。跨平台第一步是搜索，
  // 搜索一断整列就是秒失败（报错立刻返回，不等超时），从洛雪日志上看和
  // "通道挂了"长得一模一样。所以必须单独探一条，出问题时能一眼分清是哪一层死的。
  {
    name: '搜索 酷我        跨平台主路',
    url:
      KW_SEARCH +
      '?all=%E6%99%B4%E5%A4%A9&ft=music&itemset=web_2013&client=kt&pn=0&rn=1&rformat=json&encoding=utf8&vipver=1',
    judge: (b) => String(typeof b === 'string' ? b : JSON.stringify(b || '')).indexOf('abslist') >= 0,
    okText: '可用',
  },
  {
    name: '搜索 网易        跨平台次路',
    url: WY_SEARCH + '?s=%E6%99%B4%E5%A4%A9&type=1&offset=0&limit=1',
    judge: (b) => !!(b && (b.code === 200 || (b.result && b.result.songs))),
    okText: '可用',
  },
  {
    name: '搜索 QQ          跨平台三路',
    url: QQ_SEARCH + '?w=%E6%99%B4%E5%A4%A9&format=json&n=1&p=1&cr=1&new_json=1&t=0',
    headers: { Referer: 'https://y.qq.com/' },
    judge: (b) => !!(b && b.data && b.data.song),
    okText: '可用',
  },
]

const selfCheck = () => {
  log('---- 通道自检（酷我那条做真实取链，其余只测连通）----')
  let left = HEALTH.length
  const tick = () => {
    if (--left === 0) log('---- 自检结束（✘ 的通道不影响播放，别的通道会顶上）----')
  }
  HEALTH.forEach((it) => {
    const t0 = Date.now()
    http(it.url, {
      method: 'GET',
      // 个别接口要 Referer（QQ 搜索不带会回 HTML 落地页），按条目覆盖
      headers: Object.assign({ 'User-Agent': 'okhttp/3.10.0' }, it.headers || {}),
      timeout: 2500,
    }).then((b) => {
      const ms = Date.now() - t0 + 'ms'
      if (b === null) log('自检', it.name, '✘ 连不上', ms)
      else if (it.judge && !it.judge(b)) log('自检', it.name, '✘ 连上但取不到无损', ms)
      else log('自检', it.name, '✔', it.okText || '可达', ms)
      tick()
    })
  })
}
// 延迟 2.5 秒：别和启动后第一首歌抢带宽。整轮只跑一次
setTimeout(selfCheck, 2500)


/* ============================================================================
 * 新版本提醒
 *
 * 洛雪导入 URL 时会把脚本内容一次性固化存本地，之后不会自己跟随仓库升级
 * （官方机制如此，防恶意源静默变更）。所以在这里后台拉一次仓库上的最新版，
 * @version 比当前新就弹窗提醒 —— 用户到 洛雪设置 → 自定义源 → 管理，
 * 对狐兔点「更新」即可，不用删除重导。
 * ==========================================================================*/
// 检查源按国内可达性排序：GitHub 加速镜像（转发 raw，实测国内最稳）→
// raw 直连（加时间戳防 CDN 缓存旧版本号）→ 备用镜像 → jsDelivr（时好时坏）。
// 实测 2026-11-02 同一轮内：raw/ghfast 超时、gh-proxy 457ms 通——可达性是轮盘赌，
// 所以要多路 + 播放时反复重试，不能只赌 init 那一次。
const RAW_URLS = [
  // 顺序按"发版后多久能读到新版"排，不按 Ping。实测同一次发布后 30 秒查：
  //   ghfast.top     -> 2.10.0（几乎实时）
  //   ghproxy.net    -> 2.10.0
  //   gh-proxy.com   -> 2.9.2 （滞后十几分钟，排后面）
  'https://ghfast.top/https://raw.githubusercontent.com/WangMCweijia/lx-source-dist/main/lx-direct.js',
  'https://ghproxy.net/https://raw.githubusercontent.com/WangMCweijia/lx-source-dist/main/lx-direct.js',
  'https://gh-proxy.com/https://raw.githubusercontent.com/WangMCweijia/lx-source-dist/main/lx-direct.js',
  'https://raw.githubusercontent.com/WangMCweijia/lx-source-dist/main/lx-direct.js',
]
// jsDelivr 已摘掉：@main 的缓存实测滞后到 2.2.1（落后 7 个版本），
// 每次检查都白跑一路。它只有在固定 commit 版本号时才是准的
// （MY_VER 已提到文件顶部：日志也要用它，不能再藏在这里）

// 用户点"更新"后打开的地址。必须是 http(s)，洛雪会交给系统浏览器。
// 指向主推导入地址：打开后是脚本全文，可全选复制，也可把这个 URL
// 直接粘进「自定义源 → 添加 → 从 URL 导入」覆盖同名源
//
// 更新地址：必须带 ?v=<远端版本号>。
//
// 2026-11-03 实测（内容已从 2.14.0 更新到 2.15.0，同一分钟内请求同一个镜像）：
//   不带参数      -> 仍返回 2.14.0   ← ghfast 按完整 URL 缓存，这就是"点了更新没反应"
//   ?v=2.15.0    -> 2.15.0
//   ?r=<随机数>   -> 2.15.0
// 所以 query 是穿透缓存的关键。之前为了"链接看起来稳定"把 ?v= 删掉，
// 恰好把唯一能穿透缓存的东西删了 —— 那次手机重新导入拿到的还是上一版。
//
// 但版本号必须用**远端**的，不能用本地版本（旧代码就是这么写的）：
// 用本地版本等于给未来的内容贴过去的标签，同一台机器永远命中同一个缓存键。
// 远端版本一变 URL 就变，天然是新键，而且语义和内容一致。
const updateUrlFor = (ver) =>
  'https://ghfast.top/https://raw.githubusercontent.com/WangMCweijia/lx-source-dist/main/lx-direct.js?v=' +
  String(ver || '')

// 逐段比较版本号：2.3.10 > 2.3.9，避免字符串比较把 '10' 排在 '9' 前面
const verGreater = (a, b) => {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0
  }
  return false
}

/* 弹更新提示 —— 只能用 lx.send(updateAlert)。
 *
 * 这里原来是 alert(...)，在洛雪沙箱里 alert 根本不存在（只暴露 lx.*），
 * 抛 ReferenceError 被外层 try 吞掉，于是"检查更新"日志正常、弹窗永远不出现，
 * 用户只能删源重导。updateAlert 是官方给自定义源准备的唯一弹窗通道，
 * 参数 { log, updateUrl }，每次运行脚本只能调一次。
 * --------------------------------------------------------------------------*/
const notifyUpdate = (remoteVer) => {
  // 洛雪规定 updateAlert 每次运行脚本只能发一次，多发会被丢掉。
  // init 的定时检查和播放时的补充检查可能同时命中，这里自己上一次锁
  if (verAlerted) return false
  verAlerted = true
  const text =
    '狐兔音源有新版本 v' + remoteVer + '（当前 v' + MY_VER + '）\n\n' +
    '更新方法：\n' +
    '① 设置 → 自定义源 → 管理，对「狐兔」点右侧的 ⇗ 图标，\n' +
    '   点完版本号变了就成功了，不用管别的\n' +
    '② ⇗ 点了没变化：先删掉旧的「狐兔」，再点下面的按钮\n' +
    '   打开地址复制全文，从 URL 导入\n' +
    '   （不删会多出一份，两个源同时启用会互相抢，\n' +
    '     症状就是有的平台能播有的不行）\n\n' +
    '歌单、设置、登录状态都不受影响。'
  try {
    const ev = (EVENT_NAMES && EVENT_NAMES.updateAlert) || 'updateAlert'
    send(ev, { log: text.slice(0, 1000), updateUrl: updateUrlFor(remoteVer) })
    log('已弹出更新提示: 远端 v' + remoteVer)
    return true
  } catch (e) {
    log('弹更新提示失败:', String((e && e.message) || e).slice(0, 60))
    return false
  }
}

// 关键：任何一路"请求失败 / 返回的不是脚本 / 拿不到版本号"都要落到下一路，
// 之前 regex 不匹配时直接 return，jsDelivr 返回错误页就整条链断了。
// 每一步都打日志 —— 洛雪日志面板能看到检查走到哪、死在哪一路
//
// "只拿到和本地相同的版本号"不等于最新：raw.githubusercontent.com 自己有
// 约 5 分钟 CDN 缓存，刚发版时 gh-proxy 还吐上一版，而用户装的正好是那一版，
// 两者相等就会误判成"已是最新"而收工。所以相等也继续问下一路，
// 只有某一路给出比本地新的版本号才立刻收工弹窗。
const checkNewVer = (i) => {
  // 只拦"发起一轮新的检查"。递归翻页时必须继续，否则第一路失败整条链就断了
  if (i === 0) {
    // verGot 之后就没必要再查了 —— init 那个 2 秒定时器和第一次播放几乎
    // 同时开跑，不拦会连查两轮，日志里出现两条 "(1/4)"
    if (verGot || verChecking) return
    verChecking = true
  }
  if (i >= RAW_URLS.length) {
    verChecking = false
    if (verBest) {
      // 所有路都问过了。verBest 只到本地版本时有两种可能：确实最新，
      // 或者四路镜像都还在吐缓存。措辞必须把这点说清楚 —— 以前打
      // "已是 v2.10.0（本地 v2.11.0）"，看起来像"已是最新"，
      // 实际是"四路都给了比本地旧的版本"，排查时会被误导
      verGot = true
      const same = !verGreater(MY_VER, verBest) && !verGreater(verBest, MY_VER)
      // 比本地旧 = 命中的是镜像缓存，不是"最新"。这种情况不能置 verGot
      // 永久停查：缓存几分钟后就会过期，下次播放该再问一次，
      // 否则刚发版的那段时间里第一批用户永远收不到更新提示
      if (!same && verGreater(MY_VER, verBest)) verGot = false
      log(
        '检查更新: 4 路最高只到 v' +
          verBest +
          (same ? '（= 本地，已是最新）' : '（比本地 v' + MY_VER + ' 旧，镜像缓存滞后）')
      )
    } else {
      log('检查更新: 4 个镜像都连不上（本机网络限制），下次播放歌曲时自动重试')
    }
    return
  }
  const host = RAW_URLS[i].split('/')[2]
  // raw 直连带时间戳穿透 CDN 缓存；镜像站对 query 会转发，不影响
  const u = RAW_URLS[i] + (RAW_URLS[i].indexOf('?') < 0 ? '?_t=' + Date.now() : '')
  log('检查更新 (' + (i + 1) + '/4):', host)
  request(
    u,
    { method: 'GET', headers: { 'User-Agent': 'lx-music-desktop/2.11.0' }, timeout: 5000 },
    (err, resp, body) => {
      try {
        if (err || typeof body !== 'string') {
          log('检查更新:', host, '连不上:', String((err && err.message) || '空响应').slice(0, 50))
          return checkNewVer(i + 1)
        }
        const m = /@version\s+([\w.]+)/.exec(body)
        if (!m || !m[1]) {
          log('检查更新:', host, '响应异常（非脚本内容），换下一路')
          return checkNewVer(i + 1)
        }
        if (!verBest || verGreater(m[1], verBest)) verBest = m[1]
        if (!verGreater(m[1], MY_VER)) {
          log('检查更新:', host, '返回 v' + m[1] + '（不高于本地 v' + MY_VER + '），再问下一路')
          return checkNewVer(i + 1)
        }
        verGot = true
        verChecking = false
        log('检查更新: 远端 v' + m[1] + '，本地 v' + MY_VER)
        notifyUpdate(m[1])
      } catch (e) {
        log('检查更新异常:', String(e && e.message).slice(0, 50))
        checkNewVer(i + 1)
      }
    }
  )
}

// init 后 2 秒后台静默检查，多路串行最坏 20 秒，不阻塞任何功能
setTimeout(() => checkNewVer(0), 2000)

// init 那次检查可能赶上全部镜像挂掉（国内可达性轮盘赌）——
// 每次取播放链接时补一次，节流 10 分钟；确认远端不比本地旧就永久停
let verGot = false
let verLastTry = 0
let verChecking = false
let verAlerted = false
// 本轮检查见过的最高版本号。用来区分"所有镜像都只报到本地这个版本"
// （=确实最新）和"全都没连上"（=下轮再试）
let verBest = ''
const maybeRecheck = () => {
  if (verGot) return
  const now = Date.now()
  if (now - verLastTry < 10 * 60 * 1000) return
  verLastTry = now
  checkNewVer(0)
}

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: {
    kw: { name: '狐兔·酷我', type: 'music', actions: ['musicUrl'], qualitys: QL.kw },
    wy: { name: '狐兔·网易', type: 'music', actions: ['musicUrl'], qualitys: QL.wy },
    kg: { name: '狐兔·酷狗', type: 'music', actions: ['musicUrl'], qualitys: QL.kg },
    tx: { name: '狐兔·QQ', type: 'music', actions: ['musicUrl'], qualitys: QL.tx },
    mg: { name: '狐兔·咪咕', type: 'music', actions: ['musicUrl'], qualitys: QL.mg },
  },
})
