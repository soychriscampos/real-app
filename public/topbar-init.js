// /topbar-init.js
(function () {
    const $ = (id) => document.getElementById(id);

    // ========= Helpers de navegación =========
    function getBodyPage() {
        try { return document.body.getAttribute('data-page') || ''; } catch { return ''; }
    }
    function setActiveLink() {
        const page = getBodyPage();
        document.querySelectorAll('.nav-link').forEach(a => {
            const key = a.getAttribute('data-active') || '';
            if (key && key === page) a.classList.add('active');
            else a.classList.remove('active');
        });
    }

    // ========= Caché /api/me (memoria + sessionStorage) =========
    const ME_CACHE_KEY = 'me:v1';
    let __ME_MEMO = null;                  // { data, ts, promise? }
    const DEFAULT_TTL = 60_000;            // 60s

    function readCachedMe() {
        try {
            if (__ME_MEMO && (Date.now() - __ME_MEMO.ts) < DEFAULT_TTL && __ME_MEMO.data) {
                return __ME_MEMO.data; // memoria fresca
            }
            const raw = sessionStorage.getItem(ME_CACHE_KEY);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (!obj || !obj.ts || !obj.data) return null;
            if ((Date.now() - obj.ts) > DEFAULT_TTL) return null; // vencido
            __ME_MEMO = { data: obj.data, ts: obj.ts };
            return obj.data;
        } catch { return null; }
    }
    function writeCachedMe(data) {
        __ME_MEMO = { data, ts: Date.now() };
        try { sessionStorage.setItem(ME_CACHE_KEY, JSON.stringify(__ME_MEMO)); } catch { }
    }
    function getMeCached() {
        if (__ME_MEMO?.promise) return __ME_MEMO.promise; // reusar promesa en vuelo

        const cached = readCachedMe();
        const mustFetch = !cached;

        const p = (async () => {
            if (!mustFetch) return cached; // usar cache inmediato
            try {
                const r = await fetch('/api/me', { credentials: 'same-origin' });
                if (!r.ok) throw new Error('me not ok');
                const j = await r.json();
                writeCachedMe(j);
                return j;
            } finally {
                __ME_MEMO.promise = null; // limpiar bandera
            }
        })();

        __ME_MEMO = __ME_MEMO || {};
        __ME_MEMO.promise = p;

        return p.catch(() => cached || null);
    }
    // expón para otras páginas si lo necesitan
    window.getMeCached = getMeCached;

    // ========= UI según rol / usuario =========
    function filterByRole(me) {
        const type = (me?.user?.type || '').toUpperCase();
        document.querySelectorAll('.menu .nav-link[data-role]').forEach(a => {
            const allowed = String(a.getAttribute('data-role') || '')
                .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            if (allowed.length && !allowed.includes(type)) {
                a.style.display = 'none';
            } else {
                a.style.display = '';
            }
        });
    }

    function setHelloUserInstant() {
        const span = $('helloUser');
        if (!span) return;
        const me = readCachedMe();
        const raw = (me?.user?.nombre || me?.user?.username || '').trim();
        if (raw) span.textContent = raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    function setHelloUser(me) {
        const span = $('helloUser');
        if (!span) return;
        const raw = (me?.user?.nombre || me?.user?.username || '').trim();
        span.textContent = raw ? (raw.charAt(0).toUpperCase() + raw.slice(1)) : 'Usuario';
    }

    // ========= Comportamiento topbar =========
    function bindHamburger() {
        const btn = $('btnHamburger');
        const menu = $('mainMenu');
        if (!btn || !menu) return;

        menu.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = menu.classList.toggle('open');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        document.addEventListener('click', (e) => {
            if (window.innerWidth > 900) return;
            if (!menu.classList.contains('open')) return;
            const withinMenu = e.target.closest('#mainMenu');
            const withinBtn = e.target.closest('#btnHamburger');
            if (!withinMenu && !withinBtn) {
                menu.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && menu.classList.contains('open')) {
                menu.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    function bindUserDropdown() {
        const btn = $('userDropdownBtn');
        const menu = $('userDropdownMenu');
        if (!btn || !menu) return;

        const closeMenu = () => { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
        const openMenu = () => { menu.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); };

        closeMenu();
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.contains('open') ? closeMenu() : openMenu();
        });
        document.addEventListener('click', (e) => {
            if (!menu.classList.contains('open')) return;
            if (!e.target.closest('.userdrop')) closeMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && menu.classList.contains('open')) closeMenu();
        });
    }

    function bindLogout() {
        const btn = $('logout');
        if (!btn) return;
        btn.addEventListener('click', async () => {
            try { await fetch('/api/logout', { method: 'POST' }); } catch { }
            location.href = '/index.html';
        });
    }

    // ========= Init =========
    document.addEventListener('DOMContentLoaded', async () => {
        // Pinta INSTANT el usuario si hay caché
        setHelloUserInstant();

        // reintenta hasta que include.js haya inyectado el partial
        const retry = (fn, tries = 10) => new Promise(res => {
            const tick = () => {
                if (document.getElementById('mainMenu')) { fn(); return res(); }
                if (tries-- <= 0) return res();
                setTimeout(tick, 60);
            };
            tick();
        });

        await retry(() => {
            setActiveLink();
            bindHamburger();
            bindUserDropdown();
            bindLogout();
        });

        // Revalida en background y actualiza si cambió
        const me = await getMeCached();
        if (me) {
            filterByRole(me);
            setHelloUser(me);
        }
    });
})();
