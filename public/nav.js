/* Solve It shared navigation bar. Add <script src="/nav.js" defer></script> to any page. */
(function(){
  if (document.getElementById('sinav')) return;
  var links = [
    ['/', 'Home', function(p){return p==='/'||p==='/signup.html';}],
    ['/topics.html', 'Topics', function(p){return p==='/topics.html'||/^\/(quadratic-equations|trigonometry)/.test(p);}],
    ['/app', 'Practice', function(p){return p==='/app';}],
    ['/lessons', 'Video lessons', function(p){return p==='/lessons'||p.indexOf('/lesson/')===0;}],
    ['/teacher', 'Parents & teachers', function(p){return p==='/teacher'||p==='/teacher.html';}]
  ];
  var css = '#sinav{position:fixed;top:0;left:0;right:0;width:100%;box-sizing:border-box;z-index:50;display:flex;gap:4px;align-items:center;overflow-x:auto;white-space:nowrap;padding:8px 14px;background:rgba(250,246,237,.94);border-bottom:1px solid rgba(43,36,24,.14);font:600 14px "Work Sans",system-ui,sans-serif;-webkit-overflow-scrolling:touch}' +
    '#sinav a{flex:none;color:#2b2418;text-decoration:none;padding:7px 12px;border-radius:999px;border:1px solid transparent}' +
    '#sinav a:hover{border-color:#b5651d}' +
    '#sinav a.on{background:#b5651d;color:#fff}' +
    'html[data-theme="dark"] #sinav{background:rgba(20,35,27,.94);border-bottom-color:rgba(241,237,225,.14)}' +
    'html[data-theme="dark"] #sinav a{color:#f1ede1}' +
    'html[data-theme="dark"] #sinav a:hover{border-color:#e8c468}' +
    'html[data-theme="dark"] #sinav a.on{background:#e8c468;color:#14231b}' +
    '@media (prefers-color-scheme:dark){html:not([data-theme="light"]):not([data-theme="dark"]) #sinav{background:rgba(20,35,27,.94);border-bottom-color:rgba(241,237,225,.14)}' +
    'html:not([data-theme="light"]):not([data-theme="dark"]) #sinav a{color:#f1ede1}' +
    'html:not([data-theme="light"]):not([data-theme="dark"]) #sinav a.on{background:#e8c468;color:#14231b}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var nav = document.createElement('nav'); nav.id = 'sinav'; nav.setAttribute('aria-label', 'Site');
  var p = location.pathname.replace(/\/+$/, '') || '/';
  links.forEach(function(l){
    var a = document.createElement('a'); a.href = l[0]; a.textContent = l[1];
    if (l[2](p)) { a.className = 'on'; a.setAttribute('aria-current', 'page'); }
    nav.appendChild(a);
  });
  document.body.insertBefore(nav, document.body.firstChild);
  document.body.style.marginTop = nav.offsetHeight + 'px';
})();
