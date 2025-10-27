// api/alumnos/create.js
import supaAdmin from '../../lib/supaAdmin.js';

async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body; // Vercel a veces ya lo parsea
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { return raw ? JSON.parse(raw) : {}; } catch {
        const params = new URLSearchParams(raw);
        return Object.fromEntries(params.entries());
    }
}

// normaliza strings vacíos -> null
const nz = v => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
};

// busca contacto existente por email o whatsapp
async function findContacto({ email, whatsapp }) {
    if (email) {
        const { data, error } = await supaAdmin
            .from('contactos')
            .select('tutor_id')
            .eq('email', email.toLowerCase())
            .maybeSingle();
        if (!error && data) return data.tutor_id || null;
    }
    if (whatsapp) {
        const { data, error } = await supaAdmin
            .from('contactos')
            .select('tutor_id')
            .eq('whatsapp', whatsapp)
            .maybeSingle();
        if (!error && data) return data.tutor_id || null;
    }
    return null;
}

// crea contacto; si choca UNIQUE por email/whatsapp, regresa el existente
async function getOrCreateContacto(c) {
    const email = nz(c.email) ? c.email.toLowerCase() : null;
    const whatsapp = nz(c.whatsapp);

    // 1) si ya existe, úsalo
    const existing = await findContacto({ email, whatsapp });
    if (existing) return existing;

    // 2) intenta insertar
    const insertRow = {
        nombre: c.nombre,
        whatsapp,
        email,
        rfc: nz(c.rfc),
        razon_social: nz(c.razon_social),
        cp_fiscal: nz(c.cp_fiscal),
        regimen_fiscal: nz(c.regimen_fiscal),
        uso_cfdi: nz(c.uso_cfdi)
    };

    const { data, error } = await supaAdmin
        .from('contactos')
        .insert([insertRow])
        .select('tutor_id')
        .single();

    if (!error && data) return data.tutor_id;

    // 3) si chocó por UNIQUE (23505), reintenta leer
    if (error && error.code === '23505') {
        const again = await findContacto({ email, whatsapp });
        if (again) return again;
    }

    throw new Error(error?.message || 'No se pudo crear contacto');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const { alumno, contactos = [], colegiatura = null } = await readBody(req);

        if (!alumno?.nombre_completo || !alumno?.sexo || !alumno?.nivel || !alumno?.grado) {
            return res.status(400).json({ error: 'Completa nombre, sexo, nivel y grado' });
        }

        // -------- ALUMNO --------
        const rowA = {
            nombre_completo: alumno.nombre_completo.trim(),
            sexo: alumno.sexo,
            nivel: alumno.nivel,
            grado: Number(alumno.grado),
            estatus: alumno.estatus || 'ACTIVO',
            oficial_sep: !!alumno.oficial_sep
        };

        const { data: insA, error: eA } = await supaAdmin
            .from('alumnos')
            .insert([rowA])
            .select('id')
            .single();

        if (eA) return res.status(400).json({ error: eA.message });
        const alumno_id = insA.id;

        // -------- CONTACTOS -> contactos + alumno_contacto --------
        const clean = (contactos || [])
            .slice(0, 5)
            .map((c, i) => ({
                idx: i,
                nombre: (c.nombre || '').trim(),
                parentesco: nz(c.parentesco),
                whatsapp: nz(c.whatsapp),
                email: nz(c.email),
                via_whatsapp: !!c.via_whatsapp,
                via_email: !!c.via_email,
                consentimiento_mensajes: !!c.consentimiento_mensajes,
                recibe_factura: !!c.recibe_factura,
                rfc: nz(c.rfc),
                razon_social: nz(c.razon_social),
                cp_fiscal: nz(c.cp_fiscal),
                regimen_fiscal: nz(c.regimen_fiscal),
                uso_cfdi: nz(c.uso_cfdi)
            }))
            .filter(c => c.nombre);

        for (const c of clean) {
            const tutor_id = await getOrCreateContacto(c);

            const vinculo = {
                alumno_id,
                tutor_id,
                parentesco: c.parentesco,
                prioridad: c.idx + 1, // prioridad según orden de captura
                via_whatsapp: c.via_whatsapp,
                via_email: c.via_email,
                consentimiento_mensajes: c.consentimiento_mensajes,
                recibe_factura: c.recibe_factura
            };

            const { error: eL } = await supaAdmin.from('alumno_contacto').insert([vinculo]);
            if (eL) return res.status(400).json({ error: eL.message });
        }

        // -------- COLEGIATURA (opcional) --------
        // Ahora insertamos si el objeto trae importe (aunque sea 0), o fecha, o notas.
        if (colegiatura) {
            // normalizar importe (acepta "0", "1,600", etc.)
            let impNorm = null;
            const hasImp = colegiatura.importe_base !== undefined && colegiatura.importe_base !== null;
            if (hasImp) {
                const raw = String(colegiatura.importe_base).replace(/,/g, '').trim();
                const n = Number(raw);
                impNorm = Number.isFinite(n) ? n : 0; // 0 es válido
            }

            const hasVig = !!(colegiatura.vigencia_desde && String(colegiatura.vigencia_desde).trim());
            const notasNorm = nz(colegiatura.notas);
            const hasNotas = notasNorm !== null;

            if (hasImp || hasVig || hasNotas) {
                const payloadPrecio = {
                    alumno_id,
                    concepto: 'COLEGIATURA',
                    vigencia_desde: hasVig ? colegiatura.vigencia_desde : new Date().toISOString().slice(0, 10),
                    importe_base: hasImp ? impNorm : 0,
                    notas: notasNorm
                };

                console.log('[create] Insertando precios_alumno:', payloadPrecio);

                const { error: eP } = await supaAdmin.from('precios_alumno').insert([payloadPrecio]);
                if (eP) return res.status(400).json({ error: 'Error insertando colegiatura: ' + eP.message });
            }
        }

        return res.status(201).json({ ok: true, id: alumno_id });
    } catch (e) {
        console.error('[create] Error:', e);
        return res.status(500).json({ error: e.message || 'Error interno' });
    }
}
