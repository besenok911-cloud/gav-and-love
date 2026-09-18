/* ============================================================
   Little Paw by Hanna — site logic
   ============================================================ */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion:reduce)").matches;
  // Always open at the top (don't let the browser restore a previous scroll
  // position), unless the URL points at a specific section (#booking, …).
  if ("scrollRestoration" in history) { try { history.scrollRestoration = "manual"; } catch (e) {} }
  if (!location.hash) { addEventListener("load", () => scrollTo(0, 0)); }

  /* ---- Config the owner can tweak ---- */
  const CONFIG = {
    phone: "+380685575727",
    phoneLabel: "+38 068 557 57 27",
    telegram: "https://t.me/+380685575727",
    viber: "viber://chat?number=%2B380685575727",
    // Booking endpoint (Cloudflare Worker → Google Calendar + Telegram). Empty = demo mode.
    bookingEndpoint: "https://gavlove-booking.besenok911.workers.dev",
  };

  /* ---- Year ---- */
  $("#year").textContent = new Date().getFullYear();

  /* ---- Contact links ---- */
  const phoneLink = $("#phoneLink");
  if (phoneLink) { phoneLink.href = "tel:" + CONFIG.phone; phoneLink.textContent = CONFIG.phoneLabel; }
  if ($("#tgLink")) $("#tgLink").href = CONFIG.telegram;
  if ($("#vbLink")) $("#vbLink").href = CONFIG.viber;

  /* ---- Header scroll state ---- */
  const header = $("#siteHeader");
  const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 12);
  onScroll(); addEventListener("scroll", onScroll, { passive: true });

  /* ---- Hero scroll hint: go to the first section that is actually shown (CMS may hide some) ---- */
  const hint = $(".scroll-hint");
  if (hint) hint.addEventListener("click", e => {
    const target = $("main > section, body > section").find(s => s.id !== "home" && !s.hidden && s.offsetParent !== null);
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: "smooth" }); }
  });

  /* ---- Mobile sticky CTA: appears after the hero, hides while the booking form is on screen ---- */
  const mobCta = $("#mobCta"), bookingSec = $("#booking");
  if (mobCta && "IntersectionObserver" in window) {
    let heroOut = false, bookingIn = false;
    const apply = () => { const show = heroOut && !bookingIn; mobCta.classList.toggle("show", show); mobCta.setAttribute("aria-hidden", String(!show)); document.body.classList.toggle("has-cta", show); };
    const heroEl = $("#home"); if (heroEl) new IntersectionObserver(es => { heroOut = !es[0].isIntersecting; apply(); }, { threshold: 0.15 }).observe(heroEl);
    if (bookingSec) new IntersectionObserver(es => { bookingIn = es[0].isIntersecting; apply(); }, { threshold: 0.05 }).observe(bookingSec);
  }

  /* ---- Mobile nav ---- */
  const nav = $("#mainNav"), toggle = $("#navToggle");
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", open);
  });
  $$("#mainNav a").forEach(a => a.addEventListener("click", () => {
    nav.classList.remove("open"); toggle.setAttribute("aria-expanded", "false");
  }));

  /* ---- Reveal on scroll ---- */
  const revObserver = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); obs.unobserve(e.target); } });
  }, { threshold: 0, rootMargin: "0px 0px 120px 0px" });
  const observeReveals = () => $$(".reveal:not(.in)").forEach(el => revObserver.observe(el));
  observeReveals();

  /* ============================================================
     SITE CMS — sections hidden / texts overridden from the CRM («Сайт» tab)
     Markup contract: [data-cms-section="Назва"] = hideable section (by id),
     [data-cms="key"] = editable text. cfg = { hidden: [id…], texts: { key: text } }.
     ============================================================ */
  const CMS_HIDDEN = new Set(); window.GL_CMS_HIDDEN = CMS_HIDDEN;
  const CMS_DEFAULTS = new Map();                 // el -> { html, rich } captured before the first override
  let reviewsReady = false;                       // renderReviews() received published reviews
  const cmsIsRich = html => /<br|class="script"|<b>/i.test(html);
  // Rich fields (headings with accents, texts with <b>/<br>): "*слово*" → <span class="script">,
  // "**слово**" → <b>, newline → <br>. Nodes are built one by one — saved text is never used as HTML.
  function cmsRender(el, text) {
    el.textContent = "";
    String(text).split("\n").forEach((line, li) => {
      if (li) el.appendChild(document.createElement("br"));
      const re = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g; let last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) el.appendChild(document.createTextNode(line.slice(last, m.index)));
        const bold = m[1] != null, node = document.createElement(bold ? "b" : "span");
        if (!bold) node.className = "script";
        node.textContent = bold ? m[1] : m[2];
        el.appendChild(node); last = m.index + m[0].length;
      }
      if (last < line.length) el.appendChild(document.createTextNode(line.slice(last)));
    });
  }
  function applySiteCms(cfg) {
    const hidden = (cfg && Array.isArray(cfg.hidden)) ? cfg.hidden.map(String) : [];
    const texts = (cfg && cfg.texts && typeof cfg.texts === "object") ? cfg.texts : {};
    CMS_HIDDEN.clear(); hidden.forEach(id => CMS_HIDDEN.add(id));
    $$("[data-cms-section]").forEach(sec => {
      const hide = CMS_HIDDEN.has(sec.id);
      sec.hidden = hide || (sec.id === "reviews" && !reviewsReady);   // #reviews also waits for published reviews
      $$(`#mainNav a[href="#${sec.id}"], .footer-nav a[href="#${sec.id}"]`).forEach(a => { a.hidden = hide; });
    });
    $$("[data-cms]").forEach(el => {
      if (!CMS_DEFAULTS.has(el)) CMS_DEFAULTS.set(el, { html: el.innerHTML, rich: cmsIsRich(el.innerHTML) });
      const def = CMS_DEFAULTS.get(el), val = texts[el.dataset.cms];
      if (typeof val === "string" && val.trim()) { if (def.rich) cmsRender(el, val); else el.textContent = val; }
      else if (el.innerHTML !== def.html) el.innerHTML = def.html;                // override removed → back to the markup default
    });
  }
  // cached copy first (no flash on repeat visits), then the live config from the worker
  try { const c = localStorage.getItem("gl_site_cms"); if (c) applySiteCms(JSON.parse(c)); } catch (e) { }
  if (CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/site`).then(r => r.json()).then(d => {
      if (!d || !d.ok) return;
      const cfg = { hidden: d.hidden || [], texts: d.texts || {} };
      applySiteCms(cfg);
      try { localStorage.setItem("gl_site_cms", JSON.stringify(cfg)); } catch (e) { }
    }).catch(() => { });
  }

  /* ============================================================
     PRICES
     ============================================================ */
  const ICONS = { paw:"i-paw", scissors:"i-scissors", cat:"i-cat", star:"i-star", home:"i-home", play:"i-play" };
  const bookLink = svc => `#booking`;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Rebuildable: renders from bundled LP_PRICES first, then from the live catalog.
  function renderPrices(data) {
    if (!data || !data.categories) return;
    const tabs = $("#priceTabs"), panels = $("#pricePanels");
    if (!tabs || !panels) return;
    if ($("#noteGift")) $("#noteGift").textContent = data.note_gift || "";
    if ($("#noteBig")) $("#noteBig").textContent = data.note_big ? "* " + data.note_big : "";
    tabs.innerHTML = ""; panels.innerHTML = "";

    function selectTab(i) {
      $$(".price-tab", tabs).forEach((t, j) => t.classList.toggle("is-active", j === i));
      $$(".price-panel", panels).forEach((p, j) => p.classList.toggle("is-active", j === i));
    }

    data.categories.forEach((cat, idx) => {
      const active = idx === 0 ? " is-active" : "";
      const tab = document.createElement("button");
      tab.className = "price-tab" + active;
      tab.setAttribute("role", "tab");
      tab.innerHTML = `<svg class="i"><use href="#${ICONS[cat.icon] || "i-paw"}"/></svg>${esc(cat.title)}`;
      tab.addEventListener("click", () => selectTab(idx));
      tabs.appendChild(tab);

      const panel = document.createElement("div");
      panel.className = "price-panel" + active;
      panel.id = "panel-" + cat.id;

      let html = "";
      if (cat.note) html += `<p class="price-cat-note muted" style="margin:0 0 10px">${esc(cat.note)}</p>`;
      if (cat.searchable) {
        html += `<input type="search" class="price-search" placeholder="Пошук породи…" aria-label="Пошук породи" data-cat="${esc(cat.id)}">`;
      }
      html += `<div class="price-table-wrap"><table class="price-table"><thead><tr>` +
        (cat.columns || []).map(c => `<th>${esc(c)}</th>`).join("") + `</tr></thead><tbody>` +
        (cat.rows || []).map(row => `<tr>` + row.map(c => `<td>${esc(c)}</td>`).join("") + `</tr>`).join("") +
        `</tbody></table></div>`;
      html += `<div class="price-cat-cta"><a href="#booking" class="btn btn-primary">Записатись на цю послугу</a></div>`;
      panel.innerHTML = html;
      panels.appendChild(panel);
    });
  }

  (function initPrices() {
    const panels = $("#pricePanels");
    if (!panels) return;
    // instant render from the bundled catalog snapshot (fallback), then /catalog refreshes
    if (window.GL_CATALOG && window.GL_CATALOG.services) renderPrices(servicesToCatalog(window.GL_CATALOG.services, window.GL_CATALOG.notes));
    else if (window.LP_PRICES) renderPrices(window.LP_PRICES);
    else panels.innerHTML = '<p class="price-empty">Прайс тимчасово недоступний.</p>';

    // breed search — delegated once on the container, survives re-renders
    panels.addEventListener("input", e => {
      const inp = e.target.closest(".price-search"); if (!inp) return;
      const q = inp.value.trim().toLowerCase();
      const body = inp.parentElement.querySelector("tbody");
      let shown = 0;
      $$("tr", body).forEach(tr => {
        if (tr.classList.contains("price-empty-row")) return;
        const match = tr.cells[0].textContent.toLowerCase().includes(q);
        tr.style.display = match ? "" : "none";
        if (match) shown++;
      });
      let empty = body.querySelector(".price-empty-row");
      if (!shown) {
        if (!empty) {
          empty = document.createElement("tr"); empty.className = "price-empty-row";
          empty.innerHTML = `<td class="price-empty" colspan="9">Породу не знайдено. Напишіть нам — підкажемо ціну.</td>`;
          body.appendChild(empty);
        }
        empty.style.display = "";
      } else if (empty) empty.style.display = "none";
    });
  })();

  // --- unified catalog: services carry their own prices ---
  const numOf = v => { const m = /\d+/.exec(String(v == null ? "" : v)); return m ? +m[0] : null; };
  const normBreed = x => String(x || "").toLowerCase().replace(/[’'ʼ`]/g, "'").replace(/\s+/g, " ").trim();
  const normW = x => String(x || "").toLowerCase().replace(/\s+/g, " ").replace(/грн|кг/g, "").trim();
  // Rows of a breed service are [breed, weight, price]. Pick the row for breed(+weight).
  function breedRows(rows, breed) {
    const b = normBreed(breed); if (!b) return [];
    const all = rows || [];
    const exact = all.filter(r => normBreed(r[0]) === b);
    if (exact.length) return exact;                     // exact label wins ("Вичісування" must not pick "Мейн-кун (вичісування)")
    return all.filter(r => { const l = normBreed(r[0]); return l && (b.includes(l) || l.includes(b)); })
      .sort((x, y) => Math.abs(normBreed(x[0]).length - b.length) - Math.abs(normBreed(y[0]).length - b.length)); // closest label first
  }
  function pickBreedRow(rows, breed, weight) {
    const bm = breedRows(rows, breed); if (!bm.length) return null;
    if (bm.length === 1) return bm[0];
    const w = normW(weight);
    return (w && bm.find(r => normW(r[1]) === w)) || bm.find(r => !String(r[1] || "").trim()) || null;
  }
  function iconForSvc(s) {
    const n = (s.name || "").toLowerCase();
    if (/готел|hotel/.test(n)) return "home";
    if (/садоч|погодин|daycare/.test(n)) return "play";
    if (/окрем|додатк/.test(n)) return "star";
    if (/стриж/.test(n)) return "scissors";
    if (s.species === "cat" || /кот|кіт/.test(n)) return "cat";
    return "paw";
  }
  // Build the «Ціни» view (renderPrices shape) from the service list.
  function servicesToCatalog(services, notes) {
    const cats = (services || []).filter(s => s.active !== 0).map((s, i) => {
      let columns = (s.columns && s.columns.length) ? s.columns.slice() : null;
      let rows = (s.rows && s.rows.length) ? s.rows.map(r => r.slice()) : [];
      if (!rows.length) {
        columns = ["Послуга", "Ціна"];
        const p = s.price ? (String(s.price) + (/^\d/.test(String(s.price)) ? (" " + (s.unit || "₴")) : "")) : "за домовленістю";
        rows = [[s.name, p]];
      } else if (!columns) { columns = ["Послуга", "Ціна, ₴"]; }
      // add-ons: an empty «Для кого» tag means the item suits every pet — say so on the price page
      if (s.price_type === "addon" && columns.length === 3) rows = rows.map(r => (r.length >= 3 && !r[1]) ? [r[0], "усі", r[2]] : r);
      return { id: "svc-" + i, title: s.name, icon: iconForSvc(s), searchable: s.price_type === "breed", columns, rows, note: s.note };
    });
    return { note_gift: (notes && notes.gift) || "", note_big: (notes && notes.big) || "", categories: cats };
  }
  // Orientative price shown in the booking form for the chosen service (+breed, +weight).
  function priceHint(s, breed, weight) {
    if (!s) return "";
    if (s.price_type === "breed") {
      const rows = s.rows || [], last = r => r[r.length - 1];
      if (breed) {
        const bm = breedRows(rows, breed);
        if (bm.length) {
          const row = pickBreedRow(rows, breed, weight), p = row ? last(row) : null;
          if (p != null && /^\d+$/.test(String(p).trim())) return `Орієнтовна ціна: <b>${esc(p)} ₴</b>`;
          const nums = bm.map(r => numOf(last(r))).filter(n => n != null);
          if (nums.length) { const mn = Math.min.apply(null, nums), mx = Math.max.apply(null, nums); return mn === mx ? `Орієнтовна ціна: <b>${mn} ₴</b>` : `Ціна для «${esc(breed)}»: <b>${mn}–${mx} ₴</b> — залежить від ваги`; }
        }
      }
      const all = rows.map(r => numOf(last(r))).filter(n => n != null);
      return all.length ? `Ціна залежить від породи — <b>від ${Math.min.apply(null, all)} ₴</b>` : "";
    }
    if (s.price_type === "flat") {
      if (s.price) return `Ціна: <b>${esc(s.price)}${/^\d/.test(String(s.price)) ? (" " + esc(s.unit || "₴")) : ""}</b>`;
      return s.note ? esc(s.note) : "";
    }
    const nums = [];
    (s.rows || []).forEach(r => r.forEach((c, i) => { if (i > 0) { const n = numOf(c); if (n != null) nums.push(n); } }));
    let h = s.note ? esc(s.note) : "";
    if (nums.length) { if (h) h += "<br>"; h += `Ціна: <b>від ${Math.min.apply(null, nums)} ${esc(s.unit || "₴")}</b>`; }
    return h;
  }

  /* ============================================================
     GALLERY
     ============================================================ */
  const SPECIES = { dog: "Собака", cat: "Кіт" };
  const KIND = { portrait: "Портрет", beforeafter: "До / Після", hotel: "Готель" };

  const filters = [
    { id: "all", label: "Усі", test: () => true },
    { id: "dog", label: "🐶 Собаки", test: it => it.species === "dog" },
    { id: "cat", label: "🐱 Коти", test: it => it.species === "cat" },
    { id: "ba", label: "✨ До / після", test: it => !!it.ba },
    { id: "video", label: "🎬 Відео", test: it => !!it.video },
  ];
  let galleryItems = [], currentFilter = "all", visibleList = [], lbIndex = 0;
  const GAL_INITIAL = 16; let galleryExpanded = false;

  const gObserver = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); obs.unobserve(e.target); } });
  }, { threshold: 0, rootMargin: "0px 0px 120px 0px" });

  // Autoplay (muted) feed videos only while in view; pause when out.
  const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      const v = e.target.querySelector("video"); if (!v) return;
      if (e.isIntersecting) v.play().catch(() => {}); else v.pause();
    });
  }, { threshold: 0.4 });

  (function initGallery() {
    const data = window.LP_GALLERY;
    if (!data) { $("#galleryGrid").innerHTML = '<p class="price-empty">Галерея тимчасово недоступна.</p>'; return; }
    const vids = (window.LP_VIDEOS && window.LP_VIDEOS.items) || [];
    const photos = data.items || [];
    const bas = baItems((window.LP_BEFORE_AFTER && window.LP_BEFORE_AFTER.items) || []);
    // interleave: photos lead, a «До / після» pair every 3rd photo, a video roughly every 4th
    galleryItems = []; let vi = 0, bi = 0;
    photos.forEach((p, idx) => {
      galleryItems.push(p);
      if (idx % 3 === 1 && bi < bas.length) galleryItems.push(bas[bi++]);
      if (idx % 4 === 3 && vi < vids.length) galleryItems.push(vids[vi++]);
    });
    while (bi < bas.length) galleryItems.push(bas[bi++]);
    while (vi < vids.length) galleryItems.push(vids[vi++]);
    // pairs published from the CRM pet cards come first once they arrive
    if (CONFIG.bookingEndpoint) fetch(`${CONFIG.bookingEndpoint}/before-after`).then(r => r.json()).then(d => {
      const live = baItems((d && d.items) || []); if (!live.length) return;
      galleryItems = live.concat(galleryItems); renderGallery();
    }).catch(() => { });
    const fb = $("#galleryFilters");
    filters.forEach(f => {
      const b = document.createElement("button");
      b.className = "gfilter" + (f.id === "all" ? " is-active" : "");
      b.textContent = f.label;
      b.addEventListener("click", () => { currentFilter = f.id; galleryExpanded = false;
        $$(".gfilter", fb).forEach(x => x.classList.toggle("is-active", x === b)); renderGallery(); });
      fb.appendChild(b);
    });
    const moreBtn = $("#galleryMore");
    if (moreBtn) moreBtn.addEventListener("click", () => {
      galleryExpanded = !galleryExpanded;
      renderGallery();
      if (!galleryExpanded) $("#gallery").scrollIntoView({ behavior: "smooth" });
    });
    renderGallery();
  })();

  // «До / після» pair → gallery item (src = after image, so the lightbox and species filters keep working)
  function baItems(list) { return list.filter(b => b && b.before && b.after).map(b => Object.assign({ kind: "beforeafter", ba: true, src: b.after, w: b.w || 800, h: b.h || 800 }, b)); }
  function renderGallery() {
    const grid = $("#galleryGrid");
    const f = filters.find(x => x.id === currentFilter);
    const list = galleryItems.filter(f.test);
    visibleList = list;
    grid.innerHTML = "";
    const more = $("#galleryMore");
    if (more) {
      if (list.length <= GAL_INITIAL) { more.hidden = true; }
      else { more.hidden = false; more.textContent = galleryExpanded ? "Згорнути" : `Показати всі роботи (${list.length})`; }
    }
    const show = galleryExpanded ? list.length : Math.min(GAL_INITIAL, list.length);
    const hint = `<span class="g-hint"><svg class="i"><use href="#i-paw"/></svg> Переглянути</span>`;
    list.slice(0, show).forEach((it, i) => {
      const fig = document.createElement("figure");
      fig.className = "g-item";
      if (!reduced) fig.style.transitionDelay = Math.min(i, 9) * 55 + "ms";
      if (it.video) {
        fig.classList.add("g-video");
        fig.innerHTML =
          `<span class="g-badge g-badge-play"><svg class="i"><use href="#i-play"/></svg> Відео</span>` + hint +
          `<video src="${it.video}" poster="${it.src}" muted loop playsinline preload="none" width="${it.w}" height="${it.h}"></video>`;
        fig.addEventListener("click", () => openLightbox(i));
        grid.appendChild(fig);
        gObserver.observe(fig);
        if (!reduced) videoObserver.observe(fig);
      } else if (it.ba) {   // before/after slider tile
        fig.classList.add("g-ba");
        const who = [it.name, it.breed].filter(Boolean).join(" · ");
        const alt = `GAV&LOVE — ${who || "улюбленець"}: до і після грумінгу`;
        fig.innerHTML =
          `<span class="g-badge">✨ До / після${who ? " · " + esc(who) : ""}</span>` +
          `<img class="ba-after" src="${it.after}" alt="${esc(alt)}" loading="lazy" width="${it.w}" height="${it.h}">` +
          `<div class="ba-before"><img src="${it.before}" alt="" loading="lazy" width="${it.w}" height="${it.h}"></div>` +
          `<span class="ba-lbl ba-l">До</span><span class="ba-lbl ba-r">Після</span><div class="ba-handle"></div>` +
          `<input type="range" class="ba-range" min="0" max="100" value="50" aria-label="Порівняти: до і після">`;
        const before = fig.querySelector(".ba-before"), handle = fig.querySelector(".ba-handle"), range = fig.querySelector(".ba-range");
        const setPos = v => { before.style.clipPath = `inset(0 ${100 - v}% 0 0)`; handle.style.left = v + "%"; };
        range.addEventListener("input", () => setPos(+range.value));
        setPos(50);
        grid.appendChild(fig);
        gObserver.observe(fig);
      } else {
        const badge = it.kind === "beforeafter" ? "До / Після" : (it.breed || "");
        const alt = `GAV&LOVE — грумінг, ${SPECIES[it.species] || "улюбленець"}${badge ? " — " + badge : ""}`;
        fig.innerHTML =
          (badge ? `<span class="g-badge">${badge}</span>` : "") + hint +
          `<img src="${it.src}" alt="${alt}" loading="lazy" width="${it.w}" height="${it.h}">`;
        fig.addEventListener("click", () => openLightbox(i));
        grid.appendChild(fig);
        gObserver.observe(fig);
      }
    });
  }

  /* ---- Lightbox ---- */
  const lb = $("#lightbox"), lbStage = $("#lbStage");
  function openLightbox(i) {
    lbIndex = i; renderLb(); lb.classList.add("open"); lb.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function closeLightbox() { lb.classList.remove("open"); lb.setAttribute("aria-hidden", "true"); document.body.style.overflow = ""; lbStage.innerHTML = ""; }
  function renderLb() {
    const it = visibleList[lbIndex]; if (!it) return;
    lbStage.innerHTML = it.video
      ? `<video src="${it.video}" controls autoplay playsinline></video>`
      : it.ba
        ? `<div class="lb-ba"><figure><img src="${it.before}" alt=""><figcaption>До</figcaption></figure><figure><img src="${it.after}" alt=""><figcaption>Після</figcaption></figure></div>`
        : `<img src="${it.src}" alt="">`;
  }
  const step = d => { lbIndex = (lbIndex + d + visibleList.length) % visibleList.length; renderLb(); };
  $("#lbClose").addEventListener("click", closeLightbox);
  $("#lbNext").addEventListener("click", () => step(1));
  $("#lbPrev").addEventListener("click", () => step(-1));
  lb.addEventListener("click", e => { if (e.target === lb) closeLightbox(); });
  addEventListener("keydown", e => {
    if (!lb.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  });
  // swipe
  let tx = 0;
  lbStage.addEventListener("touchstart", e => tx = e.touches[0].clientX, { passive: true });
  lbStage.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  }, { passive: true });

  /* ============================================================
     BOOKING FORM
     ============================================================ */
  const CFG = window.GL_CONFIG || { services: [], staff: [], dogBreeds: [] };
  const fmtDur = window.GL_FMT_DUR || (() => "");
  const petHidden = $("#bf-pet");
  const breedField = $("#bf-breed-field"), breedSel = $("#bf-breed"), breedNote = $("#bf-breed-note"),
    weightSel = $("#bf-weight"), weightField = $("#bf-weight-field"), staffSel = $("#bf-staff"),
    addonsField = $("#bf-addons-field"), addonsBox = $("#bf-addons");

  // populate selects from config
  (function initBookingConfig() {
    const svc = $("#bf-service");
    if (svc) CFG.services.forEach(s => {
      const o = document.createElement("option");
      o.value = s.name; o.textContent = s.name + (s.dur ? " · ~" + fmtDur(s.dur) : "");
      svc.appendChild(o);
    });
    if (breedSel) breedSel.innerHTML = '<option value="">Оберіть породу…</option>' +
      CFG.dogBreeds.map(b => `<option>${b}</option>`).join("");
    if (weightSel) weightSel.innerHTML = '<option value="">Оберіть вагу…</option>' +
      (CFG.weightOptions || []).map(w => `<option>${w}</option>`).join("");
    if (staffSel) staffSel.innerHTML = '<option value="">Будь-який майстер</option>' +
      (CFG.staff || []).map(s => `<option>${s}</option>`).join("");
  })();
  // live master roster (reflects schedule/active state from the CRM)
  if (staffSel && CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/masters`).then(r => r.json()).then(d => {
      if (d && d.masters && d.masters.length)
        staffSel.innerHTML = '<option value="">Будь-який майстер</option>' + d.masters.map(s => `<option>${s}</option>`).join("");
    }).catch(() => { });
  }

  // Pet segment filters the service list by species (cat services for cats, dog
  // services for dogs, "both" always); breed/weight then follow the service.
  function applyPet() { fillServiceSelect(); }

  const petSeg = $("#bf-pet-seg");
  if (petSeg) petSeg.addEventListener("click", e => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    $$(".seg-btn", petSeg).forEach(x => x.classList.toggle("is-active", x === b));
    petHidden.value = b.dataset.val;
    applyPet();
    if (typeof updatePriceHint === "function") updatePriceHint();
  });

  // Date bounds: today .. +30 days
  const iso = d => d.toISOString().slice(0, 10);
  const dateInput = $("#bf-date");
  if (dateInput) {
    dateInput.min = iso(new Date());
    dateInput.max = iso(new Date(Date.now() + 30 * 86400000));
  }

  // Slot picker (grooming services). Hotel/daycare are free-form requests.
  let REQUEST_SVC = CFG.services.filter(s => s.request).map(s => s.name);
  const serviceSel = $("#bf-service");
  const slotsField = $("#bf-slots-field"), slotsBox = $("#bf-slots"),
    slotsHint = $("#bf-slots-hint"), timeInput = $("#bf-time"),
    waitBox = $("#bf-waitlist-box"), waitChk = $("#bf-waitlist");
  let slotsToken = 0;
  const needsSlot = () => serviceSel && serviceSel.value && !REQUEST_SVC.includes(serviceSel.value);

  async function refreshSlots() {
    if (!timeInput) return;
    timeInput.value = "";
    if (waitBox) { waitBox.style.display = "none"; if (waitChk) waitChk.checked = false; }
    if (!CONFIG.bookingEndpoint || !needsSlot() || !dateInput.value) { slotsField.hidden = true; return; }
    slotsField.hidden = false; slotsBox.innerHTML = ""; slotsHint.textContent = "завантаження…";
    const my = ++slotsToken;
    try {
      const r = await fetch(`${CONFIG.bookingEndpoint}/slots?date=${dateInput.value}&service=${encodeURIComponent(serviceSel.value)}&staff=${encodeURIComponent(staffSel ? staffSel.value : "")}`);
      const d = await r.json();
      if (my !== slotsToken) return;
      const slots = d.slots || [];
      if (!slots.length) { slotsHint.textContent = "— на цей день вільних слотів немає"; if (waitBox) waitBox.style.display = "flex"; return; }
      slotsHint.textContent = "";
      slots.forEach(t => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "slot"; b.textContent = t;
        b.addEventListener("click", () => {
          $$(".slot", slotsBox).forEach(x => x.classList.remove("is-sel"));
          b.classList.add("is-sel"); timeInput.value = t;
        });
        slotsBox.appendChild(b);
      });
    } catch { if (my === slotsToken) slotsHint.textContent = "— не вдалося завантажити час"; }
  }
  serviceSel && serviceSel.addEventListener("change", refreshSlots);
  dateInput && dateInput.addEventListener("change", refreshSlots);
  staffSel && staffSel.addEventListener("change", refreshSlots);

  // Live unified catalog from the CRM: one service list drives the form's
  // service select, breed & weight options, price hint, and the «Ціни» tables.
  let SERVICES = [];
  const svcByName = n => SERVICES.find(x => x.name === n);
  const isBreedSvc = s => s && s.price_type === "breed" && s.rows && s.rows.length;
  const distinctNE = a => { const seen = {}, out = []; a.forEach(v => { if (v !== "" && v != null && !seen[v]) { seen[v] = 1; out.push(v); } }); return out; };
  // Breed dropdown = the service's breeds; weight dropdown = that breed's variants.
  function syncBreedWeight() {
    if (!SERVICES.length) return;                       // keep config fallback if catalog not loaded
    const s = svcByName(serviceSel.value);
    const lbl = $("#bf-breed-label");
    if (isBreedSvc(s)) {
      const isCat = s.species === "cat", ph = isCat ? "Оберіть послугу…" : "Оберіть породу…";
      if (lbl) lbl.textContent = isCat ? "Послуга" : "Порода";
      const breeds = distinctNE(s.rows.map(r => r[0])), cur = breedSel.value;
      breedSel.innerHTML = `<option value="">${ph}</option>` + breeds.map(b => `<option>${esc(b)}</option>`).join("");
      if (cur && breeds.indexOf(cur) >= 0) breedSel.value = cur;
      if (breedField) breedField.hidden = false; breedSel.disabled = false; if (breedNote) breedNote.hidden = true;
      syncWeightForBreed();
    } else {
      if (lbl) lbl.textContent = "Порода";
      if (breedField) breedField.hidden = true; breedSel.disabled = true; breedSel.value = "";
      if (weightField) weightField.hidden = false;
      weightSel.innerHTML = '<option value="">Оберіть вагу…</option>' + (CFG.weightOptions || []).map(w => `<option>${esc(w)}</option>`).join("");
    }
  }
  function syncWeightForBreed() {
    const s = svcByName(serviceSel.value); if (!isBreedSvc(s)) return;
    const weights = distinctNE(s.rows.filter(r => r[0] === breedSel.value).map(r => r[1]));
    if (weights.length) {
      const cur = weightSel.value;
      weightSel.innerHTML = '<option value="">Оберіть вагу…</option>' + weights.map(w => `<option>${esc(w)}</option>`).join("");
      if (cur && weights.indexOf(cur) >= 0) weightSel.value = cur;
      if (weightField) weightField.hidden = false;
    } else { weightSel.innerHTML = ""; weightSel.value = ""; if (weightField) weightField.hidden = true; }
  }
  // Add-ons: items from price_type "addon" services, shown as checkboxes for grooming.
  // Add-ons follow the pet: the addon service's species (dog/cat/both) and an optional
  // per-row "Для кого" middle column (собаки / коти / empty = усі) both filter the list.
  const addonSpecies = r => { if (!r || r.length < 3) return ""; const t = String(r[1] || "").toLowerCase(); return /соб|dog/.test(t) ? "dog" : /кіт|кот|cat/.test(t) ? "cat" : ""; };
  const addonItems = () => {
    const out = [], seen = {}, sp = petSpecies();
    SERVICES.forEach(s => {
      if (s.price_type !== "addon" || s.active === 0) return;
      if (sp && s.species && s.species !== "both" && s.species !== sp) return;
      (s.rows || []).forEach(r => { const rs = addonSpecies(r); if (r[0] && !seen[r[0]] && (!sp || !rs || rs === sp)) { seen[r[0]] = 1; out.push({ name: r[0], price: r[r.length - 1] }); } });
    });
    return out;
  };
  const parseAddonPrice = v => { const t = String(v == null ? "" : v).trim(); if (/%/.test(t)) { const n = numOf(t); return n != null ? { t: "pct", v: n } : { t: "m" }; } if (/^\+?\s*\d+$/.test(t)) return { t: "abs", v: +t.replace(/[^\d]/g, "") }; return { t: "m" }; };
  function basePrice(s, breed, weight) {
    if (!s) return null;
    if (s.price_type === "breed") { const row = pickBreedRow(s.rows, breed, weight), p = row ? row[row.length - 1] : null; return (p != null && /^\d+$/.test(String(p).trim())) ? +p : null; }
    if (s.price_type === "flat") return /^\d+$/.test(String(s.price).trim()) ? +s.price : null;
    return null;
  }
  function addonsCalc(names, base) {
    const items = {}; addonItems().forEach(it => items[it.name] = it.price);
    let add = 0, manual = false; const nm = [];
    names.forEach(n => { if (!(n in items)) return; nm.push(n); const p = parseAddonPrice(items[n]); if (p.t === "abs") add += p.v; else if (p.t === "pct") { if (base != null) add += Math.round(base * p.v / 100); else manual = true; } else manual = true; });
    return { add, manual, names: nm };
  }
  function renderAddons() {
    if (!addonsBox) return;
    const s = svcByName(serviceSel.value);
    const items = (s && s.bookable !== 0 && !s.is_request) ? addonItems() : [];
    if (!items.length) { if (addonsField) addonsField.hidden = true; addonsBox.innerHTML = ""; return; }
    const checked = {}; [].forEach.call(addonsBox.querySelectorAll("input:checked"), c => checked[c.value] = 1);
    addonsBox.innerHTML = items.map(it =>
      `<label style="display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer"><input type="checkbox" name="addon" value="${esc(it.name)}"${checked[it.name] ? " checked" : ""}><span style="flex:1">${esc(it.name)}</span><b class="muted" style="white-space:nowrap">${esc(it.price)}</b></label>`).join("");
    if (addonsField) addonsField.hidden = false;
  }
  function updatePriceHint() {
    const el = $("#bf-price-hint"); if (!el || !serviceSel) return;
    const s = svcByName(serviceSel.value);
    const breed = (breedSel && !breedSel.disabled) ? breedSel.value : "";
    const weight = weightSel ? weightSel.value : "";
    let h = priceHint(s, breed, weight);
    const checked = addonsBox ? [].map.call(addonsBox.querySelectorAll("input:checked"), c => c.value) : [];
    if (checked.length && s) {
      const base = basePrice(s, breed, weight), ac = addonsCalc(checked, base);
      if (ac.names.length) {
        if (base != null) h = `Орієнтовна ціна: <b>${base + ac.add} ₴</b>${ac.manual ? " + уточнення" : ""}`;
        h = (h ? h + "<br>" : "") + `<span class="muted">Допи: ${ac.names.map(esc).join(", ")}</span>`;
      }
    }
    el.innerHTML = h; el.hidden = !h;
    const cnt = $("#bf-addons-count");
    if (cnt) { const n = addonsBox ? addonsBox.querySelectorAll("input:checked").length : 0; cnt.textContent = n ? `(обрано: ${n})` : "(необовʼязково)"; }
  }
  serviceSel && serviceSel.addEventListener("change", () => { syncBreedWeight(); renderAddons(); updatePriceHint(); });
  breedSel && breedSel.addEventListener("change", () => { syncWeightForBreed(); updatePriceHint(); });
  weightSel && weightSel.addEventListener("change", updatePriceHint);
  addonsBox && addonsBox.addEventListener("change", updatePriceHint);
  function petSpecies() { const v = petHidden ? petHidden.value : ""; return v === "Кіт" ? "cat" : v === "Собака" ? "dog" : ""; }
  // Rebuild the service <select> for the chosen pet: cat → cat/both services, dog → dog/both.
  function fillServiceSelect() {
    if (!serviceSel || !SERVICES) return;
    const allBookable = SERVICES.filter(s => s.bookable !== 0);
    const sp = petSpecies();
    const list = allBookable.filter(s => !sp || !s.species || s.species === "both" || s.species === sp);
    if (!list.length) return;
    const prev = serviceSel.value;
    const ph = serviceSel.querySelector('option[value=""]');
    const phHtml = ph ? ph.outerHTML : '<option value="">Оберіть послугу…</option>';
    serviceSel.innerHTML = phHtml + list.map(s =>
      `<option value="${esc(s.name)}">${esc(s.name)}${s.duration ? " · ~" + fmtDur(s.duration) : ""}</option>`).join("");
    serviceSel.value = (prev && list.some(s => s.name === prev)) ? prev : "";   // drop a service that doesn't fit the pet
    REQUEST_SVC = allBookable.filter(s => s.is_request).map(s => s.name);
    syncBreedWeight(); renderAddons(); updatePriceHint();
  }
  function applyCatalog(d) {
    if (!d || !d.services) return;
    SERVICES = d.services;
    fillServiceSelect();
    renderPrices(servicesToCatalog(SERVICES, d.notes));
  }
  if (window.GL_CATALOG) applyCatalog(window.GL_CATALOG);   // instant, from bundled snapshot
  if (CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/catalog`).then(r => r.json()).then(applyCatalog).catch(() => { });
  }

  // ---- Reviews / testimonials (published from the CRM) ----
  function renderReviews(d) {
    const sec = $("#reviews"), grid = $("#reviewsGrid");
    const list = (d && d.reviews) || [];
    if (!sec || !grid || !list.length) return;
    grid.innerHTML = list.slice(0, 12).map(r => {
      const st = Math.max(0, Math.min(5, Number(r.rating) || 0));
      const stars = "★★★★★".slice(0, st) + "☆☆☆☆☆".slice(0, 5 - st);
      const who = [esc(r.name || "Гість салону"), r.master ? "· майстер " + esc(r.master) : ""].join(" ");
      return `<article class="rev-item"><div class="stars" aria-label="${st} з 5">${stars}</div>`
        + (r.text ? `<p class="quote">«${esc(r.text)}»</p>` : "")
        + `<p class="who">${who}</p></article>`;
    }).join("");
    const avg = $("#reviewsAvg");
    if (avg && d.avg) avg.textContent = `Середня оцінка ${d.avg} з 5 · ${d.count} ${d.count % 10 === 1 && d.count % 100 !== 11 ? "відгук" : (d.count % 10 >= 2 && d.count % 10 <= 4 && (d.count % 100 < 10 || d.count % 100 >= 20) ? "відгуки" : "відгуків")}`;
    reviewsReady = true;
    sec.hidden = CMS_HIDDEN.has("reviews");   // the CRM («Сайт») may keep the section hidden even with reviews
  }
  if (CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/reviews`).then(r => r.json()).then(renderReviews).catch(() => { });
  }

  const form = $("#bookingForm"), status = $("#bfStatus");
  form && form.addEventListener("submit", async e => {
    e.preventDefault();
    status.className = "form-status"; status.textContent = "";
    if (!form.checkValidity()) { form.reportValidity(); return; }
    if (CONFIG.bookingEndpoint && needsSlot() && !timeInput.value && !(waitChk && waitChk.checked)) {
      status.className = "form-status err"; status.textContent = "Оберіть, будь ласка, вільний час.";
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    data.addons = [].map.call(form.querySelectorAll('input[name="addon"]:checked'), c => c.value);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; status.textContent = "Надсилаємо…";
    try {
      let request = false, demo = false, assignedStaff = "";
      if (CONFIG.bookingEndpoint) {
        const res = await fetch(`${CONFIG.bookingEndpoint}/book`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || "bad");
        request = d.request; assignedStaff = d.staff || ""; window._lastWait = d.waitlist; window._lastTg = d.tg_link || "";
      } else {
        await new Promise(r => setTimeout(r, 500)); // online-booking not activated yet
        demo = true;
      }
      status.className = "form-status ok";
      status.textContent = demo
        ? "Дякуємо! Щоб миттєво підтвердити час, напишіть нам у Telegram / Viber або зателефонуйте 👇"
        : window._lastWait
          ? "Дякуємо! Ви у листі очікування — ми повідомимо, щойно звільниться місце ⏳"
          : request
            ? "Дякуємо! Заявку надіслано — ми зв'яжемось для підтвердження."
            : "Готово! Запис створено" + (assignedStaff ? " до майстра " + assignedStaff : "") + " — до зустрічі 🐾";
      if (demo) { const c = document.getElementById("contacts"); if (c) c.scrollIntoView({ behavior: "smooth" }); }
      if (!demo && window._lastTg) {   // one tap links the client's Telegram → confirmation + reminders arrive there
        const a = document.createElement("a");
        a.className = "btn btn-primary"; a.href = window._lastTg; a.target = "_blank"; a.rel = "noopener";
        a.style.cssText = "display:inline-block;margin-top:12px";
        a.textContent = "🔔 Отримувати нагадування в Telegram";
        status.appendChild(document.createElement("br")); status.appendChild(a);
      }
      form.reset(); petHidden.value = "Собака";
      $$(".seg-btn", petSeg).forEach((x, i) => x.classList.toggle("is-active", i === 0));
      applyPet();
      slotsField.hidden = true;
    } catch (err) {
      status.className = "form-status err";
      status.textContent = String(err.message || err) === "bad"
        ? "Не вдалося надіслати. Напишіть нам у месенджер, будь ласка."
        : (err.message || "Помилка. Спробуйте ще раз.");
    } finally { btn.disabled = false; }
  });

  /* ============================================================
     INTERIOR / HOTEL LIGHTBOX (static image groups)
     ============================================================ */
  $$("#interiorGrid img, .hotel-photos img").length && (function () {
    const imgs = $$("#interiorGrid img, .hotel-photos img");
    // de-duplicate by src so repeated photos share one lightbox slide set
    const seen = new Set(), list = [];
    imgs.forEach(im => { if (!seen.has(im.src)) { seen.add(im.src); list.push({ src: im.getAttribute("src") }); } });
    imgs.forEach(im => im.addEventListener("click", () => {
      const i = list.findIndex(x => x.src === im.getAttribute("src"));
      visibleList = list; openLightbox(i < 0 ? 0 : i);
    }));
  })();
})();
