// lib/supaAdmin.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_JWT_SECRET } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
}

// Cliente ADMIN (server-side)
const supaAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

export default supaAdmin;

/**
 * Autentica contra tu función SQL verify_login()
 * y regresa el registro del usuario (id, username, type).
 */
export async function verifyLogin(username, password) {
    if (!username || !password) throw new Error('Credenciales incompletas');

    // 1) Llama a la función SQL
    const { data: ok, error: e1 } = await supaAdmin.rpc('verify_login', {
        p_username: username,
        p_password: password,
    });

    if (e1) throw new Error('Error al verificar credenciales');
    if (!ok) throw new Error('Usuario o contraseña incorrectos');

    // 2) Carga datos del usuario
    const { data: userRow, error: e2 } = await supaAdmin
        .from('usuarios_plat')
        .select('id_user, username, type, activo')
        .eq('username', username)
        .single();

    if (e2) throw new Error('No se pudo leer el usuario: ' + e2.message);
    if (!userRow || userRow.activo !== true) throw new Error('Usuario inactivo');

    return { id: userRow.id_user, username: userRow.username, type: userRow.type };
}

export function signAppJWT(payload, opts = {}) {
    if (!APP_JWT_SECRET) throw new Error('Falta APP_JWT_SECRET');
    return jwt.sign(payload, APP_JWT_SECRET, { expiresIn: '1d', ...opts });
}
