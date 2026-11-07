/*!
 * @name 哔哩哔哩音源
 * @description 按关键词搜 B 站视频当歌听：搜索 / 播放 / 多 P 拆轨 / 音乐榜 / 收藏夹导入。
 *              不依赖 axios 等外部包，只用宿主注入的 fetch；取链和搜索只打 api.bilibili.com。
 * @version 1.0.0
 * @author 音狐
 * @homepage https://github.com/WangMCweijia/lx-source-dist
 *
 * 设计说明（为什么不是官方插件那一套）
 * 1. 档位不按下标取：官方插件 audios.sort(...)[3] 取 super，而多数稿件只返回 3 条音轨
 *    （30216/30232/30280），super 必越界抛错。这里按 track id 精确命中，缺档才退最接近的一档。
 * 2. 选链避开 mcdn：baseUrl 常落在 xy*.mcdn.bilivideo.cn（P2P 边缘节点，失效快），
 *    backupUrl 里的 upos-sz-* 直链更稳，优先取它。
 * 3. 搜索带 buvid：search/type 不带 buvid3/buvid4 会被 412；412 时换一次指纹重试。
 *    取流（view/playurl）反而不能带 cookie（实测带 spi cookie 必 412），所以两者分开处理。
 * 4. 噪声过滤：直播回放、录屏、十几分钟的合集，直接不返回，否则搜"晴天"首页全是录屏。
 *
 * 与宿主（音狐）的契约
 * - 只实现 MusicFree 语义方法：search / getMediaSource / getAlbumInfo / getTopLists /
 *   getTopListDetail / importMusicSheet。刻意不实现 getMusicComments，避免被宿主
 *   BakaPluginManager 误判成 BakaMusic 插件后走另一条取链分支。
 * - 歌曲 id 统一用 bvid，cid 在播放时按需查（搜索结果里没有 cid）。
 */
'use strict'

const API = 'https://api.bilibili.com'
const WEB = 'https://www.bilibili.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
const TIMEOUT = 12000
const PAGE_SIZE = 20

const ICON_RANK =
  'https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_rank.png'
const ICON_WEEKLY =
  'https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_weekly.png'

// ==================== 基础工具 ====================

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function buildQuery(params) {
  const parts = []
  const keys = Object.keys(params || {})
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const v = params[k]
    if (v === undefined || v === null || v === '') continue
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
  }
  return parts.join('&')
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function cleanText(s) {
  if (s === undefined || s === null) return ''
  return decodeEntities(String(s).replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()
}

function fixUrl(u) {
  const s = String(u || '').trim()
  if (!s) return ''
  if (s.indexOf('//') === 0) return 'https:' + s
  if (s.indexOf('http://') === 0) return 'https://' + s.slice(7)
  return s
}

// 搜索结果 duration 是 "4:30"，榜单是秒数；统一成秒
function parseDuration(v) {
  if (typeof v === 'number' && isFinite(v) && v > 0) return Math.round(v)
  const s = String(v || '').trim()
  if (!s) return 0
  if (s.indexOf(':') >= 0) {
    const parts = s.split(':')
    let sec = 0
    for (let i = 0; i < parts.length; i++) {
      sec = sec * 60 + (parseInt(parts[i], 10) || 0)
    }
    return sec
  }
  const n = parseInt(s, 10)
  return isFinite(n) && n > 0 ? n : 0
}

function httpGet(url, headers, timeout) {
  return fetch(url, {
    method: 'GET',
    headers: headers || {},
    timeout: timeout || TIMEOUT,
  }).then(function (res) {
    return res.text().then(function (text) {
      let json = null
      try {
        json = JSON.parse(text)
      } catch (e) {
        json = null
      }
      return { status: res.status, json: json, text: text }
    })
  })
}

// ==================== buvid 指纹（仅搜索需要） ====================

let buvidValue = null
let buvidAt = 0
let buvidPending = null

function ensureBuvid(force) {
  const now = Date.now()
  if (!force && buvidValue && now - buvidAt < 6 * 3600 * 1000) {
    return Promise.resolve(buvValue)
  }
  if (!force && buvidPending) return buvidPending
  const task = httpGet(API + '/x/frontend/finger/spi', {
    'user-agent': MOBILE_UA,
  })
    .then(function (r) {
      const d = r.json && r.json.data
      if (d && d.b_3) {
        buvidValue = { b3: d.b_3, b4: d.b_4 || '' }
        buvidAt = Date.now()
        return buvidValue
      }
      return buvidValue
    })
    .catch(function () {
      return buvidValue
    })
    .then(function (v) {
      buvidPending = null
      return v
    })
  buvidPending = task
  return task
}

function cookieOf(bv) {
  if (!bv || !bv.b3) return ''
  return 'buvid3=' + bv.b3 + (bv.b4 ? '; buvid4=' + bv.b4 : '')
}

/**
 * 统一 API 请求。
 * opts.cookie 为 true 时附 buvid（只有 search/type 需要）；
 * 412 说明被风控，换一次指纹再试，仍失败则抛出可读错误。
 */
async function apiGet(path, params, opts) {
  opts = opts || {}
  const url = API + path + (params ? '?' + buildQuery(params) : '')
  const headers = {
    'user-agent': opts.cookie ? UA : MOBILE_UA,
    referer: opts.referer || WEB + '/',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
  }

  if (opts.cookie) {
    const bv = await ensureBuvid(false)
    const c = cookieOf(bv)
    if (c) headers.cookie = c
  }

  let r = await httpGet(url, headers)
  if (r.status === 412 && opts.cookie) {
    const bv = await ensureBuvid(true)
    const c = cookieOf(bv)
    if (c) headers.cookie = c
    await sleep(300)
    r = await httpGet(url, headers)
  }

  if (!r.json) {
    throw new Error('B站接口返回非 JSON（HTTP ' + r.status + '）')
  }
  return r.json
}

// ==================== 条目映射 ====================

// 直播回放 / 录屏 / 超长合集：听歌场景里是纯噪声
function isNoise(raw, item) {
  const tag = cleanText(raw.tag || '')
  if (tag.indexOf('直播') >= 0 && (tag.indexOf('录屏') >= 0 || tag.indexOf('回放') >= 0)) {
    return true
  }
  const title = item.title
  if (title.indexOf('直播回放') >= 0) return true
  const sec = item.duration || 0
  if (sec > 0 && sec < 30) return true
  if (sec > 20 * 60) return true
  return false
}

function mapVideo(v) {
  if (!v || typeof v !== 'object') return null
  const bvid = String(v.bvid || '')
  const aid = v.aid
  if (!bvid && !aid) return null
  const title = cleanText(v.title)
  if (!title) return null
  const owner =
    (v.owner && v.owner.name) || v.author || (v.upper && v.upper.name) || ''
  const sec = parseDuration(v.duration)
  const out = {
    id: bvid || String(aid),
    bvid: bvid,
    aid: aid,
    title: title,
    artist: cleanText(owner),
    album: '',
    artwork: fixUrl(v.pic || v.cover || ''),
    platform: 'bilibili',
  }
  if (sec > 0) out.duration = sec
  return out
}

// ==================== 搜索 ====================

async function searchVideos(keyword, page) {
  const p = Math.max(1, parseInt(page, 10) || 1)
  const d = await apiGet(
    '/x/web-interface/search/type',
    {
      search_type: 'video',
      keyword: keyword,
      page: p,
      page_size: PAGE_SIZE,
      order: 'totalrank',
      platform: 'pc',
      highlight: 1,
    },
    { cookie: true, referer: 'https://search.bilibili.com/' },
  )
  if (!d || d.code !== 0) {
    const code = d && d.code
    if (code === -412) throw new Error('B站搜索被限流，请稍后重试')
    throw new Error('B站搜索失败：' + ((d && d.message) || '未知错误'))
  }
  const data = d.data || {}
  const raw = data.result || []
  const items = []
  for (let i = 0; i < raw.length; i++) {
    const item = mapVideo(raw[i])
    if (item && !isNoise(raw[i], item)) items.push(item)
  }
  return { items: items, numResults: data.numResults || 0 }
}

// ==================== 稿件详情 / 取流 ====================

const viewCache = {}

async function fetchView(bvid, aid) {
  const key = bvid || 'av' + aid
  const hit = viewCache[key]
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data
  const d = await apiGet('/x/web-interface/view', bvid ? { bvid: bvid } : { aid: aid })
  if (!d || d.code !== 0 || !d.data) {
    throw new Error('B站稿件信息获取失败：' + ((d && d.message) || '未知错误'))
  }
  viewCache[key] = { data: d.data, at: Date.now() }
  const keys = Object.keys(viewCache)
  if (keys.length > 200) delete viewCache[keys[0]]
  return d.data
}

async function fetchPlayInfo(bvid, aid, cid) {
  const params = bvid
    ? { bvid: bvid, cid: cid, fnval: 16, fourk: 1 }
    : { avid: aid, cid: cid, fnval: 16, fourk: 1 }
  const d = await apiGet('/x/player/playurl', params)
  if (!d || d.code !== 0 || !d.data) {
    throw new Error('B站播放地址获取失败：' + ((d && d.message) || '未知错误'))
  }
  return d.data
}

// 宿主档位字符串（MusicFree 的 low/standard/high/super 与落雪的 128k/320k/flac 都可能来）
function normalizeQuality(q) {
  const s = String(q || '').toLowerCase()
  if (
    s === 'super' ||
    s === 'flac' ||
    s === 'flac24bit' ||
    s === 'hires' ||
    s === 'dolby' ||
    s === 'master' ||
    s === 'atmos' ||
    s === 'atmos_plus'
  ) {
    return 'super'
  }
  if (s === 'high' || s === '320k' || s === 'exhigh' || s === '192k') return 'high'
  if (s === 'standard' || s === '132k') return 'standard'
  return 'low'
}

// B 站音轨 id：30216=64K / 30232=132K / 30280=192K / 30250=Dolby / 30251=Hi-Res
const AUDIO_ID = { low: 30216, standard: 30232, high: 30280 }

/**
 * 选轨（核心修复点）。
 * 按 id 精确命中目标档；缺失就退到最接近的一档，永远不返回 undefined。
 * super 先看 Hi-Res（需登录）/ Dolby（需大会员），都没有就退最高码率 AAC。
 */
function pickAudio(dash, quality) {
  const want = normalizeQuality(quality)
  const audios = (dash.audio || [])
    .slice()
    .sort(function (a, b) {
      return (a.bandwidth || 0) - (b.bandwidth || 0)
    })
  const flac = dash.flac && dash.flac.audio
  const dolby =
    dash.dolby && dash.dolby.audio && dash.dolby.audio.length
      ? dash.dolby.audio[0]
      : null

  if (want === 'super') {
    if (flac && flac.baseUrl) return flac
    if (dolby && dolby.baseUrl) return dolby
  }
  if (!audios.length) return null

  // 没有 Hi-Res / Dolby 时，super 退到最高码率 AAC（不能掉到最低档）
  if (want === 'super') return audios[audios.length - 1]

  const targetId = AUDIO_ID[want]
  for (let i = 0; i < audios.length; i++) {
    if (audios[i].id === targetId) return audios[i]
  }
  if (want === 'high') return audios[audios.length - 1]
  if (want === 'standard') return audios[Math.min(1, audios.length - 1)]
  return audios[0]
}

function hostOf(url) {
  const parts = String(url || '').split('/')
  return parts.length > 2 ? parts[2] : ''
}

// PCDN 特征：mcdn 域名、第三方 PCDN 域名、非 443 自定义端口
function isPcdn(url) {
  const s = String(url || '')
  if (s.indexOf('mcdn') >= 0 || s.indexOf('os=mcdn') >= 0) return true
  if (s.indexOf('mountaintoys') >= 0) return true
  const host = hostOf(s)
  return host.indexOf(':') >= 0
}

/**
 * 选链：PCDN（mcdn / edge.mountaintoys）是边缘节点，失效时表现为
 * 「能连上但读不到数据」，播放器直接卡死，所以优先官方对象存储直链。
 */
function pickUrl(track) {
  const urls = []
  const push = function (u) {
    if (typeof u === 'string' && u && urls.indexOf(u) < 0) urls.push(u)
  }
  push(track.baseUrl || track.base_url)
  const backups = track.backupUrl || track.backup_url || []
  for (let i = 0; i < backups.length; i++) push(backups[i])
  if (!urls.length) return ''

  let i
  // 1) upos-* 对象存储直链
  for (i = 0; i < urls.length; i++) {
    if (urls[i].indexOf('upos-') >= 0 && !isPcdn(urls[i])) return urls[i]
  }
  // 2) 任意 bilivideo.com 非 PCDN 节点
  for (i = 0; i < urls.length; i++) {
    if (hostOf(urls[i]).indexOf('bilivideo.com') >= 0 && !isPcdn(urls[i])) {
      return urls[i]
    }
  }
  // 3) 只要不是 PCDN 就行
  for (i = 0; i < urls.length; i++) {
    if (!isPcdn(urls[i])) return urls[i]
  }
  // 4) 全是 PCDN 也只能用它
  return urls[0]
}

async function getMediaSource(musicItem, quality) {
  let bvid = String(musicItem.bvid || '')
  let aid = musicItem.aid
  // 队列里可能只带 id（纯数字即 aid），补一下
  if (!aid && /^\d+$/.test(String(musicItem.id || ''))) {
    aid = Number(musicItem.id)
  }
  let cid = musicItem.cid

  // 没有 bvid 的条目（少数搜索结果只给 aid）先查稿件补 bvid：
  // playurl 用 bvid 走的链路比 avid 稳，aid 查询会退成老 flv 列表
  if (!cid || !bvid) {
    const view = await fetchView(bvid, aid)
    if (!cid) cid = view.cid
    if (!bvid && view.bvid) bvid = view.bvid
  }
  if (!cid) throw new Error('B站稿件缺少 cid，无法取流')

  const data = await fetchPlayInfo(bvid || null, aid, cid)
  const pageUrl = bvid ? WEB + '/video/' + bvid : WEB + '/video/av' + aid
  const headers = {
    'user-agent': UA,
    referer: pageUrl,
    origin: WEB,
  }

  const dash = data.dash
  if (dash) {
    const track = pickAudio(dash, quality)
    if (track) {
      const url = pickUrl(track)
      if (url) return { url: url, headers: headers }
    }
  }

  // 老稿件可能没有 DASH，只有整段 flv/mp4
  const durl = data.durl
  if (durl && durl.length && durl[0].url) {
    return { url: durl[0].url, headers: headers }
  }
  throw new Error('B站未返回可用音轨（可能需要大会员或该稿件受限）')
}

// ==================== 多 P 稿件拆轨 ====================

async function getAlbumInfo(albumItem) {
  const view = await fetchView(
    String(albumItem.bvid || ''),
    albumItem.aid,
  )
  const pages = view.pages || []
  if (pages.length <= 1) {
    return {
      musicList: [Object.assign({}, albumItem, { cid: view.cid })],
    }
  }
  const list = []
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]
    list.push(
      Object.assign({}, albumItem, {
        id: String(p.cid),
        cid: p.cid,
        title: cleanText(p.part) || albumItem.title + ' P' + (i + 1),
        duration: parseDuration(p.duration),
        artwork: albumItem.artwork,
      }),
    )
  }
  return { musicList: list }
}

// ==================== 榜单 ====================

// 榜单首页会反复拉，网络部分做 10 分钟缓存，避免每次进首页都打接口
let topListsCache = null
let topListsAt = 0

async function getTopLists() {
  if (topListsCache && Date.now() - topListsAt < 10 * 60 * 1000) {
    return topListsCache
  }
  const boards = {
    title: '排行榜',
    data: [
      { id: 'ranking/v2?rid=3&type=all', title: '音乐', coverImg: ICON_RANK },
      { id: 'ranking/v2?rid=0&type=origin', title: '原创', coverImg: ICON_RANK },
      { id: 'ranking/v2?rid=0&type=rookie', title: '新人', coverImg: ICON_RANK },
    ],
  }

  const groups = []
  try {
    const d = await apiGet('/x/web-interface/popular/series/list', null, {
      referer: WEB + '/v/popular/all',
    })
    if (d && d.code === 0 && d.data && d.data.list && d.data.list.length) {
      const data = []
      const slice = d.data.list.slice(0, 6)
      for (let i = 0; i < slice.length; i++) {
        const e = slice[i]
        data.push({
          id: 'popular/series/one?number=' + e.number,
          title: e.subject || '第' + e.number + '期',
          description: e.name || '',
          coverImg: ICON_WEEKLY,
        })
      }
      groups.push({ title: '每周必看', data: data })
    }
  } catch (e) {
    // 每周必看拿不到不影响音乐榜
  }

  groups.push(boards)
  topListsCache = groups
  topListsAt = Date.now()
  return groups
}

async function getTopListDetail(topListItem) {
  const d = await apiGet('/x/web-interface/' + topListItem.id, null, {
    referer: WEB + '/',
  })
  if (!d || d.code !== 0 || !d.data) {
    throw new Error('B站榜单获取失败：' + ((d && d.message) || '未知错误'))
  }
  const raw = d.data.list || []
  const musicList = []
  for (let i = 0; i < raw.length; i++) {
    const item = mapVideo(raw[i])
    // 榜单里混着 15 秒的整活视频和 1 小时的合集，当歌听都是噪声
    if (item && !isNoise(raw[i], item)) musicList.push(item)
  }
  return Object.assign({}, topListItem, { musicList: musicList })
}

// ==================== 收藏夹导入 ====================

function parseFavId(urlLike) {
  const s = String(urlLike || '').trim()
  if (!s) return ''
  let m = s.match(/^\s*(\d+)\s*$/)
  if (m) return m[1]
  m = s.match(/[?&]fid=(\d+)/)
  if (m) return m[1]
  m = s.match(/\/playlist\/pl(\d+)/i)
  if (m) return m[1]
  m = s.match(/\/list\/ml(\d+)/i)
  if (m) return m[1]
  return ''
}

async function importMusicSheet(urlLike) {
  const id = parseFavId(urlLike)
  if (!id) throw new Error('无法识别收藏夹 ID，请粘贴收藏夹链接或直接输入数字 ID')

  const musicList = []
  for (let pn = 1; pn <= 20; pn++) {
    const d = await apiGet('/x/v3/fav/resource/list', {
      media_id: id,
      platform: 'web',
      ps: PAGE_SIZE,
      pn: pn,
    })
    if (!d || d.code !== 0 || !d.data) {
      if (pn === 1) {
        if (d && d.code === 0) throw new Error('收藏夹不存在或未公开，请确认是公开收藏夹')
        throw new Error('收藏夹读取失败：' + ((d && d.message) || '未知错误'))
      }
      break
    }
    const medias = d.data.medias || []
    for (let i = 0; i < medias.length; i++) {
      const m = medias[i]
      if (!m || m.type !== 2) continue // 2 = 视频，其余是音频/专栏，播放链不同
      const item = mapVideo(m)
      if (item) musicList.push(item)
    }
    if (!d.data.has_more) break
  }
  return musicList
}

// ==================== 导出 ====================

module.exports = {
  platform: 'bilibili',
  version: '1.0.0',
  author: '音狐',
  srcUrl:
    'https://cdn.jsdelivr.net/gh/WangMCweijia/lx-source-dist@main/bilibili.js',
  cacheControl: 'no-cache',
  primaryKey: ['id', 'bvid', 'aid', 'cid'],
  supportedSearchType: ['music'],
  hints: {
    importMusicSheet: [
      'B 站收藏夹：复制收藏夹链接（含 fid= 或 /playlist/pl）粘贴即可，也可直接输入数字 ID',
      '收藏夹需为公开状态，私密收藏夹无法读取',
      '收藏夹里的音频/专栏条目会被跳过，只导入视频稿件',
    ],
  },
  search: async function (keyword, page, type) {
    if (type && type !== 'music' && type !== 'album') {
      return { isEnd: true, data: [] }
    }
    const res = await searchVideos(keyword, page)
    return {
      isEnd: res.numResults <= (parseInt(page, 10) || 1) * PAGE_SIZE,
      data: res.items,
    }
  },
  getMediaSource: getMediaSource,
  getAlbumInfo: getAlbumInfo,
  getTopLists: getTopLists,
  getTopListDetail: getTopListDetail,
  importMusicSheet: importMusicSheet,
}
