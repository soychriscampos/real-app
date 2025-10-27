// lib/authz.js
import supaAdmin from './supaAdmin.js';
import { getSession } from './session.js';

export function isStaff(sessionType) {
    const t = String(sessionType || '').toUpperCase();
    return t === 'ADMIN' || t === 'SUBADMIN' || t === 'CAJA';
}

/**
 * Verifica si un tutor (padre) tiene vínculo con un alumno.
 * Devuelve true/false.
 */
export async function parentCanViewAlumno(tutorId, alumnoId) {
    if (!tutorId || !alumnoId) return false;
    const { data, error } = await supaAdmin
        .from('alumno_contacto')
        .select('alumno_id')
        .eq('tutor_id', tutorId)
        .eq('alumno_id', alumnoId)
        .limit(1);
    return !error && Array.isArray(data) && data.length > 0;
}

/**
 * Exige sesión. Si es staff -> deja pasar.
 * Si es parent -> valida relación padre–alumno (por alumnoId).
 * Retorna la sesión si está autorizado; si no, ya respondió con 401/403 y retorna null.
 */
export async function requireViewAlumno(req, res, alumnoId) {
    const s = getSession(req);
    if (!s) {
        res.status(401).json({ error: 'No autorizado' });
        return null;
    }
    if (isStaff(s.type)) return s;

    if (String(s.type || '').toUpperCase() === 'PARENT') {
        if (!alumnoId) {
            res.status(400).json({ error: 'Falta alumno_id' });
            return null;
        }
        const ok = await parentCanViewAlumno(s.sub, alumnoId);
        if (!ok) {
            res.status(403).json({ error: 'No autorizado' });
            return null;
        }
        return s;
    }

    res.status(403).json({ error: 'No autorizado' });
    return null;
}
