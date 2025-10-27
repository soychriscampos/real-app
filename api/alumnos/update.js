// /api/alumnos/update.js
import supaAdmin from '../../lib/supaAdmin.js';

export default async function handler(req, res) {
    if (req.method !== 'POST')
        return res.status(405).json({ error: 'Método no permitido' });

    const { id, nombre_completo, sexo, nivel, grado, estatus, oficial_sep, fecha_nacimiento } = req.body || {};

    if (!id) return res.status(400).json({ error: 'Falta ID del alumno' });

    try {
        const { error } = await supaAdmin
            .from('alumnos')
            .update({
                nombre_completo,
                sexo,
                nivel,
                grado,
                estatus,
                oficial_sep,
                fecha_nacimiento
            })
            .eq('id', id);

        if (error) throw error;

        res.status(200).json({ ok: true });
    } catch (e) {
        console.error('[alumnos/update] Error:', e);
        res.status(500).json({ error: 'No se pudo actualizar el alumno' });
    }
}
