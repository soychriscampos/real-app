// /api/me.js
import { getSession } from '../lib/session.js';
import supaAdmin from '../lib/supaAdmin.js';

export default async function handler(req, res) {
    const s = getSession(req);
    if (!s) return res.status(401).json({ ok: false });

    let row = null;

    try {
        // 1) Intento por id_user (UUID del usuario en tu tabla)
        if (s.sub) {
            const { data, error } = await supaAdmin
                .from('usuarios_plat')
                .select('id_user, username, sexo')
                .eq('id_user', s.sub)
                .maybeSingle();
            if (!error && data) row = data;
        }

        // 2) Fallback por username (case-insensitive)
        if (!row && s.username) {
            const { data, error } = await supaAdmin
                .from('usuarios_plat')
                .select('id_user, username, sexo')
                .ilike('username', s.username) // case-insensitive
                .maybeSingle();
            if (!error && data) row = data;
        }
    } catch (e) {
        // no rompemos sesión si falla la consulta
        // console.error('[me] lookup error:', e);
    }

    // Normaliza sexo a 'H' | 'M' | null
    const sexo = row?.sexo == null ? null : String(row.sexo).trim().toUpperCase();
    // (no hay columna 'nombre' en tu tabla, así que no lo mandamos)
    return res.json({
        ok: true,
        user: {
            id: s.sub,
            username: s.username,
            type: s.type,
            sexo: (sexo === 'H' || sexo === 'M') ? sexo : null
        }
    });
}
