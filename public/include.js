
(async function injectPartials() {
    // Inserta cualquier <div data-include="/ruta.html">
    const slots = document.querySelectorAll('[data-include]');
    for (const el of slots) {
        const url = el.getAttribute('data-include');
        try {
            const html = await fetch(url, { cache: 'no-cache' }).then(r => r.text());
            el.innerHTML = html;
        } catch {
            el.innerHTML = '<div class="helper">No se pudo cargar el menú</div>';
        }
    }

    // Marca activo según data-page en <body>
    const page = document.body.getAttribute('data-page'); // ej: "dashboard"
    if (page) {
        document.querySelectorAll(`.topbar .nav a[data-active]`).forEach(a => {
            a.classList.toggle('active', a.dataset.active === page);
        });
    }

    // Cablear logout si existe
    const btn = document.getElementById('logout');
    if (btn) {
        btn.addEventListener('click', async () => {
            try { await fetch('/api/logout', { method: 'POST' }); }
            finally { location.href = '/index.html'; }
        });
    }
})();
