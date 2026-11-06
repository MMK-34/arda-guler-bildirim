/* Arda Güler gol & asist bildirim PWA */
(() => {
  'use strict';

  const CFG = {
    athleteId: '310452',
    athleteName: 'Arda Güler',
    teamIds: ['86', '465'], // Real Madrid, Türkiye
    ntfyTopic: 'arda-guler-gol-mmk34',
    // Takip edilen ligler (Real Madrid + Türkiye). site.web.api.espn.com tarayıcıdan CORS ile erişilebilir.
    leagues: ['esp.1', 'uefa.champions', 'esp.copa_del_rey', 'esp.super_cup', 'uefa.super_cup', 'fifa.cwc',
              'uefa.nations', 'fifa.friendly', 'uefa.euroq', 'uefa.euro', 'fifa.worldq.uefa', 'fifa.world'],
    scoreboard: (l, d) => `https://site.web.api.espn.com/apis/site/v2/sports/soccer/${l}/scoreboard?dates=${d}`,
    summary: (l, id) => `https://site.web.api.espn.com/apis/site/v2/sports/soccer/${l}/summary?event=${id}`,
    overview: 'https://site.web.api.espn.com/apis/common/v3/sports/soccer/esp.1/athletes/310452/overview',
    pollLive: 40_000,
    pollNear: 60_000,
    pollIdle: 300_000
  };

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };

  const seen = new Set(store.get('ag_seen', []));
  let feed = store.get('ag_feed', []);
  let timer = null;
  let swReg = null;
  let deferredInstall = null;
  let lastOverview = null;

  // ---------- yardımcılar ----------
  const fmtDate = (iso) => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ESPN günleri UTC'ye göre listeler; Türkiye saatiyle "bugün" ve "yarın" da dahil edilir.
  function datesToCheck() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const local = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const set = new Set([ymd(now)]);
    const y = new Date(now); y.setUTCDate(y.getUTCDate() - 1);
    if (now.getUTCHours() < 4) set.add(ymd(y));
    set.add(local(now));
    const t = new Date(now); t.setDate(t.getDate() + 1);
    set.add(local(t));
    return [...set];
  }

  // ---------- bildirim ----------
  async function notify(title, body, key, url) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const opts = {
      body,
      icon: './icons/icon-192.png',
      badge: './icons/badge-96.png',
      vibrate: [200, 100, 200, 100, 500],
      tag: key,
      renotify: true,
      requireInteraction: true,
      data: { url: url || './' }
    };
    try {
      const reg = swReg || (navigator.serviceWorker && (await navigator.serviceWorker.ready));
      if (reg) return reg.showNotification(title, opts);
    } catch (_) {}
    try { new Notification(title, opts); } catch (_) {}
  }

  function updatePermUI() {
    const supported = 'Notification' in window;
    const granted = supported && Notification.permission === 'granted';
    $('permCard').classList.toggle('hidden', granted || !supported);
    if (supported && Notification.permission === 'denied') {
      $('permCard').querySelector('p').innerHTML = '<strong>Bildirim izni engellenmiş</strong>Tarayıcı ayarlarından bu siteye bildirim iznini aç.';
      $('permBtn').disabled = true;
    }
  }

  // ---------- maç tarama ----------
  function isTracked(ev) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return false;
    return comp.competitors.some((c) => CFG.teamIds.includes(String(c.team && c.team.id)));
  }

  async function fetchTrackedEvents() {
    const out = [];
    const jobs = [];
    for (const d of datesToCheck()) for (const l of CFG.leagues) {
      jobs.push(getJSON(CFG.scoreboard(l, d)).then((sb) => {
        for (const ev of sb.events || []) if (isTracked(ev) && !out.some((e) => e.id === ev.id)) { ev._league = l; out.push(ev); }
      }).catch((e) => console.warn('scoreboard', l, d, e.message)));
    }
    await Promise.all(jobs);
    return out;
  }

  // Skor + gol sayısı imzası: değişmeden özet (büyük) indirilmez.
  const sigs = {};
  function goalSig(ev) {
    const comp = ev.competitions[0];
    const goals = (comp.details || []).filter((x) => x.scoringPlay).length;
    return comp.competitors.map((c) => c.score ?? 0).join('-') + '|' + goals + '|' + eventState(ev);
  }

  function eventState(ev) {
    const st = (ev.status && ev.status.type) || (ev.competitions[0].status && ev.competitions[0].status.type) || {};
    return st.state || 'pre';
  }

  function minutesTo(ev) { return (new Date(ev.date) - Date.now()) / 60000; }

  function shouldScan(ev) {
    const s = eventState(ev);
    if (s === 'in') return true;
    if (s === 'post') return minutesTo(ev) > -200; // bitişten sonra ~1.5 saat daha tara (VAR / geç işlenen olaylar)
    return false;
  }

  function scanSummary(sum, ev) {
    const found = [];
    const comp = ev.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    const matchName = `${home.team.shortDisplayName || home.team.displayName} - ${away.team.shortDisplayName || away.team.displayName}`;
    const link = (ev.links && ev.links[0] && ev.links[0].href) || `https://www.espn.com/soccer/match/_/gameId/${ev.id}`;

    for (const ke of sum.keyEvents || []) {
      if (!ke.scoringPlay) continue;
      const type = (ke.type && ke.type.text) || '';
      if (/own goal/i.test(type)) continue;
      const ps = ke.participants || [];
      const scorer = ps[0] && ps[0].athlete;
      const assister = ps[1] && ps[1].athlete;
      let kind = null;
      if (scorer && String(scorer.id) === CFG.athleteId) kind = 'gol';
      else if (assister && String(assister.id) === CFG.athleteId) kind = 'asist';
      if (!kind) continue;
      const key = `ke:${ke.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const minute = (ke.clock && ke.clock.displayValue) || '';
      const scoreTxt = (ke.text || '').match(/Goal!\s*([^.]+)\./);
      const item = {
        id: key, kind, minute, match: matchName, link,
        score: scoreTxt ? scoreTxt[1].trim() : '',
        detail: kind === 'gol' && /penalty/i.test(type) ? 'Penaltı' : (kind === 'asist' && scorer ? `Gol: ${scorer.displayName}` : ''),
        ts: Date.now()
      };
      found.push(item);
    }
    return found;
  }

  async function tick(manual) {
    setStatus('Kontrol ediliyor…', '');
    let events = [];
    try { events = await fetchTrackedEvents(); } catch (e) { console.warn(e); }

    const live = events.filter((e) => eventState(e) === 'in');
    const scanList = events.filter(shouldScan);
    let newItems = [];
    for (const ev of scanList) {
      const sig = goalSig(ev);
      if (!manual && sigs[ev.id] === sig) continue; // yeni gol yoksa özet indirme
      try {
        const sum = await getJSON(CFG.summary(ev._league || 'all', ev.id));
        newItems = newItems.concat(scanSummary(sum, ev));
        sigs[ev.id] = sig;
      } catch (e) { console.warn('summary', ev.id, e); }
    }

    if (newItems.length) {
      feed = newItems.concat(feed).slice(0, 100);
      store.set('ag_seen', [...seen].slice(-500));
      store.set('ag_feed', feed);
      for (const it of newItems) {
        const title = it.kind === 'gol' ? `⚽ GOOOL! Arda Güler ${it.minute}` : `🎯 ASİST! Arda Güler ${it.minute}`;
        const body = `${it.match}${it.score ? ' · ' + it.score : ''}${it.detail ? ' · ' + it.detail : ''}`;
        notify(title, body, it.id, it.link);
      }
      renderFeed();
      if (manual) toast(`${newItems.length} yeni olay!`);
    } else if (manual) {
      toast(live.length ? 'Maç canlı, yeni olay yok' : 'Yeni olay yok');
    }

    renderMatch(events);
    $('last').textContent = fmtTime(Date.now());

    // sonraki kontrol
    let delay = CFG.pollIdle;
    if (live.length) delay = CFG.pollLive;
    else if (events.some((e) => { const m = minutesTo(e); return (eventState(e) === 'pre' && m < 20) || (eventState(e) === 'post' && m > -200); })) delay = CFG.pollNear;
    schedule(delay);
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(() => tick(false), ms);
  }

  // ---------- render ----------
  function setStatus(text, cls) {
    const s = $('status'); s.textContent = text; s.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function renderMatch(events) {
    const box = $('matchBox');
    const live = events.filter((e) => eventState(e) === 'in');
    const upcoming = events.filter((e) => eventState(e) === 'pre').sort((a, b) => new Date(a.date) - new Date(b.date));
    const recent = events.filter((e) => eventState(e) === 'post').sort((a, b) => new Date(b.date) - new Date(a.date));
    const ev = live[0] || upcoming[0] || recent[0];

    if (live.length) setStatus('CANLI', 'live');
    else if (upcoming.length && minutesTo(upcoming[0]) < 180) setStatus('Maç yakında', 'soon');
    else setStatus('Maç yok', '');

    if (!ev) {
      $('matchTitle').textContent = 'Sonraki maç';
      renderNextFromOverview();
      return;
    }
    $('matchTitle').textContent = live.length ? 'Canlı maç' : (upcoming.length ? 'Bugünkü maç' : 'Son maç');
    const comp = ev.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    const st = (ev.status || comp.status) || {};
    const state = eventState(ev);
    const scoreOrTime = state === 'pre'
      ? `<div class="score" style="font-size:20px">${esc(new Date(ev.date).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }))}</div>`
      : `<div class="score">${esc(home.score ?? 0)} : ${esc(away.score ?? 0)}</div>`;
    const clock = state === 'in' ? (st.displayClock || '') : (state === 'post' ? 'Bitti' : fmtDate(ev.date));
    const logo = (t) => (t.team.logo ? `<img src="${esc(t.team.logo)}" alt="">` : '');
    box.innerHTML = `
      <div class="match">
        <div class="team">${logo(home)}${esc(home.team.shortDisplayName || home.team.displayName)}</div>
        <div>${scoreOrTime}<div class="clock">${esc(clock)}</div></div>
        <div class="team">${logo(away)}${esc(away.team.shortDisplayName || away.team.displayName)}</div>
      </div>
      <div class="meta">${esc((ev.season && ev.season.slug ? ev.season.slug.replace(/^\d{4}-\d{2}-/, '').toUpperCase() + ' · ' : '') + ((comp.venue && comp.venue.fullName) || ''))}</div>`;
  }

  function renderNextFromOverview() {
    const box = $('matchBox');
    const ng = lastOverview && lastOverview.nextGame && lastOverview.nextGame.league && lastOverview.nextGame.league.events && lastOverview.nextGame.league.events[0];
    if (!ng) { box.innerHTML = '<div class="empty">Planlanmış maç bulunamadı.</div>'; return; }
    box.innerHTML = `
      <div style="text-align:center">
        <div style="font-weight:700;font-size:17px">${esc(ng.name)}</div>
        <div class="meta">${esc(fmtDate(ng.date))} · ${esc(lastOverview.nextGame.league.name || '')}${ng.location ? ' · ' + esc(ng.location) : ''}</div>
      </div>`;
  }

  function renderFeed() {
    const f = $('feed');
    if (!feed.length) { f.innerHTML = '<div class="empty">Henüz yakalanan gol/asist yok. Maç başlayınca burası dolar.</div>'; return; }
    f.innerHTML = feed.map((it) => `
      <div class="item ${it.kind}">
        <div class="ic">${it.kind === 'gol' ? '⚽' : '🎯'}</div>
        <div class="t"><b>${it.kind === 'gol' ? 'GOL' : 'ASİST'} ${esc(it.minute)}</b><span>${esc(it.match)}${it.score ? ' · ' + esc(it.score) : ''}${it.detail ? ' · ' + esc(it.detail) : ''}</span></div>
        <div class="r">${esc(new Date(it.ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }))}<br>${esc(fmtTime(it.ts))}</div>
      </div>`).join('');
  }

  async function loadOverview() {
    try {
      const d = await getJSON(CFG.overview);
      lastOverview = d;
      const st = d.statistics || {};
      const gi = (st.names || []).indexOf('totalGoals');
      const ai = (st.names || []).indexOf('goalAssists');
      let G = 0, A = 0;
      const rows = [];
      for (const sp of st.splits || []) {
        const g = +sp.stats[gi] || 0, a = +sp.stats[ai] || 0;
        G += g; A += a;
        rows.push(`<div class="item"><div class="t"><b style="font-size:14px">${esc(sp.displayName)}</b></div><div class="r" style="font-size:13px">${g} gol · ${a} asist</div></div>`);
      }
      $('totG').textContent = G; $('totA').textContent = A;
      $('comps').innerHTML = rows.join('');
      if ($('matchTitle').textContent === 'Sonraki maç') renderNextFromOverview();
    } catch (e) { console.warn('overview', e); }
  }

  // ---------- kurulum / eventler ----------
  async function init() {
    if ('serviceWorker' in navigator) {
      try { swReg = await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('sw', e); }
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'OPEN_URL') window.open(e.data.url, '_blank', 'noopener');
      });
    }
    updatePermUI();

    $('permBtn').onclick = async () => {
      const p = await Notification.requestPermission();
      updatePermUI();
      if (p === 'granted') { toast('Bildirimler açık'); notify('Hazır! 🟡', 'Arda Güler gol veya asist yapınca haber vereceğim.', 'welcome'); }
    };
    $('testBtn').onclick = () => {
      if (Notification.permission !== 'granted') { toast('Önce bildirim izni ver'); return; }
      notify('⚽ GOOOL! Arda Güler 67\'', 'Real Madrid - Valencia · Real Madrid 2, Valencia 0 (test)', 'test-' + Date.now(), './');
    };
    $('checkBtn').onclick = () => tick(true);
    $('clearBtn').onclick = () => { feed = []; store.set('ag_feed', feed); renderFeed(); toast('Geçmiş silindi'); };
    $('copyTopic').onclick = async () => {
      try { await navigator.clipboard.writeText(CFG.ntfyTopic); toast('Kopyalandı'); } catch (_) { toast(CFG.ntfyTopic); }
    };

    // kurulum
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferredInstall = e;
      $('installCard').classList.remove('hidden'); $('installBtn').classList.remove('hidden');
    });
    $('installBtn').onclick = async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null;
      $('installCard').classList.add('hidden');
    };
    if (!standalone && isIOS) {
      $('installText').textContent = 'Safari\'de Paylaş → "Ana Ekrana Ekle". iPhone\'da bildirimler sadece ana ekrana eklenmiş uygulamada çalışır.';
      $('installCard').classList.remove('hidden');
    }
    window.addEventListener('appinstalled', () => { $('installCard').classList.add('hidden'); toast('Yüklendi'); });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(false); });

    renderFeed();
    loadOverview();
    tick(false);
  }

  init();
  // hata ayıklama
  window.__ag = { tick, scanSummary, seen, getFeed: () => feed, CFG };
})();
