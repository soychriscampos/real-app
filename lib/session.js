// lib/session.js
import jwt from 'jsonwebtoken';

const COOKIE = 'real_sess';

export function setSession(res, payload, maxAgeSec = 60 * 60 * 8) {
    const token = jwt.sign(payload, process.env.APP_JWT_SECRET, { expiresIn: maxAgeSec });
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax; Secure`);
}

export function clearSession(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`);
}

export function getSession(req) {
    try {
        const cookie = req.headers.cookie || '';
        const m = cookie.match(new RegExp(`${COOKIE}=([^;]+)`));
        if (!m) return null;
        return jwt.verify(m[1], process.env.APP_JWT_SECRET);
    } catch {
        return null;
    }
}

export function requireAuth(req, res) {
    const s = getSession(req);
    if (!s) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'No autorizado' }));
        return null;
    }
    return s;
}

export function setSessionDevSafe(res, payload, maxAgeSec = 60 * 60 * 8) {
    const token = jwt.sign(payload, process.env.APP_JWT_SECRET, { expiresIn: maxAgeSec });
    const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
    const cookie = [
        `real_sess=${token}`,
        'HttpOnly',
        'Path=/',
        `Max-Age=${maxAgeSec}`,
        'SameSite=Lax',
        isProd ? 'Secure' : '' // en local NO agrega Secure
    ].filter(Boolean).join('; ');
    res.setHeader('Set-Cookie', cookie);
}