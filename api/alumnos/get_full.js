// /api/alumnos/get_full.js
import supaAdmin from '../../lib/supaAdmin.js';
import { requireViewAlumno } from '../../lib/authz.js';

export default async function handler(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const id = (req.query.id || '').trim();
    if (!id)
        return res.status(400).json({ error: 'Falta id' });

    // === Pre-check de permisos (PARENT o STAFF) ===
    const s = await requireViewAlumno(req, res, id);
    if (!s) return;

    try {
        // ===== Alumno =====
        const { data: alumno, error: eA } = await supaAdmin
            .from('alumnos')
            .select('id, nombre_completo, sexo, nivel, grado, estatus, oficial_sep, fecha_nacimiento')
            .eq('id', id)
            .single();

        if (eA || !alumno) return res.status(404).json({ error: 'No encontrado' });

        // ===== Vínculos + flags =====
        const { data: vincs, error: eV } = await supaAdmin
            .from('alumno_contacto')
            .select('tutor_id, parentesco, prioridad, via_whatsapp, via_email, consentimiento_mensajes, recibe_factura')
            .eq('alumno_id', id);

        if (eV) throw eV;

        let contactos = [];
        if (vincs && vincs.length) {
            const tutorIds = vincs.map(v => v.tutor_id);
            const { data: det, error: eC } = await supaAdmin
                .from('contactos')
                .select('tutor_id, nombre, whatsapp, email, rfc, razon_social, cp_fiscal, regimen_fiscal, uso_cfdi')
                .in('tutor_id', tutorIds);

            if (eC) throw eC;

            const byId = new Map((det || []).map(x => [x.tutor_id, x]));
            contactos = (vincs || [])
                .sort((a, b) => (a.prioridad || 999) - (b.prioridad || 999))
                .map(v => {
                    const c = byId.get(v.tutor_id) || {};
                    return {
                        tutor_id: v.tutor_id,
                        nombre: c.nombre || '',
                        parentesco: v.parentesco || '',
                        whatsapp: c.whatsapp || '',
                        email: c.email || '',
                        via_whatsapp: !!v.via_whatsapp,
                        via_email: !!v.via_email,
                        consentimiento_mensajes: !!v.consentimiento_mensajes,
                        recibe_factura: !!v.recibe_factura,
                        rfc: c.rfc || '',
                        razon_social: c.razon_social || '',
                        cp_fiscal: c.cp_fiscal || '',
                        regimen_fiscal: c.regimen_fiscal || '',
                        uso_cfdi: c.uso_cfdi || ''
                    };
                });
        }

        // ===== Precios (colegiatura / inscripción) =====
        const { data: precios, error: eP } = await supaAdmin
            .from('precios_alumno')
            .select('concepto, vigencia_desde, importe_base, notas')
            .eq('alumno_id', id)
            .order('vigencia_desde', { ascending: false });

        if (eP) throw eP;

        const hoy = new Date().toISOString().slice(0, 10);

        // helper: normaliza "concepto"
        const norm = (s) => String(s || '').trim().toLowerCase();

        // helper: devuelve el vigente (primero <= hoy; si no hay, el más reciente)
        function pickVigente(rows) {
            if (!rows || !rows.length) return null;
            const vigente = rows.find(r => (r.vigencia_desde || '') <= hoy) || rows[0];
            return {
                importe_base: Number(vigente.importe_base || 0),
                vigencia_desde: vigente.vigencia_desde,
                notas: vigente.notas || null
            };
        }

        const listCol = (precios || []).filter(p => norm(p.concepto) === 'colegiatura');
        const listIns = (precios || []).filter(p => ['inscripcion', 'inscripción'].includes(norm(p.concepto)));

        const colegiatura = pickVigente(listCol);
        const inscripcion = pickVigente(listIns);

        // ===== Respuesta =====
        return res.status(200).json({ alumno, contactos, colegiatura, inscripcion });
    } catch (e) {
        console.error('[alumnos/get_full] Error:', e);
        return res.status(500).json({ error: 'No se pudo obtener la información' });
    }
}
