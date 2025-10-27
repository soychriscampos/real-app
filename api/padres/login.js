// api/padres/login.js
import supaAdmin from '../../lib/supaAdmin.js';
import bcrypt from 'bcryptjs';

// MISMO helper en el login del staff para crear la cookie/sesión.
import { setSession, setSessionDevSafe /* o setSessionDevSafe */ } from '../../lib/session.js';

const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
const setSess = isProd ? setSession : setSessionDevSafe;

export default async function handler(req, res) {
    try {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
        }

        // 1) Leer la cuenta por username
        const { data: row, error } = await supaAdmin
            .from('padres_cuentas')
            .select('tutor_id, username, activo, pass_hash')
            .eq('username', username)
            .single();

        if (error || !row) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        if (!row.activo) {
            return res.status(403).json({ error: 'Cuenta desactivada' });
        }

        // 2) Comparar el hash (bcrypt)
        const ok = await bcrypt.compare(password, row.pass_hash);
        if (!ok) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }

        // 3) Crear sesión con rol PARENT
        // Asegúrate que createSession exista y tenga firma (res, payload)
        try {
            setSess(res, { sub: row.tutor_id, username: row.username, type: 'PARENT' });

        } catch (e) {
            console.error('[padres/login] createSession failed:', e);
            return res.status(500).json({ error: 'No se pudo crear la sesión' });
        }

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[padres/login] Uncaught:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
