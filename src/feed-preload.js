// Feed 抓取专用 preload 脚本 - 在页面渲染前执行，绕过 CSP 限制
const { ipcRenderer } = require('electron')

window.addEventListener('load', function() {
  var waitMs = 5000
  var url = window.location.href
  var isFacebook = url.indexOf('facebook.com') > -1
  var isInstagram = url.indexOf('instagram.com') > -1
  if (isFacebook || isInstagram) waitMs = 6000

  setTimeout(function() {
    // Facebook 先滚动触发懒加载，再等2秒抓取
    if (isFacebook) {
      window.scrollTo(0, 600)
      setTimeout(function() {
        window.scrollTo(0, 1200)
        setTimeout(function() {
          window.scrollTo(0, 0)
          setTimeout(function() {
            try {
              var result = collectItems()
              ipcRenderer.send('feed-items-collected', result)
            } catch(e) {
              ipcRenderer.send('feed-items-collected', { error: e.message, items: [], url: window.location.href })
            }
          }, 2000)
        }, 1000)
      }, 1000)
    } else {
      try {
        var result = collectItems()
        ipcRenderer.send('feed-items-collected', result)
      } catch(e) {
        ipcRenderer.send('feed-items-collected', { error: e.message, items: [], url: window.location.href })
      }
    }
  }, waitMs)
})

function collectItems() {
  var items = []
  var url = window.location.href
  var platform = 'unknown'

  if (url.indexOf('facebook.com') > -1) platform = 'facebook'
  else if (url.indexOf('instagram.com') > -1) platform = 'instagram'
  else if (url.indexOf('xiaohongshu.com') > -1) platform = 'xiaohongshu'
  else if (url.indexOf('x.com') > -1 || url.indexOf('twitter.com') > -1) platform = 'x'

  // ── Facebook ──
  if (platform === 'facebook') {
    var allLinks = document.querySelectorAll('a[href]')
    for (var i = 0; i < allLinks.length; i++) {
      var a = allLinks[i]
      var href = a.href || ''
      if (!href) continue
      var isPost = false
      if (href.indexOf('/posts/') > -1) isPost = true
      if (href.indexOf('/videos/') > -1 && /\/videos\/[\w]+/.test(href)) isPost = true
      if (href.indexOf('/reel/') > -1 && /\/reel\/[\w]+/.test(href)) isPost = true
      if (href.indexOf('story_fbid') > -1) isPost = true
      if (href.indexOf('permalink') > -1) isPost = true
      if (href.indexOf('/share/p/') > -1) isPost = true
      if (href.indexOf('/share/v/') > -1) isPost = true
      if (href.indexOf('/share/r/') > -1) isPost = true
      // 排除纯导航页（没有具体内容ID的）
      if (href === 'https://www.facebook.com/posts/' || href === 'https://www.facebook.com/videos/') isPost = false
      if (!isPost) continue

      var stableId = href
      try { var u = new URL(href); stableId = u.origin + u.pathname } catch(e) {}

      var text = ''
      var el = a.parentElement
      for (var ci = 0; ci < 8 && el; ci++) {
        var t = el.innerText || el.textContent || ''
        if (t.length > 20) { text = t.substring(0, 300).replace(/\s+/g, ' ').trim(); break }
        el = el.parentElement
      }

      var publishedAt = ''
      var sel = a.parentElement
      for (var si = 0; si < 15 && sel; si++) {
        var timeEl = sel.querySelector('time')
        if (timeEl) { publishedAt = timeEl.getAttribute('datetime') || ''; break }
        var abbrEl = sel.querySelector('abbr[data-utime]')
        if (abbrEl) { var ut = abbrEl.getAttribute('data-utime'); if (ut) publishedAt = new Date(parseInt(ut)*1000).toISOString(); break }
        var spans = sel.querySelectorAll('span')
        for (var spi = 0; spi < spans.length; spi++) {
          var st = (spans[spi].textContent || '').trim()
          if (st.length > 0 && st.length < 10 && /\d/.test(st) && /分钟|小时|天|周|h|d|w|m/.test(st)) {
            publishedAt = st; break
          }
        }
        if (publishedAt) break
        sel = sel.parentElement
      }

      var found = false
      for (var ii = 0; ii < items.length; ii++) { if (items[ii].id === stableId) { found = true; break } }
      if (!found && stableId) items.push({ id: stableId, url: href, title: text.substring(0,100) || '内容', summary: text.substring(0,200), type: 'article', publishedAt: publishedAt })
    }
  }

  // ── Instagram ──
  else if (platform === 'instagram') {
    function igShortcodeToDate(shortcode) {
      try {
        var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
        var n = BigInt(0)
        for (var i = 0; i < Math.min(shortcode.length, 11); i++) {
          n = n * BigInt(64) + BigInt(chars.indexOf(shortcode[i]))
        }
        var ms = Number(n >> BigInt(23)) + 1314220021721
        var d = new Date(ms)
        if (d.getFullYear() >= 2012 && d.getFullYear() <= new Date().getFullYear() + 1) return d.toISOString()
      } catch(e) {}
      return ''
    }
    function igLinkToDate(link) {
      var m = link.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)
      return m ? igShortcodeToDate(m[2]) : ''
    }
    var igLinks = document.querySelectorAll('a[href*="/p/"],a[href*="/reel/"],a[href*="/tv/"]')
    for (var i = 0; i < igLinks.length; i++) {
      var a = igLinks[i]
      var link = a.href || ''
      if (!link) continue
      var alt = (a.querySelector('img') || {}).alt || ''
      var isReel = link.indexOf('/reel/') > -1 || link.indexOf('/tv/') > -1
      var timeEl = document.querySelector('time')
      var publishedAt = (timeEl && timeEl.getAttribute('datetime')) || igLinkToDate(link)
      var id = link.split('?')[0]
      var found = false
      for (var ii = 0; ii < items.length; ii++) { if (items[ii].id === id) { found = true; break } }
      if (!found && id) items.push({ id: id, url: link, title: alt.substring(0,100) || (isReel ? '视频' : '图片'), summary: alt.substring(0,200), type: isReel ? 'video' : 'image', publishedAt: publishedAt })
    }
  }

  // ── 小红书 ──
  else if (platform === 'xiaohongshu') {
    var notes = document.querySelectorAll('section.note-item, .note-item')
    for (var i = 0; i < notes.length; i++) {
      var el = notes[i]
      var titleEl = el.querySelector('.title, .desc, .footer .title')
      var title = titleEl ? (titleEl.textContent || '').trim() : ''
      var aEl = el.querySelector('a')
      if (!aEl) continue
      var link = aEl.href.indexOf('http') === 0 ? aEl.href : 'https://www.xiaohongshu.com' + aEl.getAttribute('href')
      var type = (el.querySelector('video, .video-mask')) ? 'video' : 'article'
      var timeEl = el.querySelector('time')
      var publishedAt = timeEl ? (timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || '') : ''
      var id = link.split('?')[0]
      items.push({ id: id, url: link, title: title, summary: '', type: type, publishedAt: publishedAt })
    }
  }

  // ── X (Twitter) ──
  else if (platform === 'x') {
    var articles = document.querySelectorAll('article[data-testid="tweet"]')
    for (var i = 0; i < articles.length; i++) {
      var el = articles[i]
      var textEl = el.querySelector('[data-testid="tweetText"]')
      var text = textEl ? (textEl.textContent || '').trim() : ''
      var timeEl = el.querySelector('time')
      var publishedAt = timeEl ? (timeEl.getAttribute('datetime') || '') : ''
      var aEl = timeEl ? timeEl.closest('a') : null
      var link = aEl ? (aEl.href.indexOf('http') === 0 ? aEl.href : 'https://x.com' + aEl.getAttribute('href')) : ''
      var hasImg = !!el.querySelector('[data-testid="tweetPhoto"]')
      var hasVideo = !!el.querySelector('video')
      var type = hasVideo ? 'video' : hasImg ? 'image' : 'article'
      var id = link || text.substring(0, 80)
      if (id) {
        var found = false
        for (var ii = 0; ii < items.length; ii++) { if (items[ii].id === id) { found = true; break } }
        if (!found) items.push({ id: id, url: link, title: text.substring(0,100), summary: text.substring(0,200), type: type, publishedAt: publishedAt })
      }
    }
  }

  return { platform: platform, url: url, items: items }
}
