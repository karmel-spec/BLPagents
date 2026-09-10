/**
 * BLP Assistant quick-links — the agents' faces in the corner of every BLP app.
 * Default set: Clara (admin), Arnold (sales), Cris/Chris (shop). Override with
 * data-agents="clara,arnold,chris" (bottom → top) and data-labels="clara:Ask Clara — …|arnold:…".
 *
 * Embed with:
 *   <script src="https://blpagents.netlify.app/assistant.js" defer
 *           data-app="Store Map" data-user-key="blpUser"></script>
 *
 * data-user-key : localStorage key that holds the signed-in user — either a
 *                 JSON object with an `email`/`name` field, or a plain string
 *                 (an email or a first name). Checked again every few seconds,
 *                 so the face appears right after sign-in.
 * data-user     : the signed-in user's email/name if the app knows it server-side.
 * data-for      : comma list of who sees the face (emails or first names).
 *                 Default: Brigham.
 * data-always   : "1" shows the face for everyone (kiosk / shared machines).
 * data-agents   : comma list of agent slugs to show (default "clara,arnold,chris").
 * data-labels   : optional "slug:Tooltip|slug:Tooltip" overrides.
 *
 * Click a face → that agent's console page opens in a side window sized like a phone.
 * Nothing about the app or the user is sent anywhere; the widget only reads
 * the identity the app already stores.
 */
(function () {
  "use strict";
  if (window.__blpAssistantLoaded) return;
  window.__blpAssistantLoaded = true;

  var script = document.currentScript || {};
  var ds = script.dataset || {};
  var ORIGIN = (function () {
    try { return new URL(script.src).origin; } catch (e) { return "https://blpagents.netlify.app"; }
  })();
  var AGENTS = (ds.agents || ds.agent || "clara,arnold,chris").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  var LABELS = { clara: "Ask Clara — admin, scheduling, your inbox", arnold: "Ask Arnold — sales & leads", chris: "Ask Cris — the shop" };
  (ds.labels || "").split("|").forEach(function (pair) { var i = pair.indexOf(":"); if (i > 0) LABELS[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); });
  var ALWAYS = ds.always === "1";
  var FOR = (ds.for || "brigham@brighamlarsonpianos.com,brighamlarson@gmail.com,brighamlarsonpianos@gmail.com,brigham")
    .split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);

  function identity() {
    if (ds.user) return String(ds.user).toLowerCase();
    if (window.BLP_CURRENT_USER) return String(window.BLP_CURRENT_USER).toLowerCase();
    if (!ds.userKey) return "";
    try {
      var raw = localStorage.getItem(ds.userKey);
      if (!raw) return "";
      try {
        var o = JSON.parse(raw);
        if (o && typeof o === "object") return String(o.email || o.name || o.user || "").toLowerCase();
      } catch (e) { /* plain string */ }
      return String(raw).toLowerCase().replace(/^"|"$/g, "");
    } catch (e) { return ""; }
  }
  function allowed() {
    if (ALWAYS) return true;
    var id = identity();
    if (!id) return false;
    return FOR.some(function (f) { return id === f || id.indexOf(f) === 0 || id.split("@")[0] === f; });
  }

  var css =
    ".blpa-stack{position:fixed;right:18px;bottom:18px;z-index:2147482000;display:none;flex-direction:column-reverse;gap:10px;align-items:flex-end}" +
    ".blpa-stack.show{display:flex}" +
    ".blpa-item{position:relative;display:flex;align-items:center}" +
    ".blpa-btn{width:52px;height:52px;border-radius:50%;padding:0;border:3px solid #9e2020;background:#121212;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.28);overflow:hidden;transition:transform .12s;display:block}" +
    ".blpa-btn:hover{transform:scale(1.08)}" +
    ".blpa-btn img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".blpa-tip{position:absolute;right:62px;top:50%;transform:translateY(-50%);background:#121212;color:#fff;font:600 12.5px/1.2 -apple-system,Helvetica,Arial,sans-serif;padding:7px 10px;border-radius:8px;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity .15s}" +
    ".blpa-item:hover .blpa-tip{opacity:1}" +
    "@media (max-width:600px){.blpa-stack{right:12px;bottom:76px;gap:8px}.blpa-btn{width:46px;height:46px}.blpa-tip{display:none}}";

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  var stack = document.createElement("div");
  stack.className = "blpa-stack";
  AGENTS.forEach(function (slug) {
    var label = LABELS[slug] || ("Ask " + slug.charAt(0).toUpperCase() + slug.slice(1));
    var item = document.createElement("div");
    item.className = "blpa-item";
    var btn = document.createElement("button");
    btn.className = "blpa-btn";
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    var img = document.createElement("img");
    img.src = ORIGIN + "/agents/" + slug + ".jpg";
    img.alt = "";
    btn.appendChild(img);
    var tip = document.createElement("div");
    tip.className = "blpa-tip";
    tip.textContent = label;
    btn.addEventListener("click", function () {
      var url = ORIGIN + "/agents/" + slug;
      var w = 430, h = Math.min(820, Math.max(600, (window.screen && window.screen.availHeight || 800) - 80));
      var left = Math.max(0, ((window.screen && window.screen.availWidth) || 1280) - w - 40);
      var win = window.open(url, "blp-assistant-" + slug, "popup=yes,width=" + w + ",height=" + h + ",left=" + left + ",top=40");
      if (!win) window.open(url, "_blank"); // popup blocked → new tab
    });
    item.appendChild(btn);
    item.appendChild(tip);
    stack.appendChild(item);
  });

  function mount() {
    if (!document.body) return setTimeout(mount, 100);
    document.body.appendChild(stack);
    refresh();
    setInterval(refresh, 4000); // pick up sign-in without a reload
  }
  function refresh() {
    stack.classList.toggle("show", allowed());
  }
  mount();
})();
