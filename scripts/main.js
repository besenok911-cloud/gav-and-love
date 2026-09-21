/* ============================================================
   GAV&LOVE — site logic
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

  /* ---- Reveal on scroll, cascading through siblings ----
     CSS reads --d as the transition-delay; we stamp it once per element so a
     row of cards lands one after another instead of all at the same instant.
     The cascade is capped, or a long grid ends up waiting seconds for its tail. */
  const REVEAL_STEP = 70, REVEAL_STEP_MAX = 5;
  const stampStagger = (el) => {
    if (el.dataset.glStagger) return;
    el.dataset.glStagger = "1";
    const p = el.parentElement; if (!p) return;
    const sibs = [...p.children].filter(n => n.classList && n.classList.contains("reveal"));
    if (sibs.length < 2) return;
    const i = Math.min(sibs.indexOf(el), REVEAL_STEP_MAX);
    if (i > 0) el.style.setProperty("--d", (i * REVEAL_STEP) + "ms");
  };
  const revObserver = new IntersectionObserver((entries, obs) => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); obs.unobserve(e.target); } });
  }, { threshold: 0, rootMargin: "0px 0px 120px 0px" });
  const observeReveals = () => $$(".reveal:not(.in)").forEach(el => { stampStagger(el); revObserver.observe(el); });
  observeReveals();

  /* ---- Hero photo follows the pointer, barely ----
     Only on a real pointer, only when motion is allowed: on phones this is dead weight. */
  if (!reduced && matchMedia("(hover:hover) and (pointer:fine)").matches) {
    const heroInner = $(".hero-inner"), heroPhoto = $(".hero-photo");
    if (heroInner && heroPhoto) {
      let raf = 0, tx = 0, ty = 0;
      const paint = () => {
        raf = 0;
        heroPhoto.style.setProperty("--rx", tx.toFixed(2) + "deg");
        heroPhoto.style.setProperty("--ry", ty.toFixed(2) + "deg");
      };
      heroInner.addEventListener("pointermove", (ev) => {
        const r = heroInner.getBoundingClientRect();
        tx = ((ev.clientX - r.left) / r.width - .5) * 5;    // ±2.5deg, no more
        ty = (.5 - (ev.clientY - r.top) / r.height) * 4;
        if (!raf) raf = requestAnimationFrame(paint);
      });
      heroInner.addEventListener("pointerleave", () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(paint); });
    }
  }

  /* ============================================================
     SITE CMS — sections hidden / texts overridden from the CRM («Сайт» tab)
     Markup contract: [data-cms-section="Назва"] = hideable section (by id),
     [data-cms="key"] = editable text (the CRM can also switch a single one off),
     [data-cms-img="key"] = replaceable photo
     (+ data-cms-img-sm = show the page copy, data-cms-img-ratio = the frame the CRM previews).
     cfg = { hidden: [id…], hiddenText: [key…], texts: { key: text },
             images: { key: {u,t,w,h,tw,th,pos,alt} } }.
     ============================================================ */
  const CMS_HIDDEN = new Set(); window.GL_CMS_HIDDEN = CMS_HIDDEN;
  const CMS_DEFAULTS = new Map();                 // el -> { html, rich } captured before the first override
  const IMG_DEFAULTS = new Map();                 // el -> every attribute the markup shipped with
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
  // Photos are swapped attribute by attribute on the element that is already there: the click
  // handlers of the lightbox and the .reveal observer are bound to these nodes and are never rebound.
  function cmsImgDefaults(el) {
    if (!IMG_DEFAULTS.has(el)) IMG_DEFAULTS.set(el, {
      src: el.getAttribute("src"), srcset: el.getAttribute("srcset"), sizes: el.getAttribute("sizes"),
      full: el.getAttribute("data-full"), w: el.getAttribute("width"), h: el.getAttribute("height"),
      alt: el.getAttribute("alt"),
    });
    return IMG_DEFAULTS.get(el);
  }
  function cmsImgRestore(el) {
    const d = cmsImgDefaults(el);
    ["src", "srcset", "sizes", "width", "height", "alt"].forEach(n => {
      const v = d[n === "width" ? "w" : n === "height" ? "h" : n];
      if (v == null) el.removeAttribute(n); else el.setAttribute(n, v);
    });
    if (d.full == null) el.removeAttribute("data-full"); else el.setAttribute("data-full", d.full);
    el.style.removeProperty("--cms-pos");
  }
  function cmsForgetImage(key) {   // a dead override must not come back from the cache on the next visit
    try {
      const c = JSON.parse(localStorage.getItem("gl_site_cms") || "{}");
      if (c.images && c.images[key]) { delete c.images[key]; localStorage.setItem("gl_site_cms", JSON.stringify(c)); }
    } catch (e) { }
  }
  function applySiteImages(images) {
    $$("[data-cms-img]").forEach(el => {
      const key = el.dataset.cmsImg, ov = images[key], d = cmsImgDefaults(el);
      if (!ov || !ov.u) { if (el.getAttribute("src") !== d.src) cmsImgRestore(el); return; }
      const small = el.hasAttribute("data-cms-img-sm") && ov.t, shown = small ? ov.t : ov.u;
      if (el.getAttribute("src") !== shown) el.setAttribute("src", shown);
      // real descriptors: the two copies are capped on different sides, so a guessed "560w" lies
      if (d.sizes && ov.tw && ov.w) el.setAttribute("srcset", ov.t + " " + ov.tw + "w, " + ov.u + " " + ov.w + "w");
      else el.removeAttribute("srcset");
      if (d.full != null) el.setAttribute("data-full", ov.u);
      const w = small ? ov.tw : ov.w, h = small ? ov.th : ov.h;
      if (w && h) { el.setAttribute("width", w); el.setAttribute("height", h); }
      else { el.removeAttribute("width"); el.removeAttribute("height"); }
      if (ov.alt) el.setAttribute("alt", ov.alt);
      if (ov.pos) el.style.setProperty("--cms-pos", ov.pos); else el.style.removeProperty("--cms-pos");
      // A photo replaced twice can leave a dead id in somebody's cached config. Rather than a broken
      // frame above the fold, fall back to the picture that ships with the page.
      el.onerror = () => { el.onerror = null; cmsImgRestore(el); cmsForgetImage(key); };
    });
  }
  function applySiteCms(cfg) {
    const hidden = (cfg && Array.isArray(cfg.hidden)) ? cfg.hidden.map(String) : [];
    const texts = (cfg && cfg.texts && typeof cfg.texts === "object") ? cfg.texts : {};
    const offText = new Set((cfg && Array.isArray(cfg.hiddenText)) ? cfg.hiddenText.map(String) : []);
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
      el.hidden = offText.has(el.dataset.cms);   // [hidden]{display:none!important} beats any display the class sets
    });
    applySiteImages((cfg && cfg.images && typeof cfg.images === "object") ? cfg.images : {});
  }
  // cached copy first (no flash on repeat visits), then the live config from the worker
  try { const c = localStorage.getItem("gl_site_cms"); if (c) applySiteCms(JSON.parse(c)); } catch (e) { }
  if (CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/site`).then(r => r.json()).then(d => {
      if (!d || !d.ok) return;
      const cfg = { hidden: d.hidden || [], hiddenText: d.hiddenText || [], texts: d.texts || {}, images: d.images || {} };
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
      const q = pkNorm(inp.value.trim());        // same tolerance as the booking form: «ши тцу» finds «Ши-тцу»
      const body = inp.parentElement.querySelector("tbody");
      let shown = 0;
      $$("tr", body).forEach(tr => {
        if (tr.classList.contains("price-empty-row")) return;
        const match = !q || pkNorm(tr.cells[0].textContent).includes(q);
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
  // widx — номер колонки з вагою; -1 означає, що ваги в цьому прайсі немає.
  // Назва (порода) при цьому завжди перша колонка — і в ролях, і без них.
  function pickBreedRow(rows, breed, weight, widx) {
    if (widx == null) widx = 1;
    const bm = breedRows(rows, breed); if (!bm.length) return null;
    if (bm.length === 1) return bm[0];
    if (widx < 0) return bm[0];
    const w = normW(weight);
    return (w && bm.find(r => normW(r[widx]) === w)) || bm.find(r => !String(r[widx] || "").trim()) || null;
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
      const rows = s.rows || [], cols = priceCols(s), tier = staffTier();
      const last = r => (cols.length ? rowPriceFor(s, r, tier) : r[r.length - 1]);
      if (breed) {
        const bm = breedRows(rows, breed);
        if (bm.length) {
          const row = pickBreedRow(rows, breed, weight, wIdx(s));
          // Два рівні і майстра ще не обрано — показуємо обидві ціни з їхніми назвами.
          // Діапазон «1000–1100» ховає сам факт рівнів, і клієнт читає більшу цифру як націнку.
          if (row && cols.length > 1 && !tier) {
            const parts = cols.map(c => `${esc(c.head)} <b>${esc(row[c.idx] || "—")} ₴</b>`).join(" · ");
            return `Орієнтовна ціна: ${parts}`;
          }
          const p = row ? last(row) : null;
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
    { id: "dog", label: "Собаки", test: it => it.species === "dog" },
    { id: "cat", label: "Коти", test: it => it.species === "cat" },
    { id: "ba", label: "До / після", test: it => !!it.ba },
    { id: "video", label: "Відео", test: it => !!it.video },
  ];
  let galleryItems = [], currentFilter = "all", visibleList = [], lbIndex = 0;
  const GAL_INITIAL = 16, GAL_PAGE = 24; let galShown = GAL_INITIAL;

  /* Tiles cascade in the order they cross the fold, not by DOM index: a grid row
     enters together, so a per-batch counter reads as a wave across the row. */
  const gObserver = new IntersectionObserver((entries, obs) => {
    let n = 0;
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      if (!reduced && n) e.target.style.setProperty("--d", (Math.min(n, 5) * 60) + "ms");
      n++;
      e.target.classList.add("in"); obs.unobserve(e.target);
    });
  }, { threshold: 0, rootMargin: "0px 0px 120px 0px" });

  // Autoplay (muted) feed videos only while in view; pause when out.
  // A preview clip costs 1-3 MB. Play it only where that is a fair trade: a wide screen, a connection
  // that is not metered or slow, and motion allowed. On phones the poster stays still until the tile is tapped.
  const netInfo = navigator.connection || {};
  const AUTOPLAY_CLIPS = !reduced && matchMedia("(min-width:641px)").matches
    && !netInfo.saveData && !/(^|-)([23])g$/.test(netInfo.effectiveType || "");
  const vizRatio = new Map();
  let vizTimer = 0;
  const videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(e => vizRatio.set(e.target, e.isIntersecting ? e.intersectionRatio : 0));
    if (vizTimer) return;
    vizTimer = setTimeout(() => {   // only the most visible clip plays; decoding several at once is what stutters
      vizTimer = 0;
      let best = null, bestR = 0;
      vizRatio.forEach((r, el) => { if (r > bestR) { bestR = r; best = el; } });
      vizRatio.forEach((r, el) => {
        const v = el.querySelector("video"); if (!v) return;
        if (el === best && bestR >= 0.6) { if (v.paused) v.play().catch(() => { }); }
        else if (!v.paused) v.pause();
      });
    }, 350);   // wait for the scroll to settle, do not start clips the visitor is scrolling past
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

  (function initGallery() {
    const data = window.LP_GALLERY;
    if (!data) { $("#galleryGrid").innerHTML = '<p class="price-empty">Галерея тимчасово недоступна.</p>'; return; }
    const vids = (window.LP_VIDEOS && window.LP_VIDEOS.items) || [];
    const photos = data.items || [];
    const bas = baItems((window.LP_BEFORE_AFTER && window.LP_BEFORE_AFTER.items) || []);
    // interleave: photos lead, a «До / після» reel every 5th photo, another video roughly every 7th
    galleryItems = []; let vi = 0, bi = 0;
    photos.forEach((p, idx) => {
      galleryItems.push(p);
      if (idx % 5 === 2 && bi < bas.length) galleryItems.push(bas[bi++]);
      if (idx % 7 === 5 && vi < vids.length) galleryItems.push(vids[vi++]);
    });
    while (bi < bas.length) galleryItems.push(bas[bi++]);
    while (vi < vids.length) galleryItems.push(vids[vi++]);
    // pairs published from the CRM pet cards come first once they arrive
    // the salon's own new work, published from the pet card in the CRM: pairs first, then single photos
    if (CONFIG.bookingEndpoint) fetch(`${CONFIG.bookingEndpoint}/before-after`).then(r => r.json()).then(d => {
      const live = baItems((d && d.items) || []);
      const singles = ((d && d.photos) || []).filter(p => p && p.src).map(p => ({
        id: p.id, src: p.src, t: p.t || p.src, species: p.species === "cat" ? "cat" : "dog", kind: "portrait",
        breed: [p.name, p.breed].filter(Boolean).join(" · "), w: p.w || 1280, h: p.h || 1280,
      }));
      if (!live.length && !singles.length) return;
      galleryItems = live.concat(singles, galleryItems); renderGallery();
    }).catch(() => { });
    const fb = $("#galleryFilters");
    filters.forEach(f => {
      const b = document.createElement("button");
      b.className = "gfilter" + (f.id === "all" ? " is-active" : "");
      b.textContent = f.label;
      b.addEventListener("click", () => { currentFilter = f.id; galShown = GAL_INITIAL;
        $$(".gfilter", fb).forEach(x => x.classList.toggle("is-active", x === b)); renderGallery(); });
      fb.appendChild(b);
    });
    const moreBtn = $("#galleryMore");
    if (moreBtn) moreBtn.addEventListener("click", () => {
      if (galShown >= visibleList.length) {   // everything is out — fold it back
        galShown = GAL_INITIAL; renderGallery();
        $("#gallery").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
        return;
      }
      galShown += GAL_PAGE; renderGallery();
    });
    renderGallery();
  })();

  // «До / після» → gallery items: a transformation reel (video + poster) or a photo pair published from the
  // CRM pet card (before + after image; src = after, so the lightbox and species filters keep working)
  function baItems(list) {
    return list.filter(b => b && (b.video || (b.before && b.after))).map(b => b.video
      ? Object.assign({ kind: "video", ba: true, w: 540, h: 960 }, b)
      : Object.assign({ kind: "beforeafter", ba: true, src: b.after, w: b.w || 800, h: b.h || 800 }, b));
  }
  function baWho(it) { return [it.name, it.breed].filter(Boolean).join(" · "); }
  function baLabel(it) { const who = baWho(it); return "До / після" + (who ? " · " + esc(who) : ""); }
  function renderGallery() {
    const grid = $("#galleryGrid");
    const f = filters.find(x => x.id === currentFilter);
    const list = galleryItems.filter(f.test);
    visibleList = list;
    if (galShown > list.length) galShown = Math.max(GAL_INITIAL, Math.min(galShown, list.length));
    grid.innerHTML = "";
    const more = $("#galleryMore");
    const show = Math.min(galShown, list.length);
    if (more) {
      if (list.length <= GAL_INITIAL) { more.hidden = true; }
      else { more.hidden = false; more.textContent = show >= list.length ? "Згорнути" : `Показати ще (${list.length - show})`; }
    }
    const hint = `<span class="g-hint"><svg class="i"><use href="#i-paw"/></svg> Переглянути</span>`;
    list.slice(0, show).forEach((it, i) => {
      const fig = document.createElement("figure");
      fig.className = "g-item";
      if (!reduced) fig.style.transitionDelay = Math.min(i, 9) * 55 + "ms";
      if (it.video) {
        fig.classList.add("g-video");
        const badge = it.ba
          ? `<span class="g-badge g-badge-ba">${baLabel(it)}</span>`
          : `<span class="g-badge g-badge-play"><svg class="i"><use href="#i-play"/></svg> Відео</span>`;
        fig.innerHTML = badge + hint +
          `<video src="${it.video}" poster="${it.src}" muted loop playsinline preload="none" width="${it.w}" height="${it.h}"` +
          (it.ba ? ` aria-label="${baLabel(it)}"` : "") + `></video>`;
        fig.addEventListener("click", () => openLightbox(i));
        grid.appendChild(fig);
        gObserver.observe(fig);
        if (AUTOPLAY_CLIPS) videoObserver.observe(fig);
      } else if (it.ba) {   // before/after slider tile (photo pair from the CRM)
        fig.classList.add("g-ba");
        const who = baWho(it);
        const alt = `GAV&LOVE — ${who || "улюбленець"}: до і після грумінгу`;
        fig.innerHTML =
          `<span class="g-badge g-badge-ba">${baLabel(it)}</span>` +
          `<img class="ba-after" src="${esc(it.ta || it.after)}" alt="${esc(alt)}" loading="lazy" decoding="async" width="${it.w}" height="${it.h}">` +
          `<div class="ba-before"><img src="${esc(it.tb || it.before)}" alt="" loading="lazy" decoding="async" width="${it.w}" height="${it.h}"></div>` +
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
          (badge ? `<span class="g-badge">${esc(badge)}</span>` : "") + hint +
          `<img src="${esc(it.t || it.src)}" alt="${esc(alt)}" loading="lazy" decoding="async" width="560" height="560">`;
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
      ? (it.ba ? `<div class="lb-vid"><video src="${it.video}" controls autoplay playsinline></video><span class="lb-cap">${baLabel(it)}</span></div>`
               : `<video src="${it.video}" controls autoplay playsinline></video>`)
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
  let MASTER_TIERS = {};   // ім'я майстра → ключ цінового рівня, якщо салон їх використовує
  // live master roster (reflects schedule/active state from the CRM)
  if (staffSel && CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/masters`).then(r => r.json()).then(d => {
      MASTER_TIERS = (d && d.tiers) || {};      // салон без рівнів надішле порожнє, і нічого не зміниться
      try { updatePriceHint(); } catch (e) { }   // ростер приїжджає асинхронно, підказка вже могла намалюватися
      if (d && d.masters && d.masters.length)
        staffSel.innerHTML = '<option value="">Будь-який майстер</option>' + d.masters.map(s => `<option>${s}</option>`).join("");
    }).catch(() => { });
  }

  // Pet segment filters the service list by species (cat services for cats, dog
  // services for dogs, "both" always); breed/weight then follow the service.
  function applyPet() { fillServiceSelect(); }

  const petSeg = $("#bf-pet-seg");
  function setPet(val) {                       // "Собака" | "Кіт" | ""
    if (!petHidden) return;
    petHidden.value = val || "";
    svcHint("");                               // the note described the previous pet
    if (petSeg) $$(".seg-btn", petSeg).forEach(x => x.classList.toggle("is-active", !!val && x.dataset.val === val));
    applyPet();
    if (typeof updatePriceHint === "function") updatePriceHint();
  }
  if (petSeg) petSeg.addEventListener("click", e => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    setPet(b.dataset.val);
    if (typeof renderSteps === "function") renderSteps();
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
  let slotsToken = 0, slotsFailed = false;
  const needsSlot = () => serviceSel && serviceSel.value && !REQUEST_SVC.includes(serviceSel.value);

  async function refreshSlots() {
    if (!timeInput) return;
    timeInput.value = ""; slotsFailed = false;
    if (waitBox) { waitBox.style.display = "none"; if (waitChk) waitChk.checked = false; }
    if (!CONFIG.bookingEndpoint || !needsSlot() || !dateInput.value) { slotsField.hidden = true; return; }
    slotsField.hidden = false; slotsBox.innerHTML = ""; slotsHint.textContent = "завантаження…";
    const my = ++slotsToken;
    try {
      const r = await fetch(`${CONFIG.bookingEndpoint}/slots?date=${dateInput.value}&service=${encodeURIComponent(serviceSel.value)}&staff=${encodeURIComponent(staffSel ? staffSel.value : "")}` +
        // порода задає тривалість візиту, а рахує її сервер: параметра «скільки хвилин» тут немає
        `&breed=${encodeURIComponent(breedSel && !breedSel.disabled ? breedSel.value : "")}&weight=${encodeURIComponent(weightSel ? weightSel.value : "")}`);
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
    } catch { if (my === slotsToken) { slotsFailed = true; slotsHint.textContent = "— не вдалося завантажити час, ми узгодимо його з вами"; } }   // never a dead end: it goes through as a request
    finally { if (my === slotsToken && typeof renderSteps === "function") renderSteps(); }
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
  // A breed list can run to forty names, so it is typeable. The <select> keeps being the source of
  // truth (it is what the form posts and what setOpt/prefill drive); the input just filters it.
  function pkNorm(v) {   // same tolerance as the price matcher: «ши тцу» finds «Ши-тцу»
    return String(v == null ? "" : v).toLowerCase().replace(/[ьъʼ’']/g, "").replace(/и/g, "і").replace(/[^a-zа-яіїєґ0-9]+/g, "");
  }
  function initPicker(sel, elsewhere) {
    if (!sel || sel.__picker) return sel && sel.__picker;
    const wrap = document.createElement("div");
    wrap.className = "picker";
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.tabIndex = -1;                       // still posted with the form, no longer a stop before the search box
    sel.setAttribute("aria-hidden", "true"); // the label now belongs to the input, so do not announce this twice
    const input = document.createElement("input");
    input.type = "text"; input.className = "picker-input"; input.autocomplete = "off"; input.autocapitalize = "off";
    input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-expanded", "false");
    if (sel.id) {
      input.id = sel.id + "-search";
      const lab = document.querySelector('label[for="' + sel.id + '"]');
      if (lab) lab.setAttribute("for", input.id);
    }
    const list = document.createElement("div");
    list.className = "picker-list"; list.hidden = true; list.setAttribute("role", "listbox");
    list.id = (input.id || "picker") + "-list";
    input.setAttribute("aria-controls", list.id);
    wrap.appendChild(input); wrap.appendChild(list);
    let open = false, active = -1, items = [], noun = "породу";
    const opts = () => [].slice.call(sel.options).filter(o => o.value);
    const holder = () => (sel.options[0] && !sel.options[0].value ? sel.options[0].textContent : "Почніть вводити…");
    function draw(q) {
      const nq = pkNorm(q);
      items = opts().filter(o => !nq || pkNorm(o.value).indexOf(nq) >= 0);
      list.innerHTML = items.length
        ? items.map((o, i) => '<div class="picker-item' + (o.value === sel.value ? " on" : "") + '" role="option" id="' + list.id + '-' + i +
            '" aria-selected="' + (o.value === sel.value ? "true" : "false") + '" data-i="' + i + '">' + esc(o.value) + '</div>').join("")
        : emptyHtml(q);
      // typing highlights the best match; merely opening the list highlights what is already chosen,
      // so Enter can never quietly swap the visitor's breed for the first one in the alphabet
      if (items.length) list.setAttribute("role", "listbox"); else list.removeAttribute("role");   // a message and a button are not options
      const cur = items.map(o => o.value).indexOf(sel.value);
      active = nq && items.length ? 0 : cur;
      mark();
    }
    // the breed may simply belong to another service — say so, and offer to move there
    function emptyHtml(q) {
      const alt = elsewhere ? elsewhere(q) : null;
      if (!alt) return '<div class="picker-empty" role="status">Не знайшли таку ' + noun + '. Виберіть найближчу зі списку — на підтвердженні уточнимо.</div>';
      return '<div class="picker-empty" role="status">«' + esc(alt.breed) + '» є в послузі «' + esc(alt.service) + '».</div>' +
        '<button type="button" class="picker-jump" data-svc="' + esc(alt.service) + '" data-breed="' + esc(alt.breed) + '">Перейти до «' + esc(alt.service) + '»</button>';
    }
    function mark() {
      [].forEach.call(list.children, (el, i) => el.classList.toggle("active", i === active));
      const on = active >= 0 && list.children[active];
      if (on && on.id) input.setAttribute("aria-activedescendant", on.id); else input.removeAttribute("aria-activedescendant");
    }
    function show(q) {
      draw(q == null ? "" : q); list.hidden = false; open = true; input.setAttribute("aria-expanded", "true");
      const vv = window.visualViewport, h = vv ? vv.height : innerHeight, top = vv ? vv.offsetTop : 0;
      const r = input.getBoundingClientRect();
      wrap.classList.toggle("up", (h + top) - r.bottom < 190 && r.top - top > 220);   // no room under the field
    }
    function hide() { list.hidden = true; open = false; input.setAttribute("aria-expanded", "false"); }
    function sync() {
      if (open) { draw(input.value); return; }   // the catalog can arrive mid-word — keep the text, refresh the rows
      input.value = sel.value || ""; input.placeholder = holder();
    }
    function pick(v) { sel.value = v; hide(); sync(); sel.dispatchEvent(new Event("change", { bubbles: true })); }
    function openAll() { show(""); setTimeout(() => input.select(), 0); }
    input.addEventListener("focus", openAll);
    input.addEventListener("click", () => { if (!open) openAll(); });   // tapping an already-focused field must reopen it
    input.addEventListener("input", () => show(input.value));
    input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!open) show(input.value);
        active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
        mark();
        const el = list.children[active]; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
        e.preventDefault();
      } else if (e.key === "Enter") {
        e.preventDefault();                     // this is a search box: Enter picks, it never submits the form
        if (open && items[active]) pick(items[active].value);
      } else if (e.key === "Escape") { hide(); sync(); }
    });
    list.addEventListener("mousedown", e => {
      const jump = e.target.closest && e.target.closest(".picker-jump");
      if (jump) {
        e.preventDefault();
        const svcName = jump.getAttribute("data-svc"), breed = jump.getAttribute("data-breed");
        if (serviceSel) { serviceSel.value = svcName; serviceSel.dispatchEvent(new Event("change", { bubbles: true })); }
        sel.value = breed; hide(); sync(); sel.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      const it = e.target.closest && e.target.closest(".picker-item");
      if (!it) return;
      e.preventDefault();                       // keep the focus so the blur handler does not fight us
      const o = items[+it.getAttribute("data-i")];
      if (o) pick(o.value);
    });
    input.addEventListener("blur", () => setTimeout(() => { hide(); sync(); }, 150));
    sel.addEventListener("change", sync);
    sel.__picker = { sync, hide, noun: n => { noun = n || "породу"; } };
    sync();
    return sel.__picker;
  }
  // Breed dropdown = the service's breeds; weight dropdown = that breed's variants.
  function syncBreedWeight() {
    if (!SERVICES.length) return;                       // keep config fallback if catalog not loaded
    if (!serviceSel.value) {                            // nothing chosen yet — do not ask for breed/weight
      if (breedField) breedField.hidden = true;
      if (weightField) weightField.hidden = true;
      return;
    }
    const s = svcByName(serviceSel.value);
    const lbl = $("#bf-breed-label");
    if (isBreedSvc(s)) {
      const isCat = s.species === "cat", ph = isCat ? "Оберіть послугу…" : "Оберіть породу…";
      if (lbl) lbl.textContent = isCat ? "Послуга" : "Порода";
      const breeds = distinctNE(s.rows.map(r => r[labelIdx(s)])), cur = breedSel.value;
      if (!isCat) breeds.sort((a, b) => a.localeCompare(b, "uk"));   // cat rows are named services, keep their order
      breedSel.innerHTML = `<option value="">${ph}</option>` + breeds.map(b => `<option>${esc(b)}</option>`).join("");
      if (cur && breeds.indexOf(cur) >= 0) breedSel.value = cur;
      if (breedField) breedField.hidden = false; breedSel.disabled = false; if (breedNote) breedNote.hidden = true;
      const pk = initPicker(breedSel, breedElsewhere); pk.noun(isCat ? "послугу" : "породу"); pk.sync();
      syncWeightForBreed();
    } else {
      if (lbl) lbl.textContent = "Порода";
      if (breedField) breedField.hidden = true; breedSel.disabled = true; breedSel.value = "";
      if (breedSel.__picker) breedSel.__picker.sync();
      if (weightField) weightField.hidden = false;
      weightSel.innerHTML = '<option value="">Оберіть вагу…</option>' + (CFG.weightOptions || []).map(w => `<option>${esc(w)}</option>`).join("");
    }
  }
  // Which other service prices this breed? Used when the search comes up empty.
  function breedElsewhere(q) {
    const nq = pkNorm(q);
    if (!nq || nq.length < 3 || !SERVICES.length) return null;
    const sp = petSpecies();
    for (const s of SERVICES) {
      if (!isBreedSvc(s) || s.bookable === 0 || s.name === serviceSel.value) continue;
      if (s.species && s.species !== "both" && sp && s.species !== sp) continue;
      const hit = distinctNE(s.rows.map(r => r[0])).filter(b => pkNorm(b).indexOf(nq) >= 0)
        .sort((a, b) => a.length - b.length)[0];
      if (hit) return { service: s.name, breed: hit };
    }
    return null;
  }
  function syncWeightForBreed() {
    const s = svcByName(serviceSel.value); if (!isBreedSvc(s)) return;
    const wi = wIdx(s);
    const weights = wi < 0 ? [] : distinctNE(s.rows.filter(r => r[labelIdx(s)] === breedSel.value).map(r => r[wi]))
      .sort((x, y) => {                                   // by kilograms, not by alphabet: «до 10 кг» before «від 30 кг»
        const nx = kgNums(x)[0], ny = kgNums(y)[0];
        if (nx == null && ny == null) return 0;
        if (nx == null) return 1;
        if (ny == null) return -1;
        return nx - ny || (/від|понад|більше/i.test(x) ? 1 : 0) - (/від|понад|більше/i.test(y) ? 1 : 0);
      });
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
  /* Ролі колонок прайсу — те саме, що у воркері. Порожні ролі означають стару поведінку:
     ціна в останній комірці, вага в другій. */
  function svcRoles(s) { return Array.isArray(s && s.col_roles) ? s.col_roles.map(x => String(x == null ? "" : x)) : []; }
  function roleAt(s, role) { const r = svcRoles(s); return r.findIndex(x => x.toLowerCase() === role); }
  function priceCols(s) {
    const out = []; svcRoles(s).forEach((r, i) => { const m = /^price(?::([a-z0-9_]{1,16}))?$/i.exec(r || ""); if (m) out.push({ key: (m[1] || "").toLowerCase(), idx: i, head: (s.columns || [])[i] || "Ціна" }); });
    return out;
  }
  function labelIdx(s) { const i = roleAt(s, "label"); return i < 0 ? 0 : i; }
  function wIdx(s) { const i = roleAt(s, "weight"); return i < 0 ? (svcRoles(s).length ? -1 : 1) : i; }
  // Цена строки для выбранного мастера; уровень неизвестен — самая дешёвая, как и на сервере.
  function rowPriceFor(s, row, tier) {
    if (!row) return null;
    const cols = priceCols(s);
    if (!cols.length) return row[row.length - 1];
    if (cols.length === 1) return row[cols[0].idx];
    const hit = tier && cols.find(c => c.key === String(tier).toLowerCase());
    if (hit) return row[hit.idx];
    const nums = cols.map(c => numOf(row[c.idx])).filter(v => v != null);
    return nums.length ? String(Math.min.apply(null, nums)) : null;
  }
  function staffTier() { return (MASTER_TIERS && staffSel && staffSel.value) ? (MASTER_TIERS[staffSel.value] || "") : ""; }

  function basePrice(s, breed, weight) {
    if (!s) return null;
    if (s.price_type === "breed") { const row = pickBreedRow(s.rows, breed, weight, wIdx(s)), p = rowPriceFor(s, row, staffTier()); return (p != null && /^\d+$/.test(String(p).trim())) ? +p : null; }
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
  // Порода тепер може задавати тривалість візиту, а від неї залежить сітка вільних годин,
  // тож після вибору породи час треба перепитати. Рахує його сервер.
  breedSel && breedSel.addEventListener("change", () => { syncWeightForBreed(); updatePriceHint(); refreshSlots(); });
  weightSel && weightSel.addEventListener("change", () => { updatePriceHint(); refreshSlots(); });
  // рівень майстра може міняти ціну, тож підказку треба перерахувати
  staffSel && staffSel.addEventListener("change", updatePriceHint);
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
    fetch(`${CONFIG.bookingEndpoint}/catalog`).then(r => r.json()).then(d => {
      applyCatalog(d);                       // a live rename may invalidate the chosen service
      if (typeof autoPicked === "string" && autoPicked && !val(serviceSel)) { autoPicked = ""; svcHint(""); }
      applyPendingPet(); autoPickService();
      renderSteps();
    }).catch(() => { });
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

  // What happens after the booking goes through: a first-timer is invited to connect Telegram —
  // that is what turns on reminders, the bonus card and the ability to move a visit in two taps.
  const UA_MONTH = ["січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"];
  const UA_DOW = ["неділя", "понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота"];
  function whenText(iso, time) {   // «субота, 20 вересня, о 11:00»
    const p = String(iso || "").split("-");
    if (p.length !== 3) return "";
    const dt = new Date(+p[0], +p[1] - 1, +p[2]);
    const day = `${UA_DOW[dt.getDay()]}, ${+p[2]} ${UA_MONTH[+p[1] - 1] || ""}`;
    return time ? `${day}, о ${time}` : day;
  }
  // The card leads with the visit: when, what, with whom. Then what the bot does.
  function showAfterBooking(d, isRequest, msg, v) {
    const box = $("#bfDone"); if (!box || !d) return;
    const tg = d.tg_link || "", bot = d.bot ? "https://t.me/" + String(d.bot).replace(/[^A-Za-z0-9_]/g, "") : "";
    const link = tg || bot;
    v = v || {};
    const when = whenText(v.date, v.time);
    const who = [v.service, v.staff ? "майстер " + v.staff : "", v.pet_name].filter(Boolean).join(" · ");
    const visitCard =
      `<div class="bf-visit">` +
        `<div class="bf-visit-when">${when ? esc(when) : "Час узгодимо з вами"}</div>` +
        (who ? `<div class="bf-visit-what">${esc(who)}</div>` : "") +
        (isRequest ? `<div class="bf-visit-note">Це заявка — ми зателефонуємо, щоб підтвердити час.</div>`
                   : `<div class="bf-visit-note">Чекаємо вас. Якщо плани зміняться — перенесіть візит у боті або в кабінеті.</div>`) +
      `</div>`;
    const L = d.loyalty;
    const botCan = [
      ["📅", "<b>записати на грумінг</b> — за пару натискань"],
      ["🔔", "<b>нагадати про візит</b> — за день і за годину"],
      ["🔁", "<b>перенести чи скасувати</b> — без дзвінків"],
      ["🔑", "<b>відкрити кабінет</b>: візити, улюбленці, фото"],
    ];
    if (L && L.reward) botCan.push(["🎁", `<b>рахувати бонуси</b>: кожен ${L.every}-й візит — ${esc(L.reward)}`]);
    if (d.linked) {   // already with us in Telegram — nothing to set up
      box.innerHTML = `<h3>Все готово 🐾</h3>` + visitCard +
        `<ul><li><span>🔔</span><span>Нагадування надішлемо в Telegram — за день і за годину.</span></li></ul>` +
        `<div class="bf-done-act"><a class="btn btn-ghost" href="cabinet.html">Мій кабінет</a></div>`;
      box.hidden = false;
      if (!reduced) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    box.innerHTML =
      `<h3>${d.first ? "Вітаємо в GAV&LOVE 🐾" : "Готово 🐾"}</h3>` + visitCard +
      `<p class="bf-done-sub">Підключіть Telegram-бот — ось що він уміє:</p>` +
      "<ul>" + botCan.map(it => `<li><span>${it[0]}</span><span>${it[1]}</span></li>`).join("") + "</ul>" +
      `<div class="bf-done-act">` +
        (link ? `<a class="btn btn-primary" href="${esc(link)}" target="_blank" rel="noopener">Підключити Telegram</a>` : "") +
        `<a class="btn btn-ghost" href="cabinet.html">Кабінет клієнта</a>` +
      `</div>` +
      `<p class="bf-done-note">У боті натисніть «📱 Поділитися номером» — за ним ми впізнаємо ваші візити. Номер бачить лише салон.</p>`;
    box.hidden = false;
    if (!reduced) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---- Guided steps: 1 улюбленець → 2 послуга → 3 дата й час → 4 контакти ---- */
  const form = $("#bookingForm"), status = $("#bfStatus");
  const nameInput = $("#bf-name"), phoneInput = $("#bf-phone"), petNameInput = $("#bf-petname");
  // the salon keeps one phone format, so tidy what was typed as soon as the field is left
  function stdPhone(p) {
    const raw = String(p == null ? "" : p).trim(); if (!raw) return "";
    let d = raw.replace(/\D/g, ""); if (!d) return raw;
    if (d.length === 9) d = "380" + d;
    else if (d.length === 10 && d[0] === "0") d = "380" + d.slice(1);
    else if (d.length === 11 && d.slice(0, 2) === "80") d = "3" + d;
    return (d.length < 10 || d.length > 15) ? raw : "+" + d;
  }
  if (phoneInput) phoneInput.addEventListener("blur", () => {
    const v = stdPhone(phoneInput.value);
    if (v && v !== phoneInput.value) { phoneInput.value = v; renderSteps(); }
  });
  const stepEls = form ? $$(".bstep", form) : [];
  const STEPS = stepEls.length || 4;
  let curStep = 1, stepsReady = false;
  const val = el => (el && el.value ? String(el.value).trim() : "");
  const shown = f => !!f && !f.hidden;
  function stepDone(i) {
    if (i === 1) return !!val(petHidden);
    if (i === 2) return !!val(serviceSel)
      && (!shown(breedField) || breedSel.disabled || !!val(breedSel))
      && (!shown(weightField) || !weightSel.options.length || !!val(weightSel));
    if (i === 3) return !!val(dateInput) && (!needsSlot() || slotsFailed || !!val(timeInput) || !!(waitChk && waitChk.checked));
    if (i === 4) return !!val(nameInput) && val(phoneInput).replace(/\D/g, "").length >= 9;
    return false;
  }
  function firstOpen() { for (let i = 1; i <= STEPS; i++) if (!stepDone(i)) return i; return STEPS; }
  function stepSummary(i) {
    if (i === 1) return [val(petHidden) || "", val(petNameInput)].filter(Boolean).join(" · ");
    if (i === 2) {
      const add = form ? form.querySelectorAll('input[name="addon"]:checked').length : 0;
      return [val(serviceSel), shown(breedField) ? val(breedSel) : "", shown(weightField) ? val(weightSel) : "", add ? "+" + add + " доп." : ""].filter(Boolean).join(" · ");
    }
    if (i === 3) {
      const d = val(dateInput), when = d ? d.slice(8) + "." + d.slice(5, 7) : "";
      const t = val(timeInput) ? "о " + val(timeInput) : (waitChk && waitChk.checked ? "лист очікування" : (needsSlot() && !slotsFailed ? "" : "час узгодимо"));
      return [when, t, val(staffSel)].filter(Boolean).join(" · ");
    }
    if (i === 4) return [val(nameInput), val(phoneInput)].filter(Boolean).join(" · ");
    return "";
  }
  function renderSteps() {
    if (!stepEls.length) return;
    const open = firstOpen();
    if (curStep > open) curStep = open;
    let done = 0;
    stepEls.forEach(li => {
      const i = +li.dataset.step, isDone = stepDone(i), isCur = i === curStep, locked = i > open;
      if (isDone) done++;
      li.classList.toggle("is-active", isCur);
      li.classList.toggle("is-done", isDone && !isCur);
      li.classList.toggle("is-locked", locked && !isCur);
      const body = $(".bstep-body", li), head = $(".bstep-head", li), sum = $(".bstep-sum", li), next = $(".bf-next", li);
      if (body) body.hidden = !isCur;
      if (head) { head.setAttribute("aria-expanded", isCur ? "true" : "false"); head.disabled = isCur || locked; }
      if (sum) sum.textContent = (isCur || !isDone) ? "" : stepSummary(i);
      if (next) next.disabled = !isDone;
    });
    const fill = $("#bfProgFill"), lbl = $("#bfProgLbl");
    if (fill) fill.style.width = Math.round(done / STEPS * 100) + "%";
    if (lbl) lbl.textContent = done === STEPS ? "Готово — можна надсилати" : "Крок " + curStep + " з " + STEPS;
  }
  function goStep(i, scroll) {
    const open = firstOpen();
    curStep = Math.max(1, Math.min(i, open));
    renderSteps();
    const li = stepEls.filter(x => +x.dataset.step === curStep)[0];
    if (scroll && li) {
      const y = li.getBoundingClientRect().top + window.scrollY - 90;
      window.scrollTo({ top: y, behavior: reduced ? "auto" : "smooth" });
      const first = li.querySelector("input:not([type=hidden]):not([readonly]), select, textarea");
      const sbody = $(".bstep-body", li);
      const coarse = matchMedia("(pointer:coarse)").matches;   // phone: focus the block, not a field, so no keyboard pops up
      const target = (first && !coarse) ? first : sbody;
      if (target) {
        if (target === sbody) sbody.tabIndex = -1;
        setTimeout(() => { try { target.focus({ preventScroll: true }); } catch (e) { } }, reduced ? 0 : 320);
      }
    }
  }
  if (form) {
    form.addEventListener("click", e => {
      const head = e.target.closest(".bstep-head");
      if (head) { const li = head.closest(".bstep"); if (li && !head.disabled) goStep(+li.dataset.step, true); return; }
      const next = e.target.closest(".bf-next");
      if (next) { const li = next.closest(".bstep"); if (li) goStep(+li.dataset.step + 1, true); return; }
      if (e.target.closest(".slot")) {   // a time is the last thing step 3 needs → move on
        renderSteps();
        if (curStep === 3 && stepDone(3)) setTimeout(() => goStep(4, true), 150);
        return;
      }
      if (e.target.closest(".seg-btn")) renderSteps();
    });
    form.addEventListener("change", () => renderSteps());
    form.addEventListener("input", () => renderSteps());
  }

  /* ---- Returning clients: prefill from the cabinet session, else from the last booking on this device ---- */
  const PF_KEY = "gl_booking_prefill", CAB_KEY = "gavlove_client_token";
  let pendingPet = null, prefillOff = false, userTouched = false;
  if (form) ["input", "change", "click"].forEach(t => form.addEventListener(t, e => { if (e.isTrusted) userTouched = true; }, true));
  const lsGet = k => { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
  const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { } };
  // the same breed is spelled differently across the price lists («йоркширский» / «йоркширський»),
  // so compare on a loose key rather than character by character
  const bKey = v => String(v == null ? "" : v).toLowerCase().replace(/[ьъʼ’']/g, "").replace(/и/g, "і").replace(/[^a-zа-яіїєґ0-9]+/g, "");
  const kgNums = v => (String(v == null ? "" : v).match(/\d+(?:[.,]\d+)?/g) || []).map(x => parseFloat(x.replace(",", ".")));
  const petKg = w => { const n = kgNums(w); if (!n.length) return null; return /понад|більше|від/i.test(String(w)) ? n[0] + 0.01 : n[n.length - 1]; };
  function bandFits(opt, kg) {   // «до 20 кг», «від 4 кг», «3–5 кг»
    const n = kgNums(opt); if (!n.length || kg == null) return false;
    if (/^\s*до\s*\d/i.test(opt)) return kg <= n[0];              // \b is useless next to Cyrillic
    if (/^\s*(від|понад|більше)\s*\d/i.test(opt)) return kg >= n[0];
    if (n.length >= 2) return kg > n[0] - 0.001 && kg <= n[1];
    return Math.abs(kg - n[0]) < 0.001;
  }
  function petRange(w) {   // the card holds a range, not a number
    const n = kgNums(w); if (!n.length) return null;
    if (/^\s*до\s*\d/i.test(String(w))) return [0, n[0]];
    if (/(понад|більше|від)/i.test(String(w))) return [n[0], Infinity];
    return n.length >= 2 ? [n[0], n[1]] : [n[0], n[0]];
  }
  function bandCovers(opt, lo, hi) {   // a band may be preselected only if the whole range fits inside it
    const n = kgNums(opt); if (!n.length) return false;
    if (/^\s*до\s*\d/i.test(opt)) return hi <= n[0];
    if (/^\s*(від|понад|більше)\s*\d/i.test(opt)) return lo >= n[0];
    if (n.length >= 2) return lo >= n[0] && hi <= n[1];
    return lo === n[0] && hi === n[0];
  }
  function setWeightOpt(sel, cardWeight) {   // the card says «10–15 кг», the price list says «до 20 кг»
    if (!sel || !cardWeight) return false;
    if (setOpt(sel, cardWeight)) return true;
    const r = petRange(cardWeight); if (!r) return false;
    const top = o => { const n = kgNums(o); return /^\s*(від|понад|більше)\s*\d/i.test(o) ? Infinity : (n.length ? n[n.length - 1] : Infinity); };
    const hit = [].slice.call(sel.options).filter(o => o.value && bandCovers(o.value, r[0], r[1]))
      .sort((x, y) => top(x.value) - top(y.value))[0];   // the tightest band that still fits, never the priciest
    if (!hit) return false;                              // a range straddling two bands is left to the visitor
    sel.value = hit.value; return true;
  }
  function setOpt(sel, v) {   // select an option only if the current list really has that value
    if (!sel || !v) return false;
    const want = bKey(v), opts = [].slice.call(sel.options).filter(o => o.value);
    const hit = opts.filter(o => o.value === v)[0]
      || opts.filter(o => bKey(o.value) === want)[0]
      || (want.length >= 4 ? opts.filter(o => { const k = bKey(o.value); return k.length >= 4 && (k.indexOf(want) >= 0 || want.indexOf(k) >= 0); })
            .sort((a, b) => Math.abs(bKey(a.value).length - want.length) - Math.abs(bKey(b.value).length - want.length))[0] : null);
    if (!hit) return false;
    sel.value = hit.value;
    if (sel.__picker) sel.__picker.sync();   // a programmatic pick must show up in the search box too
    return true;
  }
  // The breed drives the price, so we cannot invent one. If the card's breed is not on this service's
  // list, tell the visitor what their card says and which service does groom that breed.
  function breedNoteForPending() {
    if (!breedNote) return;
    const want = pendingPet && pendingPet.breed;
    if (!want || !shown(breedField) || val(breedSel)) return;
    const where = (SERVICES || []).filter(x => x.bookable !== 0 && x.price_type === "breed"
      && (x.rows || []).some(r => r && r[0] && bKey(r[0]) === bKey(want)) && x.name !== serviceSel.value)[0];
    breedNote.textContent = where
      ? `У картці улюбленця вказано «${want}» — цю породу ми стрижемо в послузі «${where.name}».`
      : `У картці улюбленця вказано «${want}» — для цієї послуги оберіть найближчу породу зі списку.`;
    breedNote.hidden = false;
  }
  function applyPendingPet() {   // breed/weight lists depend on the chosen service, so retry after each change
    if (!pendingPet) return;
    if (pendingPet.breed && shown(breedField) && !val(breedSel) && setOpt(breedSel, pendingPet.breed)) {
      if (typeof syncWeightForBreed === "function") syncWeightForBreed();
    }
    if (pendingPet.weight && shown(weightField) && !val(weightSel)) setWeightOpt(weightSel, pendingPet.weight);
    breedNoteForPending();
    if (typeof updatePriceHint === "function") updatePriceHint();
  }
  let autoPicked = "";
  function svcHint(text) {
    const el = $("#bf-svc-hint"); if (!el) return;
    el.textContent = text || ""; el.hidden = !text;
  }
  // Breed and weight decide which service applies, so offer it instead of making the visitor guess.
  function autoPickService() {
    if (!serviceSel || !SERVICES.length || !pendingPet || val(serviceSel)) return;   // never override a choice
    const want = pendingPet.breed; if (!want) return;
    const sp = petSpecies();
    const rowsFor = s => (s.rows || []).filter(r => r && r[0] && bKey(r[0]) === bKey(want));
    const fits = SERVICES.filter(s => s.bookable !== 0 && !s.is_request && s.price_type === "breed"
      && (!sp || !s.species || s.species === "both" || s.species === sp) && rowsFor(s).length);
    if (!fits.length) return;
    const kg = petKg(pendingPet.weight);
    const byWeight = kg == null ? [] : fits.filter(s => rowsFor(s).some(r => {
      const band = String(r[1] || "").trim();
      return !band || bandFits(band, kg);   // a blank weight cell prices that breed at any weight
    }));
    const pick = byWeight[0] || fits[0];
    serviceSel.value = pick.name; autoPicked = pick.name;
    serviceSel.dispatchEvent(new Event("change", { bubbles: true }));   // rebuilds breed/weight, price and steps
    svcHint("Послугу обрано за карткою улюбленця (" + [want, pendingPet.weight].filter(Boolean).join(", ") + "). Можна змінити.");
  }
  function usePet(p, fromChip) {
    if (!p) return;
    if (autoPicked && val(serviceSel) === autoPicked) serviceSel.value = "";   // our own pick, not the visitor's
    if (breedSel) breedSel.value = "";   // another pet — clear before the rebuild reads the current value
    if (weightSel) weightSel.value = "";
    setPet(p.species === "cat" || p.pet === "Кіт" ? "Кіт" : "Собака");
    if (petNameInput && (p.name || p.pet_name)) petNameInput.value = p.name || p.pet_name;
    pendingPet = { breed: p.breed || "", weight: p.weight || "" };
    applyPendingPet();
    if (fromChip) $$(".bf-pet", form).forEach(x => x.classList.toggle("is-sel", x === fromChip));
    autoPickService();
    renderSteps();
  }
  function hello(name) {
    const box = $("#bfHello"), txt = $("#bfHelloTxt");
    if (!box || !txt) return;
    txt.textContent = "Ми вас упізнали — ім'я, телефон і улюбленці вже підставлені. Перевірте та змініть за потреби.";
    box.hidden = false;
  }
  function prefillContacts(d) {
    if (prefillOff) return;
    if (nameInput && d.name && !val(nameInput)) nameInput.value = d.name;
    if (phoneInput && d.phone && !val(phoneInput)) phoneInput.value = d.phone;
  }
  const clearBtn = $("#bfHelloClear");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    prefillOff = true; pendingPet = null; lsDel(PF_KEY); lsDel(CAB_KEY);
    if (nameInput) nameInput.value = ""; if (phoneInput) phoneInput.value = ""; if (petNameInput) petNameInput.value = "";
    const pets = $("#bfPets"); if (pets) { pets.innerHTML = ""; pets.hidden = true; }
    const box = $("#bfHello"); if (box) box.hidden = true;
    setPet(""); goStep(1, false);
  });
  const PF_TTL = 60 * 24 * 3600e3;   // 60 days
  (function prefillLocal() {
    let d = null; try { d = JSON.parse(lsGet(PF_KEY) || "null"); } catch (e) { }
    if (d && (!d.t || Date.now() - d.t > PF_TTL)) { lsDel(PF_KEY); d = null; }
    if (!d || !d.phone) return;
    const rm = $("#bf-remember"); if (rm) rm.checked = true;
    prefillContacts(d);
    if (d.pet) { pendingPet = { breed: d.breed || "", weight: d.weight || "" }; setPet(d.pet); applyPendingPet(); autoPickService(); }
    if (petNameInput && d.pet_name) petNameInput.value = d.pet_name;
    hello(d.name || "");
  })();
  if (CONFIG.bookingEndpoint && lsGet(CAB_KEY)) {   // signed in to the cabinet on this device → name, phone and pets
    fetch(`${CONFIG.bookingEndpoint}/client/me`, { headers: { Authorization: "Bearer " + lsGet(CAB_KEY) } })
      .then(r => r.json()).then(d => {
        if (d && d.error === "unauthorized") lsDel(CAB_KEY);   // expired session — stop asking on every load
        if (!d || !d.ok || !d.client || prefillOff) return;
        prefillContacts({ name: d.client.name, phone: d.client.phone });
        hello((d.client.name || "").split(" ")[0]);
        const box = $("#bfPets"), pets = (d.pets || []).slice(0, 6);
        if (box && pets.length) {
          box.innerHTML = pets.map((p, i) => `<button type="button" class="bf-pet" data-i="${i}">${p.species === "cat" ? "🐱" : "🐶"} ${esc(p.name || "Улюбленець")}</button>`).join("");
          box.hidden = false;
          box.addEventListener("click", e => { const b = e.target.closest(".bf-pet"); if (b) usePet(pets[+b.dataset.i], b); });
          if (pets.length === 1 && !userTouched) { const only = box.querySelector(".bf-pet"); usePet(pets[0], only); }
        }
        renderSteps();
      }).catch(() => { });
  }
  serviceSel && serviceSel.addEventListener("change", () => { if (val(serviceSel) !== autoPicked) svcHint(""); applyPendingPet(); renderSteps(); });
  breedSel && breedSel.addEventListener("change", () => {
    if (pendingPet) pendingPet.breed = val(breedSel);
    if (breedNote && val(breedSel)) breedNote.hidden = true;
    applyPendingPet(); renderSteps();
  });   // a manual choice replaces what we remembered
  weightSel && weightSel.addEventListener("change", () => { if (pendingPet) pendingPet.weight = val(weightSel); });
  stepsReady = true; renderSteps();
  form && form.addEventListener("submit", async e => {
    e.preventDefault();
    status.className = "form-status"; status.textContent = "";
    if (!form.checkValidity()) { goStep(firstOpen(), true); form.reportValidity(); return; }   // the invalid field must be on screen
    if (CONFIG.bookingEndpoint && needsSlot() && !slotsFailed && !timeInput.value && !(waitChk && waitChk.checked)) {
      status.className = "form-status err"; status.textContent = "Оберіть, будь ласка, вільний час.";
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    data.addons = [].map.call(form.querySelectorAll('input[name="addon"]:checked'), c => c.value);
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; status.textContent = "Надсилаємо…";
    const done = $("#bfDone"); if (done) { done.hidden = true; done.innerHTML = ""; }
    try {
      let request = false, demo = false, assignedStaff = "", booked = null;
      if (CONFIG.bookingEndpoint) {
        const res = await fetch(`${CONFIG.bookingEndpoint}/book`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || "bad");
        request = d.request; assignedStaff = d.staff || ""; window._lastWait = d.waitlist; window._lastTg = d.tg_link || "";
        booked = d;
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
      if (!demo) {
        showAfterBooking(booked, request, status.textContent, {
          date: data.date || "", time: data.time || "", service: data.service || "",
          staff: assignedStaff || data.staff || "", pet_name: data.pet_name || "",
        });
        status.textContent = ""; status.className = "form-status";
      }
      const rememberMe = $("#bf-remember"), rememberOn = !rememberMe || rememberMe.checked;
      if (rememberOn) lsSet(PF_KEY, JSON.stringify({ t: Date.now(), name: data.name || "", phone: data.phone || "", pet: data.pet || "", pet_name: data.pet_name || "", breed: data.breed || "", weight: data.weight || "" }));
      else lsDel(PF_KEY);
      const keep = { name: data.name || "", phone: data.phone || "" };
      form.reset(); setPet(""); pendingPet = null;
      slotsField.hidden = true; if (timeInput) timeInput.value = "";
      const petsBox = $("#bfPets"); if (petsBox) $$(".bf-pet", petsBox).forEach(x => x.classList.remove("is-sel"));
      prefillOff = false;
      if (rememberMe) rememberMe.checked = rememberOn;
      if (rememberOn) { prefillContacts(keep); hello(""); } else { const hb = $("#bfHello"); if (hb) hb.hidden = true; }
      goStep(1, false);
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
    const full = im => im.dataset.full || im.getAttribute("src");
    // Built on every click, not once at load: the CRM can replace these photos after the page is up,
    // and a list captured at load would hold the old paths (every tile would open slide one).
    // A photo inside a section the CRM has hidden is not a slide at all.
    function slides() {
      const seen = new Set(), list = [];
      imgs.filter(im => !im.closest("[hidden]")).forEach(im => {
        const s = full(im); if (!seen.has(s)) { seen.add(s); list.push({ src: s }); }
      });
      return list;
    }
    imgs.forEach(im => im.addEventListener("click", () => {
      const list = slides(), i = list.findIndex(x => x.src === full(im));
      visibleList = list; openLightbox(i < 0 ? 0 : i);
    }));
  })();
})();
