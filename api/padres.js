// /api/padres.js
import supaAdmin from '../lib/supaAdmin.js';
import bcrypt from 'bcryptjs';
import { getSession, setSession, setSessionDevSafe, clearSession } from '../lib/session.js';

const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const setSess = isProd ? setSession : setSessionDevSafe;

// Lee la acción desde ?action=... (vercel.json reescribe /api/padres/login -> ?action=login)
function getAction(req) {
    try {
        const url = new URL(req.url, 'http://localhost');
        return (url.searchParams.get('action') || '').toLowerCase().trim();
    } catch {
        return '';
    }
}

// Body parser tolerante (JSON o x-www-form-urlencoded)
async function readJson(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { return raw ? JSON.parse(raw) : {}; }
    catch {
        const params = new URLSearchParams(raw);
        return Object.fromEntries(params.entries());
    }
}

/* GET /api/padres/hijos (tras rewrite) */
async function h_hijos(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const s = getSession(req);
    if (!s) return res.status(401).json({ error: 'No autorizado' });
    if ((s.type || '').toUpperCase() !== 'PARENT') return res.status(403).json({ error: 'No autorizado' });

    const tutorId = s.sub;
    if (!tutorId) return res.status(400).json({ error: 'Falta tutor_id en la sesión' });

    try {
        const { data, error } = await supaAdmin
            .from('alumno_contacto')
            .select(`
        alumno_id,
        prioridad,
        alumnos:alumno_id ( id, nombre_completo, nivel, grado )
      `)
            .eq('tutor_id', tutorId)
            .order('prioridad', { ascending: true });

        if (error) return res.status(500).json({ error: 'Error obteniendo alumnos' });

        const rows = (data || [])
            .map(r => ({
                id: r.alumnos?.id || r.alumno_id,
                nombre_completo: r.alumnos?.nombre_completo || '',
                nivel: r.alumnos?.nivel || '',
                grado: r.alumnos?.grado ?? null,
                prioridad: r.prioridad ?? null
            }))
            .sort((a, b) => {
                const pri = (a.prioridad ?? 999) - (b.prioridad ?? 999);
                if (pri !== 0) return pri;
                const n1 = String(a.nivel || ''), n2 = String(b.nivel || '');
                if (n1 !== n2) return n1.localeCompare(n2, 'es');
                const g1 = Number(a.grado || 0), g2 = Number(b.grado || 0);
                if (g1 !== g2) return g1 - g2;
                return String(a.nombre_completo || '').localeCompare(String(b.nombre_completo || ''), 'es');
            });

        return res.status(200).json(rows);
    } catch (e) {
        console.error('[padres/hijos] error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}

/* POST /api/padres/login (tras rewrite) */
async function h_login(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { username, password } = await readJson(req);
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        const { data: row, error } = await supaAdmin
            .from('padres_cuentas')
            .select('tutor_id, username, activo, pass_hash')
            .eq('username', username)
            .single();

        if (error || !row) return res.status(401).json({ error: 'Credenciales inválidas' });
        if (!row.activo) return res.status(403).json({ error: 'Cuenta desactivada' });

        const ok = await bcrypt.compare(password, row.pass_hash);
        if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

        try {
            setSess(res, { sub: row.tutor_id, username: row.username, type: 'PARENT' });
        } catch (e) {
            console.error('[padres/login] setSession failed:', e);
            return res.status(500).json({ error: 'No se pudo crear la sesión' });
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[padres/login] Uncaught:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}

/* ANY /api/padres?action=logout */
async function h_logout(_req, res) {
    try {
        clearSession(res);
        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[padres/logout] error:', e);
        return res.status(500).json({ error: 'No se pudo cerrar sesión' });
    }
}

/* Router ÚNICO */
export default async function handler(req, res) {
    try {
        const action = getAction(req);
        switch (action) {
            case 'hijos': return h_hijos(req, res);
            case 'login': return h_login(req, res);
            case 'logout': return h_logout(req, res);
            default:
                return res.status(404).json({ error: 'Acción no soportada' });
        }
    } catch (e) {
        console.error('[padres/*] Error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
