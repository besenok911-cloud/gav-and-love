/* GAV&LOVE — PWA glue for admin.html / master.html / cabinet.html.
   Registers the service worker and shows a one-line "install" hint on the login screen:
   iOS Safari has no install prompt (Share → Add to Home Screen), Chrome/Android gets a real button. */
(function () {
  var standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (standalone) document.documentElement.classList.add("standalone");

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(function () { }); });
  }

  var st = document.createElement("style");
  st.textContent = ".pwa-hint{margin:14px 0 0;font-size:.82rem;color:var(--ink-soft,#6d6484);line-height:1.45}" +
    ".pwa-hint b{color:var(--ink,#221a38)}" +
    ".pwa-hint button{font:inherit;font-weight:700;color:var(--violet,#4a25c9);background:none;border:1.5px solid currentColor;border-radius:999px;padding:.4em 1em;cursor:pointer}" +
    "html.standalone body{padding-top:env(safe-area-inset-top)}";
  document.head.appendChild(st);

  var hint = document.getElementById("pwaHint");
  if (!hint || standalone) return;
  var ua = navigator.userAgent;
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);

  if (isIOS) {
    hint.innerHTML = isSafari
      ? "📲 Щоб відкривати як застосунок: натисніть <b>Поділитися</b> (квадрат зі стрілкою) → <b>На Початковий екран</b>."
      : "📲 Щоб встановити як застосунок, відкрийте цю сторінку в <b>Safari</b>: Поділитися → На Початковий екран.";
    hint.hidden = false;
    return;
  }
  var deferred = null;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    hint.innerHTML = '<button type="button">📲 Встановити застосунок</button>';
    hint.hidden = false;
    hint.querySelector("button").addEventListener("click", function () {
      if (!deferred) return; deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; hint.hidden = true; });
    });
  });
  window.addEventListener("appinstalled", function () { hint.hidden = true; });
})();
