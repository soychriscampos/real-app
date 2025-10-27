// api/login.js
import { setSession, setSessionDevSafe /* o setSessionDevSafe */ } from '../lib/session.js';

const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const setSess = isProd ? setSession : setSessionDevSafe;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method Not Allowed' });
        return;
    }

    try {
        let username = null, password = null;

        // 1) Usa lo que ya venga en req.body (Vercel/micro a veces lo provee)
        let body = req.body;

        // 2) Si no existe, lee el stream una sola vez
        if (body === undefined || body === null) {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString('utf8');

            // Intenta JSON primero, luego URL-encoded
            try {
                body = raw ? JSON.parse(raw) : {};
            } catch {
                const params = new URLSearchParams(raw);
                body = Object.fromEntries(params.entries());
            }
        } else if (typeof body === 'string') {
            // Si viene como string, intenta parsearlo como JSON
            try { body = JSON.parse(body); } catch { /* lo dejamos como string */ }
        }

        // 3) Extrae credenciales
        if (body && typeof body === 'object') {
            username = body.username ?? null;
            password = body.password ?? null;
        } else if (typeof body === 'string') {
            // Último intento si era string plano: tratar como querystring
            const params = new URLSearchParams(body);
            username = params.get('username');
            password = params.get('password');
        }

        if (!username || !password) {
            res.status(400).json({ error: 'Credenciales incompletas' });
            return;
        }

        const { verifyLogin, signAppJWT } = await import('../lib/supaAdmin.js');
        const user = await verifyLogin(username, password);
        const token = signAppJWT({ sub: user.id, username: user.username });

        // NUEVO: setear cookie HttpOnly (en prod con Secure; en local sin Secure)
        setSess(res, { sub: user.id, username: user.username, type: user.type });

        // RESPUESTA NO CAMBIA: recibiendo token + user (por compatibilidad)
        res.status(200).json({ token, user });
    } catch (e) {
        res.status(401).json({ error: e.message || 'Credenciales inválidas' });
    }
}
