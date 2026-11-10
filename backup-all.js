/*!
 * @name 备用聚合源·全音质
 * @description 五平台多上游聚合备用音源：128K / 192K / 320K / FLAC / FLAC24BIT 全档位可用，
 *              某条上游失效或该平台缺某个档位时自动换链、必要时降档，保证一定能播
 * @version 2.0.0
 * @author 音狐备用源
 * @homepage https://cdn.jsdelivr.net/gh/WangMCweijia/lx-source-dist@main/backup-all.js
 */
/**
 * 设计要点
 * 1. 档位优先精确命中：每个平台的每个档位都有独立的上游参数，不靠"猜"。
 * 2. 档位缺失时按阶梯降级（见 FALLBACK），而不是直接报错 —— 用户设 320K 时
 *    绝不会因为某个平台上只有无损而播不出来。
 * 3. 每个平台多条互相独立的上游，按实测速度排序，单条失败自动换下一条。
 * 4. 按 id 取链的平台（kw / wy / tx / mg）优先；只能按歌名取的平台（kg / tx 的
 *    部分档位）会对返回的歌名、歌手、甚至 songmid 做一次比对，对不上就放弃，
 *    避免"同名不同版"串歌；带 DJ / 伴奏 / 片段 等版本标记的候选直接排除。
 * 5. 结果做内存缓存并合并并发请求，连点/切歌不会重复打上游。
 */
const { EVENT_NAMES, request, on, send, utils } = globalThis.lx

// ---------------- 可调参数 ----------------
const TIMEOUT = 9000 // 单条上游默认超时
const CACHE_TTL = 10 * 60 * 1000 // 取链结果缓存

// ---------------- 档位定义 ----------------
// 宿主（洛雪/音狐）的档位名 → 本源内部档位
const TIER_ALIAS = {
  mgg: '128k',
  '96k': '128k',
  ogg96: '128k',
  '128': '128k',
  '128k': '128k',
  '192': '192k',
  '192k': '192k',
  ogg192: '192k',
  '320': '320k',
  '320k': '320k',
  flac: 'flac',
  flac24bit: 'flac24bit',
  hires: 'flac24bit',
  vinyl: 'flac24bit',
  master: 'flac24bit',
  dolby: 'flac24bit',
  atmos: 'flac24bit',
  atmos_plus: 'flac24bit',
}

// 请求档位 → 尝试顺序（前面拿不到才往下走）
// 先试自己，再试比它高的（音质不掉），最后才退低档
const FALLBACK = {
  '128k': ['128k', '320k', 'flac'],
  '192k': ['192k', '320k', 'flac', '128k'],
  '320k': ['320k', 'flac', '128k'],
  flac: ['flac', '320k'],
  flac24bit: ['flac24bit', 'flac', '320k'],
}

// 各平台对宿主声明的档位（只声明真能拿到的）
// 国内平台没有真正的 192K 这一档（"标准音质"就是 128K），所以统一不声明；
// 宿主仍可能发 192K 请求，交给下面的 FALLBACK 处理即可。
// 各平台对宿主声明的档位（只声明真能拿到的）
// 国内平台没有真正的 192K 这一档（"标准音质"就是 128K），所以统一不声明；
// 宿主仍可能发 192K 请求，交给下面的 FALLBACK 处理即可。
// 2026-11-10：tx 的 flac24bit 也去掉。24bit/母带的唯一来源是星海通道，
// 它现在返回 403「仅对认证用户开放」，声明了只能拿到 16bit —— 虚标不如不标。
const QUALITYS = {
  kw: ['128k', '320k', 'flac'],
  wy: ['128k', '320k', 'flac'],
  tx: ['128k', '320k', 'flac'],
  kg: ['128k', '320k', 'flac'],
  mg: ['128k', '320k', 'flac'],
}

const QUALITY_LABELS = {
  '128k': '128K',
  '192k': '192K',
  '320k': '320K',
  flac: 'FLAC',
  flac24bit: 'FLAC 24BIT',
}

const SOURCE_NAMES = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
}

const isLosslessTier = (t) => t === 'flac' || t === 'flac24bit'

// 档位高低排序（用于判断"拿到的比要的差"还是"比要的好"）
const TIER_RANK = { '128k': 1, '192k': 2, '320k': 3, flac: 4, flac24bit: 5 }
const rankOf = (t) => TIER_RANK[t] || 0

// ---------------- 基础工具 ----------------
const LOSSY_RE = /\.(mp3|m4a|aac|ogg|wma|amr)(\?|$)/i
const LOSSLESS_RE = /\.(flac|ape|wav|alac|dsf|dff)(\?|$)/i
// 试听片段：RS02 前缀 / A000 前缀 / 30s 标记
// 注意：ws.stream.qqmusic 是正常流媒体域名（M800 等），不能当试听域名拦掉
const TRIAL_RE = /\/RS02|\/A000|try\.music|duration=30/i
// "同名不同版"的版本标记，候选里出现了目标没有的，直接排除
const VERSION_RE = /(dj|remix|伴奏|纯音乐|片段|demo|铃声|cover|翻唱|改编|live|现场|演唱会|巡回|加速|降速|8d|环绕|抖音|女声版|男声版|钢琴|吉他|器乐|清唱|合唱|串烧|剪辑|混音)/gi

const httpGet = (url, options) =>
  new Promise((resolve, reject) => {
    const opt = options || {}
    const timer = setTimeout(() => reject(new Error('超时')), opt.timeout || TIMEOUT)
    request(
      url,
      {
        method: opt.method || 'GET',
        headers: opt.headers,
        body: opt.body,
      },
      (err, resp) => {
        clearTimeout(timer)
        if (err) return reject(err instanceof Error ? err : new Error(String(err)))
        if (!resp) return reject(new Error('空响应'))
        const code = resp.statusCode || resp.status || 200
        if (code >= 400) return reject(new Error('HTTP ' + code))
        let body = resp.body
        if (typeof body === 'string') {
          const t = body.trim()
          if (t.startsWith('{') || t.startsWith('[')) {
            try {
              body = JSON.parse(t)
            } catch (e) {}
          }
        }
        resolve(body)
      }
    )
  })

const dig = (obj, path) =>
  String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj)

const asUrl = (v) => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (s.startsWith('//')) return 'https:' + s
  return /^https?:\/\//i.test(s) ? s : null
}

const md5hex = (s) => {
  const c = utils && utils.crypto
  if (c && typeof c.md5 === 'function') return c.md5(s)
  throw new Error('宿主未提供 md5')
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|（.*?）|\[.*?\]|【.*?】/g, '')
    .replace(/[\s\-_/·]/g, '')

const tagsOf = (s) => {
  const out = []
  String(s || '').replace(VERSION_RE, (m) => {
    const t = String(m).toLowerCase()
    if (out.indexOf(t) < 0) out.push(t)
    return m
  })
  return out
}

// 歌名+歌手打分：<60 视为不是同一首
const scoreCandidate = (wantName, gotName, wantSinger, gotSinger) => {
  const wn = norm(wantName)
  const gn = norm(gotName)
  if (!wn || !gn) return 0
  if (gn !== wn && gn.indexOf(wn) < 0) return 0
  const wt = tagsOf(wantName)
  const gt = tagsOf(gotName)
  for (let i = 0; i < gt.length; i++) {
    if (wt.indexOf(gt[i]) < 0) return 0 // 候选多了目标没有的版本标记
  }
  for (let i = 0; i < wt.length; i++) {
    if (gt.indexOf(wt[i]) < 0) return 0 // 目标带这个版本标记，候选必须是同版
  }
  let s = gn === wn ? 100 : Math.max(0, 60 - (gn.length - wn.length))
  const ws = norm(wantSinger)
  const gs = norm(gotSinger)
  if (ws && gs) {
    if (gs.indexOf(ws) >= 0 || ws.indexOf(gs) >= 0) s += 25
    else return 0 // 歌手对不上，多半是同名不同曲
  }
  return s
}

// 从候选数组里挑最像的那条
// midKeys：候选里可用于精确比对的字段（字符串或数组），任一命中直接返回
const pickBest = (info, list, nameKey, singerKey, midKeys) => {
  if (!list || !list.length) return null
  const wantName = info.name || info.songname || info.title || ''
  const wantSinger =
    info.singer ||
    info.artist ||
    (Array.isArray(info.singers) ? info.singers.map((s) => s && s.name).filter(Boolean).join(' ') : '') ||
    ''
  const midList = midKeys ? (Array.isArray(midKeys) ? midKeys : [midKeys]) : []
  // musicInfo 自带的各种 id 全收进来
  const wants = []
  for (const k of ['hash', 'songmid', 'mid', 'fileHash', 'copyrightId', 'id']) {
    const v = info && info[k]
    if (v != null && v !== '' && typeof v !== 'object') wants.push(String(v).toUpperCase())
  }

  let best = null
  let bestScore = 0
  for (let i = 0; i < list.length; i++) {
    const it = list[i]
    if (!it) continue
    // id 直接命中：同一首，最可靠
    if (midList.length && wants.length) {
      for (let j = 0; j < midList.length; j++) {
        const gv = String(it[midList[j]] || '').toUpperCase()
        if (gv && wants.indexOf(gv) >= 0) return it
      }
    }
    const sc = scoreCandidate(wantName, it[nameKey], wantSinger, it[singerKey])
    if (sc > bestScore) {
      bestScore = sc
      best = it
    }
  }
  return bestScore >= 60 ? best : null
}

// 单条记录（非数组）的歌名比对
const matchOne = (info, name, singer) => {
  const wantName = info.name || info.songname || info.title || ''
  const wantSinger =
    info.singer ||
    info.artist ||
    (Array.isArray(info.singers) ? info.singers.map((s) => s && s.name).filter(Boolean).join(' ') : '') ||
    ''
  return scoreCandidate(wantName, name, wantSinger, singer) >= 60
}

// 从 musicInfo 里挖出各平台 id（字段名各家插件不一致，全试一遍）
const pickId = (info, keys) => {
  for (const k of keys) {
    const v = info && info[k]
    if (v != null && v !== '' && typeof v !== 'object') {
      return String(v).replace(/^MUSIC_/, '')
    }
  }
  return ''
}

const ID_FIELDS = {
  kw: ['rid', 'songmid', 'songId', 'id', 'musicrid', 'musicId'],
  kg: ['hash', 'songmid', 'fileHash', 'id', 'rid', 'EMixSongID'],
  tx: ['songmid', 'mid', 'songId', 'id', 'strMediaMid'],
  wy: ['songmid', 'id', 'songId', 'rid'],
  mg: ['copyrightId', 'songmid', 'cid', 'id', 'contentId', 'songId'],
}

// 歌名+歌手 → 歌名+专辑 → 纯歌名，命中率不够时逐个退
const keywordVariants = (info) => {
  const name = info.name || info.songname || info.title || ''
  const singer =
    info.singer ||
    info.artist ||
    (Array.isArray(info.singers) ? info.singers.map((s) => s && s.name).filter(Boolean).join(' ') : '') ||
    ''
  const album = info.albumName || info.album || ''
  const out = []
  const push = (v) => {
    const s = String(v || '').trim()
    const e = encodeURIComponent(s)
    if (s && out.indexOf(e) < 0) out.push(e)
  }
  if (name && singer) push(name + ' ' + singer)
  if (name && album) push(name + ' ' + album)
  if (name) push(name)
  return out
}

// 档位与链接是否匹配（拿不到就换下一条，而不是凑合）
const accept = (tier, url) => {
  if (!url) return false
  if (TRIAL_RE.test(url)) return false
  if (isLosslessTier(tier)) return !LOSSY_RE.test(url)
  return true
}

// ---------------- 上游链路 ----------------
// 每条链：run(info, tier, keyword?) → url | { url, tier } | null
// nameBased 的链会依次尝试 keywordVariants 的三个关键词

// 酷我官方 nmobi：一个接口通吃全档位，返回 JSON 里自带 bitrate/format 可自校验
const kuwoChain = (br) => ({
  name: 'kuwo-official',
  run: async (info, tier) => {
    const rid = pickId(info, ID_FIELDS.kw)
    if (!rid) throw new Error('缺 rid')
    const d = await httpGet(
      'http://nmobi.kuwo.cn/mobi.s?f=web&user=0' +
        '&source=kwplayerhd_ar_1.1.4.5_tianbao_T1A_qirui.apk' +
        '&type=convert_url_with_sign&rid=' +
        rid +
        '&br=' +
        br,
      { timeout: 8000 }
    )
    const url = asUrl(dig(d, 'data.url'))
    if (!url) return null
    const fmt = String(dig(d, 'data.format') || '').toLowerCase()
    const bitrate = Number(dig(d, 'data.bitrate') || 0)
    // 自校验：要无损就必须真给 flac；要 320K 就不能给 128K
    if (isLosslessTier(tier) && fmt !== 'flac' && fmt !== 'ape' && fmt !== 'wav') return null
    if (tier === '320k' && bitrate > 0 && bitrate < 256) return null
    // 按接口回传的真实码率标注档位，不按"请求了什么"标
    let real = '128k'
    if (fmt === 'flac' || fmt === 'ape' || fmt === 'wav') real = bitrate >= 3000 ? 'flac24bit' : 'flac'
    else if (bitrate >= 300) real = '320k'
    else if (bitrate >= 160) real = '192k'
    return { url: url, tier: real }
  },
})

// 网易云：c.wwwweb.top 按 quality 精确给档
const wyWwwwebChain = (quality) => ({
  name: 'wwwweb',
  run: async (info, tier) => {
    const id = pickId(info, ID_FIELDS.wy)
    if (!id) throw new Error('缺 id')
    const d = await httpGet('https://c.wwwweb.top/music/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'wy', musicId: id, quality: quality }),
      timeout: 9000,
    })
    const url = asUrl(dig(d, 'url') || dig(d, 'data.url'))
    if (!url) return null
    // 接口会回传实际档位，按它标注
    const q = String(dig(d, 'quality') || '')
    let real = tier
    if (q === 'flac') real = 'flac'
    else if (q === 'flac24bit') real = 'flac24bit'
    else if (q === '320k') real = '320k'
    else if (q === '128k') real = '128k'
    return { url: url, tier: real }
  },
})

// 网易云无损备用：GDAPI（br=999 出 32MB flac）
const wyGdapiChain = {
  name: 'gdapi',
  run: async (info) => {
    const id = pickId(info, ID_FIELDS.wy)
    if (!id) throw new Error('缺 id')
    const d = await httpGet(
      'https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=' + id + '&br=999',
      { timeout: 14000 }
    )
    return asUrl(dig(d, 'url'))
  },
}

// QQ：s01s 按 mid 取，一次给出 标准(m4a) / SQ(flac) / PQ(母带) 三条
const qqS01sChain = (field, realTier) => ({
  name: 's01s-qq',
  run: async (info) => {
    const mid = pickId(info, ID_FIELDS.tx)
    if (!mid) throw new Error('缺 songmid')
    const d = await httpGet('https://tang.api.s01s.cn/music_open_api.php?mid=' + mid, { timeout: 18000 })
    const url = asUrl(dig(d, field))
    if (!url) return null
    return realTier ? { url: url, tier: realTier } : url
  },
})

// QQ：a.aa.cab 按歌名取，type 决定档位；返回里有 mid，可精确校验是不是同一首
const qqAacabChain = (type) => ({
  name: 'aacab-qq',
  nameBased: true,
  run: async (info, tier, kw) => {
    const endpoint = 'https://a.aa.cab/qq.music?msg=' + kw + '&n=1&type=' + type
    // 该接口未命中缓存时会实时解析，偶发返空；连续请求还会被限流，隔一会儿再补一次
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400))
      const d = await httpGet(endpoint, { timeout: 12000 })
      const data = dig(d, 'data') || {}
      const url = asUrl(data.music || data.url)
      if (!url) continue
      // QQ 的 songmid 与音频文件名里的 media_mid 不是同一套，只能用 media_mid 比对
      const wantMedia = String(info.media_mid || info.strMediaMid || info.mediaMid || '')
      const gotMedia = String(data.media_mid || '')
      if (wantMedia && gotMedia && wantMedia !== gotMedia) return null
      if (!matchOne(info, data.song, data.singer)) return null
      return url
    }
    return null
  },
})

// 酷狗：官方搜索取各档位 hash，再走 trackercdn 换直链（128K/320K/FLAC 全支持）
const kgCdnChain = {
  name: 'kugou-cdn',
  nameBased: true,
  run: async (info, tier, kw) => {
    const s = await httpGet(
      'https://songsearch.kugou.com/song_search_v2?keyword=' + kw + '&page=1&pagesize=30',
      { timeout: 9000 }
    )
    const item = pickBest(
      info,
      dig(s, 'data.lists') || [],
      'SongName',
      'SingerName',
      ['FileHash', 'HQFileHash', 'SQFileHash']
    )
    if (!item) return null
    const f = item.FileHash
    const hq = item.HQFileHash
    const sq = item.SQFileHash
    let hash = ''
    let real = tier
    if (isLosslessTier(tier)) {
      if (sq) {
        hash = sq
        real = tier
      } else {
        return null // 这条目没有无损版，换下一条链
      }
    } else if (tier === '320k') {
      if (hq) {
        hash = hq
        real = '320k'
      } else if (sq) {
        hash = sq
        real = 'flac'
      } else if (f) {
        hash = f
        real = '128k'
      }
    } else {
      if (f) {
        hash = f
        real = '128k'
      } else if (hq) {
        hash = hq
        real = '320k'
      } else if (sq) {
        hash = sq
        real = 'flac'
      }
    }
    if (!hash) return null
    hash = String(hash)
    const d = await httpGet(
      'http://trackercdn.kugou.com/i/?cmd=4&pid=1&key=' +
        md5hex(hash + 'kgcloud') +
        '&hash=' +
        hash +
        '&acceptMp3=1&forceDown=1',
      { timeout: 9000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    const url = asUrl(dig(d, 'url'))
    if (!url) return null
    return { url: url, tier: real }
  },
}

// 酷狗无损备用：xcvts 按歌名取，固定给 flac
const kgXcvtsChain = {
  name: 'xcvts-kugou',
  nameBased: true,
  run: async (info, tier, kw) => {
    // 这个接口对同一 IP 有频率限制，空响应基本就是被限流了，隔一会儿补一次
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 900))
      const d = await httpGet('https://api.xcvts.cn/api/music/kugou?msg=' + kw + '&br=SQ&n=1', {
        timeout: 12000,
      })
      const url = asUrl(dig(d, 'music_url') || dig(d, 'url'))
      if (!url) continue
      if (!matchOne(info, d.title, d.singer)) return null
      return { url: url, tier: 'flac' }
    }
    return null
  },
}

// 咪咕：oiapi 按歌名取，br 决定档位（PQ=128K / HQ=320K / SQ=FLAC），URL 路径自带档位可校验
const mgOiapiChain = (br) => ({
  name: 'oiapi-migu',
  nameBased: true,
  run: async (info, tier, kw) => {
    const d = await httpGet('https://oiapi.net/api/MiGu_Music?msg=' + kw + '&n=1&br=' + br, { timeout: 14000 })
    const data = dig(d, 'data') || {}
    const url = asUrl(data.url || dig(d, 'url'))
    if (!url) return null
    if (!matchOne(info, data.song, data.singer)) return null
    const plain = url.split('?')[0]
    if (tier === '320k' && plain.indexOf('MP3_320') < 0) return null
    if (tier === '128k' && plain.indexOf('MP3_128') < 0) return null
    if (isLosslessTier(tier) && LOSSY_RE.test(plain)) return null
    // 咪咕的 URL 路径里带档位目录，直接按它标注
    let real = tier
    if (plain.indexOf('MP3_320') >= 0) real = '320k'
    else if (plain.indexOf('MP3_128') >= 0) real = '128k'
    else if (!LOSSY_RE.test(plain)) real = 'flac'
    return { url: url, tier: real }
  },
})

const PROVIDERS = {
  kw: {
    '128k': [kuwoChain('128kmp3')],
    '192k': [kuwoChain('192kmp3')],
    '320k': [kuwoChain('320kmp3')],
    flac: [kuwoChain('2000kflac')],
    flac24bit: [kuwoChain('4000kflac')],
  },

  wy: {
    '128k': [wyWwwwebChain('128k')],
    '192k': [wyWwwwebChain('320k')],
    '320k': [wyWwwwebChain('320k')],
    flac: [wyWwwwebChain('flac'), wyGdapiChain],
    flac24bit: [wyWwwwebChain('flac24bit'), wyGdapiChain],
  },

  tx: {
    // QQ 的"标准音质"就是 m4a(96~192K)，没有单独的 128K mp3 档
    '128k': [qqAacabChain(3), qqS01sChain('song_play_url', '128k')],
    '192k': [qqAacabChain(3), qqS01sChain('song_play_url', '192k')],
    '320k': [qqAacabChain(1)],
    flac: [qqAacabChain(6), qqS01sChain('song_play_url_sq', 'flac')],
    flac24bit: [
      qqS01sChain('song_play_url_pq', 'flac24bit'),
      qqAacabChain(6),
      qqS01sChain('song_play_url_sq', 'flac'),
    ],
  },

  kg: {
    '128k': [kgCdnChain],
    '192k': [kgCdnChain],
    '320k': [kgCdnChain],
    flac: [kgCdnChain, kgXcvtsChain],
    flac24bit: [kgCdnChain, kgXcvtsChain],
  },

  mg: {
    '128k': [mgOiapiChain('PQ')],
    '192k': [mgOiapiChain('HQ')],
    '320k': [mgOiapiChain('HQ')],
    flac: [mgOiapiChain('SQ')],
    flac24bit: [mgOiapiChain('SQ')],
  },
}

// ---------------- 缓存与并发合并 ----------------
const cache = Object.create(null)
const inflight = Object.create(null)

const cacheGet = (k) => {
  const e = cache[k]
  if (!e) return null
  if (e.expire < Date.now()) {
    delete cache[k]
    return null
  }
  return e
}

const cacheSet = (k, hit) => {
  cache[k] = { url: hit.url, tier: hit.tier, expire: Date.now() + CACHE_TTL }
}

// ---------------- 核心：单档位取链 ----------------
async function tryTier(s, info, tier) {
  const list = (PROVIDERS[s] || {})[tier] || []
  const fails = []

  for (let i = 0; i < list.length; i++) {
    const p = list[i]

    if (p.nameBased) {
      const variants = keywordVariants(info).slice(0, 3)
      if (!variants.length) {
        fails.push(p.name + ':缺歌名')
        continue
      }
      for (let j = 0; j < variants.length; j++) {
        const kw = variants[j]
        try {
          const r = await p.run(info, tier, kw)
          const url = typeof r === 'string' ? r : r && r.url
          if (!url) {
            fails.push(p.name + ':未匹配(' + decodeURIComponent(kw) + ')')
            continue
          }
          if (!accept(tier, url)) {
            fails.push(p.name + ':档位不符')
            continue
          }
          return { url: url, tier: (r && r.tier) || tier, provider: p.name }
        } catch (e) {
          fails.push(p.name + ':' + (e && e.message ? e.message : String(e)))
        }
      }
      continue
    }

    try {
      const r = await p.run(info, tier)
      const url = typeof r === 'string' ? r : r && r.url
      if (!url) {
        fails.push(p.name + ':无链接')
        continue
      }
      if (!accept(tier, url)) {
        fails.push(p.name + ':档位不符')
        continue
      }
      return { url: url, tier: (r && r.tier) || tier, provider: p.name }
    } catch (e) {
      fails.push(p.name + ':' + (e && e.message ? e.message : String(e)))
    }
  }

  return { url: '', tier: tier, fails: fails }
}

async function resolve(s, info, tier) {
  if (!PROVIDERS[s]) throw new Error('该平台暂无可用上游')
  const ladder = FALLBACK[tier] || [tier]
  const want = rankOf(tier)
  const fails = []
  // 拿到比请求差的档位先记着，继续往高处找；实在没有才用它
  let degraded = null

  for (let i = 0; i < ladder.length; i++) {
    const r = await tryTier(s, info, ladder[i])
    if (r.url) {
      if (rankOf(r.tier) >= want) return r
      const canFallback = isLosslessTier(tier) ? isLosslessTier(r.tier) : true
      if (!degraded && canFallback) degraded = r
    }
    if (r.fails && r.fails.length) fails.push(ladder[i] + ' → ' + r.fails.join(' / '))
  }

  if (degraded) return degraded
  throw new Error('无可用链路 [' + fails.join(' | ') + ']')
}


// ---------------- 对外：musicUrl ----------------
async function musicUrl(s, info, quality) {
  if (!info) throw new Error('缺少 musicInfo')
  const tier = TIER_ALIAS[String(quality || '').toLowerCase()] || 'flac'

  const id =
    pickId(info, ID_FIELDS[s] || []) ||
    norm(info.name || info.songname) + '-' + norm(info.singer || info.artist)
  const key = s + '|' + id + '|' + tier

  const hit = cacheGet(key)
  if (hit) return { url: hit.url, type: hit.tier, fromCache: true }
  if (inflight[key]) return inflight[key]

  const task = resolve(s, info, tier)
    .then(async (r) => {
      const got = { url: r.url, tier: r.tier || tier }
      cacheSet(key, got)
      return { url: got.url, type: got.tier, provider: r.provider }
    })
    .finally(() => {
      delete inflight[key]
    })

  inflight[key] = task
  return task
}

// ---------------- 注册 ----------------
on(EVENT_NAMES.request, (payload) => {
  const params = payload || {}
  const s = params.source
  const info = params.info || {}
  if (params.action !== 'musicUrl') return Promise.reject(new Error('不支持'))
  if (!PROVIDERS[s]) return Promise.reject(new Error('不支持的音源: ' + s))
  return musicUrl(s, info.musicInfo, info.type).catch((e) =>
    Promise.reject(e && e.message ? e.message : '取链失败')
  )
})

send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: Object.keys(PROVIDERS).reduce((acc, k) => {
    acc[k] = {
      name: SOURCE_NAMES[k],
      type: 'music',
      actions: ['musicUrl'],
      qualitys: QUALITYS[k].reduce((m, q) => {
        m[q] = QUALITY_LABELS[q] || q.toUpperCase()
        return m
      }, {}),
    }
    return acc
  }, {}),
})
