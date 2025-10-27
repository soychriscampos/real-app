// public/guard.js
(async () => {
    try {
        const r = await fetch('/api/me', { credentials: 'include' });
        if (!r.ok) throw 0;
        const j = await r.json().catch(() => ({}));
        if (!j?.ok) throw 0;
        // OK autenticado
    } catch {
        location.href = '/index.html';
    }
})();
