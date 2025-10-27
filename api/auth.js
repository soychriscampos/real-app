// api/auth.js
import { setSession, setSessionDevSafe, clearSession as _clear } from '../lib/session.js';

const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const setSess = isProd ? setSession : setSessionDevSafe;

function getAction(req) {
    const url = new URL(req.url, 'http://localhost');
    return (url.searchParams.get('action') || '').toLowerCase();
}

async function readBody(req) {
    // Usa lo que ya venga parseado
    if (req.body !== undefined && req.body !== null) {
        if (typeof req.body === 'object') return req.body;
        if (typeof req.body === 'string') {
            try { return JSON.parse(req.body); } catch {
                const params = new URLSearchParams(req.body);
                return Object.fromEntries(params.entries());
            }
        }
    }
    // Si no, lee el stream una sola vez
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { return raw ? JSON.parse(raw) : {}; } catch {
        const params = new URLSearchParams(raw);
        return Object.fromEntries(params.entries());
    }
}

function doClearSession(res) {
    if (typeof _clear === 'function') return _clear(res);
    // Fallback: limpia cookie "session"
    const secure = isProd ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `session=; Max-Age=0; Path=/; HttpOnly;${secure} SameSite=Lax`);
}

/* === POST /api/login -> /api/auth?action=login === */
async function h_login(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    try {
        const body = await readBody(req);
        const username = body?.username ?? null;
        const password = body?.password ?? null;

        if (!username || !password) {
            return res.status(400).json({ error: 'Credenciales incompletas' });
        }

        // Tu lógica existente (respetada):
        const { verifyLogin, signAppJWT } = await import('../lib/supaAdmin.js');
        const user = await verifyLogin(username, password);
        const token = signAppJWT({ sub: user.id, username: user.username });

        // setear cookie HttpOnly (Secure en prod)
        setSess(res, { sub: user.id, username: user.username, type: user.type });

        // Respuesta compatible con tu frontend
        return res.status(200).json({ token, user });
    } catch (e) {
        return res.status(401).json({ error: e.message || 'Credenciales inválidas' });
    }
}

/* === GET/POST /api/logout -> /api/auth?action=logout === */
async function h_logout(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
        doClearSession(res);
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: 'Error interno' });
    }
}

/* === Router === */
export default async function handler(req, res) {
    try {
        const action = getAction(req);
        switch (action) {
            case 'login': return h_login(req, res);
            case 'logout': return h_logout(req, res);
            default: return res.status(404).json({ error: 'Acción no soportada' });
        }
    } catch (e) {
        return res.status(500).json({ error: 'Error interno' });
    }
}
