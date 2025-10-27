// public/padres/guard-parents.js
(function () {
    const ALLOW = new Set(['PARENT', 'ADMIN', 'SUBADMIN', 'CAJA']);

    (async () => {
        try {
            const r = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
            if (!r.ok) throw new Error('no me');
            const j = await r.json();
            const type = String(j?.user?.type || '').toUpperCase();

            if (!ALLOW.has(type)) {
                // No tiene ningún rol permitido -> llevar a login de padres
                location.replace('/padres/login.html');
                return;
            }

            // bandera: el resto de scripts pueden continuar
            window.__PARENT_OR_STAFF_OK = true;
        } catch {
            location.replace('/padres/login.html');
        }
    })();
})();
