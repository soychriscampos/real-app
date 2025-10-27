// /api/alumnos/update_full.js
import supaAdmin from '../../lib/supaAdmin.js';

async function readBody(req) {
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

// null si vacío/indefinido; trim seguro
const nz = v => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim(); return s.length ? s : null;
};

// número seguro a partir de "1600", "1,600", 1600; null si no válido
const toNum = (v) => {
    if (v === undefined || v === null) return null;
    const n = Number(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
};

// Reutiliza contacto existente por email o whatsapp (evita duplicados)
async function findContacto({ email, whatsapp }) {
    if (email) {
        const { data, error } = await supaAdmin
            .from('contactos').select('tutor_id')
            .eq('email', String(email).toLowerCase()).maybeSingle();
        if (!error && data) return data.tutor_id || null;
    }
    if (whatsapp) {
        const { data, error } = await supaAdmin
            .from('contactos').select('tutor_id')
            .eq('whatsapp', whatsapp).maybeSingle();
        if (!error && data) return data.tutor_id || null;
    }
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    try {
        // AHORA ACEPTA "inscripcion" ADEMÁS DE "colegiatura"
        const { id, alumno, contactos = [], colegiatura = null, inscripcion = null } = await readBody(req);
        if (!id) return res.status(400).json({ error: 'Falta id' });

        // Validación mínima del alumno
        if (!alumno?.nombre_completo || !alumno?.sexo || !alumno?.nivel || !alumno?.grado) {
            return res.status(400).json({ error: 'Completa nombre, sexo, nivel y grado' });
        }

        // 1) Actualiza alumno
        const rowA = {
            nombre_completo: alumno.nombre_completo.trim(),
            sexo: alumno.sexo,
            nivel: alumno.nivel,
            grado: Number(alumno.grado),
            estatus: alumno.estatus || 'ACTIVO',
            oficial_sep: !!alumno.oficial_sep,
            fecha_nacimiento: alumno.fecha_nacimiento ? String(alumno.fecha_nacimiento).slice(0, 10) : null
        };

        const { error: eU } = await supaAdmin.from('alumnos').update(rowA).eq('id', id);
        if (eU) return res.status(400).json({ error: eU.message });

        // 2) Contactos (upsert contacto + upsert vínculo con flags)
        const clean = (contactos || [])
            .slice(0, 5)
            .map((c, i) => ({
                idx: i,
                tutor_id: nz(c.tutor_id),
                nombre: (c.nombre || '').trim(),
                parentesco: nz(c.parentesco),
                whatsapp: nz(c.whatsapp),
                email: nz(c.email) ? c.email.toLowerCase() : null,

                // flags del vínculo
                via_whatsapp: !!c.via_whatsapp,
                via_email: !!c.via_email,
                consentimiento_mensajes: !!c.consentimiento_mensajes,
                recibe_factura: !!c.recibe_factura,

                // datos fiscales (tabla contactos)
                rfc: nz(c.rfc),
                razon_social: nz(c.razon_social),
                cp_fiscal: nz(c.cp_fiscal),
                regimen_fiscal: nz(c.regimen_fiscal),
                uso_cfdi: nz(c.uso_cfdi)
            }))
            .filter(c => c.nombre);

        // vínculos actuales para eliminar los que ya no estén
        const { data: actuales, error: eAct } = await supaAdmin
            .from('alumno_contacto').select('tutor_id').eq('alumno_id', id);
        if (eAct) return res.status(400).json({ error: eAct.message });
        const actualesSet = new Set((actuales || []).map(v => v.tutor_id));
        const nuevosSet = new Set();

        for (const c of clean) {
            let tutorIdFinal = c.tutor_id || null;

            // a) si hay tutor_id → UPDATE contacto (maneja UNIQUE)
            if (tutorIdFinal) {
                const updateRow = {
                    nombre: c.nombre,
                    whatsapp: c.whatsapp,
                    email: c.email,
                    rfc: c.rfc || null,
                    razon_social: c.razon_social || null,
                    cp_fiscal: c.cp_fiscal || null,
                    regimen_fiscal: c.regimen_fiscal || null,
                    uso_cfdi: c.uso_cfdi || null
                };
                const { error: eUpC } = await supaAdmin
                    .from('contactos').update(updateRow).eq('tutor_id', tutorIdFinal);
                if (eUpC && eUpC.code === '23505') {
                    const exist = await findContacto({ email: c.email, whatsapp: c.whatsapp });
                    if (exist) {
                        tutorIdFinal = exist;
                    } else {
                        return res.status(400).json({ error: 'Conflicto de contacto (único) y no se encontró destinatario.' });
                    }
                } else if (eUpC) {
                    return res.status(400).json({ error: eUpC.message });
                }
            } else {
                // b) sin tutor_id -> reutilizar o crear
                const exist = await findContacto({ email: c.email, whatsapp: c.whatsapp });
                if (exist) {
                    tutorIdFinal = exist;
                } else {
                    const insertRow = {
                        nombre: c.nombre,
                        whatsapp: c.whatsapp,
                        email: c.email,
                        rfc: c.rfc || null,
                        razon_social: c.razon_social || null,
                        cp_fiscal: c.cp_fiscal || null,
                        regimen_fiscal: c.regimen_fiscal || null,
                        uso_cfdi: c.uso_cfdi || null
                    };
                    const { data, error: eInsC } = await supaAdmin
                        .from('contactos').insert([insertRow]).select('tutor_id').single();
                    if (eInsC) return res.status(400).json({ error: eInsC.message });
                    tutorIdFinal = data.tutor_id;
                }
            }

            // c) vínculo alumno-contacto
            const vinc = {
                alumno_id: id,
                tutor_id: tutorIdFinal,
                parentesco: c.parentesco,
                prioridad: c.idx + 1,
                via_whatsapp: c.via_whatsapp,
                via_email: c.via_email,
                consentimiento_mensajes: c.consentimiento_mensajes,
                recibe_factura: c.recibe_factura
            };

            const { data: tryUp, error: eUpV } = await supaAdmin
                .from('alumno_contacto')
                .update(vinc)
                .eq('alumno_id', id)
                .eq('tutor_id', tutorIdFinal)
                .select('alumno_id');

            if (eUpV) return res.status(400).json({ error: eUpV.message });

            if (!tryUp || !tryUp.length) {
                const { error: eInsV } = await supaAdmin.from('alumno_contacto').insert([vinc]);
                if (eInsV) return res.status(400).json({ error: eInsV.message });
            }

            nuevosSet.add(tutorIdFinal);
        }

        // d) elimina vínculos que ya no vengan
        for (const old of actualesSet) {
            if (!nuevosSet.has(old)) {
                const { error: eDel } = await supaAdmin
                    .from('alumno_contacto')
                    .delete()
                    .eq('alumno_id', id)
                    .eq('tutor_id', old);
                if (eDel) return res.status(400).json({ error: eDel.message });
            }
        }

        // 3) COLEGIATURA: inserta nueva fila sólo si llega algo (0 es válido)
        if (colegiatura) {
            const impNum = toNum(colegiatura.importe_base);
            const vig = nz(colegiatura.vigencia_desde); // 'YYYY-MM-DD' o null
            const notas = nz(colegiatura.notas);
            const hasAnything = (impNum !== null) || !!vig || (notas !== null);

            if (hasAnything) {
                const payloadPrecio = {
                    alumno_id: id,
                    concepto: 'COLEGIATURA',
                    vigencia_desde: vig || new Date().toISOString().slice(0, 10),
                    importe_base: Number(impNum !== null ? impNum : 0),
                    notas
                };
                const { error: eP } = await supaAdmin.from('precios_alumno').insert([payloadPrecio]);
                if (eP) return res.status(400).json({ error: 'Error insertando colegiatura: ' + eP.message });
            }
        }

        // 4) INSCRIPCION: inserta nueva fila sólo si llega algo (0 es válido)
        if (inscripcion) {
            const impNum = toNum(inscripcion.importe_base);
            const vig = nz(inscripcion.vigencia_desde); // puede ser anterior al ciclo (preinscripción)
            const notas = nz(inscripcion.notas);
            const hasAnything = (impNum !== null) || !!vig || (notas !== null);

            if (hasAnything) {
                const payloadIns = {
                    alumno_id: id,
                    concepto: 'INSCRIPCION', // sin tilde para consistencia
                    vigencia_desde: vig || new Date().toISOString().slice(0, 10),
                    importe_base: Number(impNum !== null ? impNum : 0),
                    notas
                };
                const { error: eI } = await supaAdmin.from('precios_alumno').insert([payloadIns]);
                if (eI) return res.status(400).json({ error: 'Error insertando inscripción: ' + eI.message });
            }
        }

        return res.json({ ok: true });
    } catch (e) {
        console.error('[alumnos/update_full] Error:', e);
        return res.status(500).json({ error: e.message || 'Error interno' });
    }
}
