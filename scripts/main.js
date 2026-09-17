/* ============================================================
   Little Paw by Hanna — site logic
   ============================================================ */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia("(prefers-reduced-motion:reduce)").matches;

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
    if (!window.LP_PRICES) panels.innerHTML = '<p class="price-empty">Прайс тимчасово недоступний.</p>';
    else renderPrices(window.LP_PRICES);   // instant render from bundled prices

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
      return { id: "svc-" + i, title: s.name, icon: iconForSvc(s), searchable: s.price_type === "breed", columns, rows, note: s.note };
    });
    return { note_gift: (notes && notes.gift) || "", note_big: (notes && notes.big) || "", categories: cats };
  }
  // Orientative price shown in the booking form for the chosen service (+breed).
  function priceHint(s, breed) {
    if (!s) return "";
    if (s.price_type === "breed") {
      if (breed) { const row = (s.rows || []).find(r => String(r[0]) === String(breed)); if (row && row[1]) return `Орієнтовна ціна для «${esc(breed)}»: <b>${esc(row[1])} ₴</b>`; }
      const nums = (s.rows || []).map(r => numOf(r[1])).filter(n => n != null);
      return nums.length ? `Ціна залежить від породи — <b>від ${Math.min.apply(null, nums)} ₴</b>` : "";
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
    // interleave: photos lead, one video sprinkled roughly every 4 photos
    galleryItems = []; let vi = 0;
    photos.forEach((p, idx) => {
      galleryItems.push(p);
      if (idx % 4 === 3 && vi < vids.length) galleryItems.push(vids[vi++]);
    });
    while (vi < vids.length) galleryItems.push(vids[vi++]);
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
    weightSel = $("#bf-weight"), staffSel = $("#bf-staff");

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

  function applyPet() {
    const isCat = petHidden.value === "Кіт";
    if (breedSel) { breedSel.hidden = isCat; breedSel.disabled = isCat; }  // cats: no breed → excluded from submit
    if (breedNote) breedNote.hidden = !isCat;
  }
  applyPet();

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
    if (waitBox) { waitBox.hidden = true; if (waitChk) waitChk.checked = false; }
    if (!CONFIG.bookingEndpoint || !needsSlot() || !dateInput.value) { slotsField.hidden = true; return; }
    slotsField.hidden = false; slotsBox.innerHTML = ""; slotsHint.textContent = "завантаження…";
    const my = ++slotsToken;
    try {
      const r = await fetch(`${CONFIG.bookingEndpoint}/slots?date=${dateInput.value}&service=${encodeURIComponent(serviceSel.value)}&staff=${encodeURIComponent(staffSel ? staffSel.value : "")}`);
      const d = await r.json();
      if (my !== slotsToken) return;
      const slots = d.slots || [];
      if (!slots.length) { slotsHint.textContent = "— на цей день вільних слотів немає"; if (waitBox) waitBox.hidden = false; return; }
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
  // service select, the in-form price hint, and the site «Ціни» tables.
  let SERVICES = [];
  function updatePriceHint() {
    const el = $("#bf-price-hint"); if (!el || !serviceSel) return;
    const s = SERVICES.find(x => x.name === serviceSel.value);
    const breed = (breedSel && !breedSel.disabled) ? breedSel.value : "";
    const h = priceHint(s, breed);
    el.innerHTML = h; el.hidden = !h;
  }
  serviceSel && serviceSel.addEventListener("change", updatePriceHint);
  breedSel && breedSel.addEventListener("change", updatePriceHint);
  if (CONFIG.bookingEndpoint) {
    fetch(`${CONFIG.bookingEndpoint}/catalog`).then(r => r.json()).then(d => {
      if (!d) return;
      SERVICES = d.services || [];
      const bookable = SERVICES.filter(s => s.bookable !== 0);
      if (bookable.length && serviceSel) {
        const prev = serviceSel.value;
        const ph = serviceSel.querySelector('option[value=""]');
        const phHtml = ph ? ph.outerHTML : '<option value="">Оберіть послугу…</option>';
        serviceSel.innerHTML = phHtml + bookable.map(s =>
          `<option value="${esc(s.name)}">${esc(s.name)}${s.duration ? " · ~" + fmtDur(s.duration) : ""}</option>`).join("");
        if (prev && bookable.some(s => s.name === prev)) serviceSel.value = prev;
        REQUEST_SVC = bookable.filter(s => s.is_request).map(s => s.name);
        updatePriceHint();
      }
      renderPrices(servicesToCatalog(SERVICES, d.notes));
    }).catch(() => { });
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
        request = d.request; assignedStaff = d.staff || ""; window._lastWait = d.waitlist;
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
