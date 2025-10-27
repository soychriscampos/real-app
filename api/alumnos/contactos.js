// /api/alumnos/contactos.js
import supaAdmin from '../../lib/supaAdmin.js';
import { requireViewAlumno } from '../../lib/authz.js'; // PARENT/STAFF

export default async function handler(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const alumnoId = String(req.query.id || req.query.alumno_id || '').trim();
    if (!alumnoId)
        return res.status(400).json({ error: 'Falta id' });

    // === Pre-check de permisos (PARENT vinculado o STAFF) ===
    const s = await requireViewAlumno(req, res, alumnoId);
    if (!s) return;

    try {
        const { data, error } = await supaAdmin
            .from('alumno_contacto')
            .select(`
        prioridad,
        parentesco,
        via_whatsapp,
        via_email,
        recibe_factura,
        contactos!inner(
          nombre,
          whatsapp,
          email
        )
      `)
            .eq('alumno_id', alumnoId)
            .order('prioridad', { ascending: true });

        if (error) throw error;

        const out = (data || []).map(r => ({
            nombre: r.contactos?.nombre ?? null,
            whatsapp: r.contactos?.whatsapp ?? null,
            email: r.contactos?.email ?? null,
            parentesco: r.parentesco ?? null,
            prioridad: r.prioridad ?? null,
            via_whatsapp: !!r.via_whatsapp,
            via_email: !!r.via_email,
            recibe_factura: !!r.recibe_factura
        }));

        return res.status(200).json(out);
    } catch (e) {
        console.error('[alumnos/contactos] Error:', e);
        return res.status(500).json({ error: 'No se pudieron obtener contactos' });
    }
}
