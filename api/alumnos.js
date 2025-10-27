// api/alumnos.js
import supaAdmin from '../lib/supaAdmin.js';
import { requireViewAlumno } from '../lib/authz.js'; // ajusta si tu helper está en otro archivo

// Utilidades comunes
function getAction(req) {
    const url = new URL(req.url, 'http://localhost');
    return (url.searchParams.get('action') || '').toLowerCase();
}
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
const nz = v => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim(); return s.length ? s : null;
};
const toNum = (v) => {
    if (v === undefined || v === null) return null;
    const n = Number(String(v).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
};
function normalizeNoAccents(s = '') {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// ========== HANDLERS ==========

// GET /api/alumnos/aplicaciones?alumno_id=&ciclo=
async function h_aplicaciones(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const alumno_id = (req.query.alumno_id || '').trim();
    const ciclo = (req.query.ciclo || '').trim();
    if (!alumno_id || !ciclo) return res.status(400).json({ error: 'Falta alumno_id o ciclo' });

    try {
        const { data: cicloRow, error: eC } = await supaAdmin
            .from('ciclos').select('id').eq('ciclo', ciclo).single();
        if (eC || !cicloRow) return res.status(400).json({ error: 'Ciclo no válido' });
        const ciclo_id = cicloRow.id;

        const { data, error } = await supaAdmin
            .from('pago_aplicaciones')
            .select(`
        periodo,
        monto_aplicado,
        pagos:pagos!inner(fecha_pago, metodo_de_pago)
      `)
            .eq('alumno_id', alumno_id)
            .eq('ciclo_id', ciclo_id)
            .order('pagos.fecha_pago', { ascending: false });

        if (error) throw error;

        const out = (data || []).map(r => ({
            periodo: r.periodo,
            monto_aplicado: Number(r.monto_aplicado || 0),
            fecha_pago: r.pagos?.fecha_pago || null,
            metodo_de_pago: r.pagos?.metodo_de_pago || null
        }));

        return res.status(200).json(out);
    } catch (e) {
        console.error('[alumnos/aplicaciones] Error:', e);
        return res.status(500).json({ error: 'No se pudieron obtener aplicaciones' });
    }
}

// GET /api/alumnos/contactos?id=  (ó alumno_id=)
async function h_contactos(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const alumnoId = String(req.query.id || req.query.alumno_id || '').trim();
    if (!alumnoId) return res.status(400).json({ error: 'Falta id' });

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

// Helpers de contactos (usados en create/update_full)
async function findContacto({ email, whatsapp }) {
    if (email) {
        const { data, error } = await supaAdmin
            .from('contactos').select('tutor_id').eq('email', String(email).toLowerCase()).maybeSingle();
        if (!error && data) return data.tutor_id || null;
    }
    if (whatsapp) {
        const { data, error } = await supaAdmin
            .from('contactos').select('tutor_id').eq('whatsapp', whatsapp).maybeSingle();
        if (!error && data) return data.tutor_id || null;
    }
    return null;
}
async function getOrCreateContacto(c) {
    const email = nz(c.email) ? c.email.toLowerCase() : null;
    const whatsapp = nz(c.whatsapp);

    const existing = await findContacto({ email, whatsapp });
    if (existing) return existing;

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
    if (error && error.code === '23505') {
        const again = await findContacto({ email, whatsapp });
        if (again) return again;
    }
    throw new Error(error?.message || 'No se pudo crear contacto');
}

// POST /api/alumnos/create
async function h_create(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const { alumno, contactos = [], colegiatura = null } = await readJson(req);
        if (!alumno?.nombre_completo || !alumno?.sexo || !alumno?.nivel || !alumno?.grado) {
            return res.status(400).json({ error: 'Completa nombre, sexo, nivel y grado' });
        }

        // Alumno
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

        // Contactos
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
                prioridad: c.idx + 1,
                via_whatsapp: c.via_whatsapp,
                via_email: c.via_email,
                consentimiento_mensajes: c.consentimiento_mensajes,
                recibe_factura: c.recibe_factura
            };
            const { error: eL } = await supaAdmin.from('alumno_contacto').insert([vinculo]);
            if (eL) return res.status(400).json({ error: eL.message });
        }

        // Colegiatura (opcional)
        if (colegiatura) {
            const hasImp = colegiatura.importe_base !== undefined && colegiatura.importe_base !== null;
            let impNorm = null;
            if (hasImp) {
                const raw = String(colegiatura.importe_base).replace(/,/g, '').trim();
                const n = Number(raw);
                impNorm = Number.isFinite(n) ? n : 0;
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
                const { error: eP } = await supaAdmin.from('precios_alumno').insert([payloadPrecio]);
                if (eP) return res.status(400).json({ error: 'Error insertando colegiatura: ' + eP.message });
            }
        }

        return res.status(201).json({ ok: true, id: alumno_id });
    } catch (e) {
        console.error('[alumnos/create] Error:', e);
        return res.status(500).json({ error: e.message || 'Error interno' });
    }
}

// GET /api/alumnos/get_full?id=
async function h_get_full(req, res) {
    if (req.method !== 'GET')
        return res.status(405).json({ error: 'Método no permitido' });

    const id = (req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Falta id' });

    const s = await requireViewAlumno(req, res, id);
    if (!s) return;

    try {
        // Alumno
        const { data: alumno, error: eA } = await supaAdmin
            .from('alumnos')
            .select('id, nombre_completo, sexo, nivel, grado, estatus, oficial_sep, fecha_nacimiento')
            .eq('id', id)
            .single();
        if (eA || !alumno) return res.status(404).json({ error: 'No encontrado' });

        // Vínculos
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

        // Precios
        const { data: precios, error: eP } = await supaAdmin
            .from('precios_alumno')
            .select('concepto, vigencia_desde, importe_base, notas')
            .eq('alumno_id', id)
            .order('vigencia_desde', { ascending: false });
        if (eP) throw eP;

        const hoy = new Date().toISOString().slice(0, 10);
        const norm = (s) => String(s || '').trim().toLowerCase();
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

        return res.status(200).json({ alumno, contactos, colegiatura, inscripcion });
    } catch (e) {
        console.error('[alumnos/get_full] Error:', e);
        return res.status(500).json({ error: 'No se pudo obtener la información' });
    }
}

// GET /api/alumnos/list
async function h_list(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const { data: alumnos, error: eA } = await supaAdmin
            .from('alumnos')
            .select('id, alumno_code, nombre_completo, sexo, nivel, grado, estatus, oficial_sep')
            .order('nivel', { ascending: true })
            .order('grado', { ascending: true })
            .order('nombre_completo', { ascending: true });
        if (eA) throw eA;

        if (!alumnos || !alumnos.length) {
            return res.status(200).json({
                alumnos: [],
                resumen: {
                    hombres: 0, mujeres: 0, hombres_sep: 0, mujeres_sep: 0,
                    ingreso_total_actual: 0, ingreso_promedio: 0,
                    ingreso_base_esperado: 0, diferencia_vs_base: 0,
                    base_pre: 0, base_pri: 0
                },
                resumen_niveles: {
                    Preescolar: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } },
                    Primaria: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } }
                }
            });
        }

        const alumnoIds = alumnos.map(a => a.id);
        const { data: precios, error: eP } = await supaAdmin
            .from('precios_alumno')
            .select('alumno_id, concepto, vigencia_desde, importe_base')
            .in('alumno_id', alumnoIds)
            .order('vigencia_desde', { ascending: false });
        if (eP) throw eP;

        const { data: params, error: ePar } = await supaAdmin
            .from('parametros').select('parametro, valor');
        if (ePar) throw ePar;

        const pmap = {};
        (params || []).forEach(p => { pmap[p.parametro] = p.valor; });
        const basePre = Number(pmap['colegiatura_base_pre'] || 0);
        const basePri = Number(pmap['colegiatura_base_pri'] || 0);

        const hoy = new Date().toISOString().slice(0, 10);
        const porAlumno = {};
        (precios || []).forEach(r => {
            if ((r.concepto || '').toLowerCase() !== 'colegiatura') return;
            const arr = porAlumno[r.alumno_id] || [];
            arr.push(r);
            porAlumno[r.alumno_id] = arr;
        });

        const byAlumno = new Map();
        for (const a of alumnos) {
            const lista = porAlumno[a.id] || [];
            let vigente = null;
            if (lista.length) vigente = lista.find(x => x.vigencia_desde <= hoy) || lista[0];
            let importe = vigente ? Number(vigente.importe_base || 0) : null;
            if (importe === null) {
                const nivel = String(a.nivel || '').toLowerCase();
                importe = (nivel === 'preescolar') ? basePre : (nivel === 'primaria') ? basePri : 0;
            }
            byAlumno.set(a.id, Number(importe || 0));
        }

        const nivelOrder = v => (String(v || '').toLowerCase() === 'preescolar' ? 0 : String(v || '').toLowerCase() === 'primaria' ? 1 : 2);
        const gradoOrder = g => Number(g || 0);

        const filas = alumnos
            .slice()
            .sort((a, b) => {
                const n = nivelOrder(a.nivel) - nivelOrder(b.nivel);
                if (n !== 0) return n;
                const g = gradoOrder(a.grado) - gradoOrder(b.grado);
                if (g !== 0) return g;
                return a.nombre_completo.localeCompare(b.nombre_completo, 'es');
            })
            .map(a => ({
                alumno_id: a.id,
                alumno_code: a.alumno_code || null,
                nombre_completo: a.nombre_completo,
                sexo: a.sexo,
                nivel: a.nivel,
                grado: Number(a.grado || 0),
                estatus: a.estatus,
                oficial_sep: !!a.oficial_sep,
                importe_actual: byAlumno.get(a.id) ?? 0
            }));

        const hombres = filas.filter(f => (f.sexo || '').toUpperCase() === 'H').length;
        const mujeres = filas.filter(f => (f.sexo || '').toUpperCase() === 'M').length;
        const hombres_sep = filas.filter(f => f.oficial_sep && (f.sexo || '').toUpperCase() === 'H').length;
        const mujeres_sep = filas.filter(f => f.oficial_sep && (f.sexo || '').toUpperCase() === 'M').length;

        const ingreso_total_actual = +filas.reduce((s, f) => s + Number(f.importe_actual || 0), 0).toFixed(2);
        const ingreso_promedio = filas.length ? +(ingreso_total_actual / filas.length).toFixed(2) : 0;

        const nPre = filas.filter(f => String(f.nivel || '').toLowerCase() === 'preescolar').length;
        const nPri = filas.filter(f => String(f.nivel || '').toLowerCase() === 'primaria').length;
        const ingreso_base_esperado = +(nPre * basePre + nPri * basePri).toFixed(2);
        const diferencia_vs_base = +(ingreso_total_actual - ingreso_base_esperado).toFixed(2);

        const RN = {
            Preescolar: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } },
            Primaria: { grados: {}, total: { H: 0, M: 0 }, totalOficial: { H: 0, M: 0 } }
        };
        const ensureRow = (obj, g) => {
            if (!obj.grados[g]) obj.grados[g] = { H: 0, M: 0, total: 0, H_oficial: 0, M_oficial: 0, total_oficial: 0 };
            return obj.grados[g];
        };
        const normNivel = (v) => (String(v || '').toLowerCase() === 'preescolar' ? 'Preescolar' : 'Primaria');
        const normSexo = (v) => (String(v || 'H').toUpperCase() === 'M' ? 'M' : 'H');

        for (const f of filas) {
            const n = normNivel(f.nivel);
            const g = String(f.grado || '');
            const s = normSexo(f.sexo);
            const row = ensureRow(RN[n], g);
            row[s] += 1; row.total += 1; RN[n].total[s] += 1;
            if (f.oficial_sep) {
                if (s === 'H') row.H_oficial += 1; else row.M_oficial += 1;
                row.total_oficial += 1; RN[n].totalOficial[s] += 1;
            }
        }
        for (const g of ['1', '2', '3']) if (!RN.Preescolar.grados[g]) RN.Preescolar.grados[g] = { H: 0, M: 0, total: 0, H_oficial: 0, M_oficial: 0, total_oficial: 0 };
        for (const g of ['1', '2', '3', '4', '5', '6']) if (!RN.Primaria.grados[g]) RN.Primaria.grados[g] = { H: 0, M: 0, total: 0, H_oficial: 0, M_oficial: 0, total_oficial: 0 };

        return res.status(200).json({
            alumnos: filas,
            resumen: {
                hombres, mujeres,
                hombres_sep, mujeres_sep,
                ingreso_total_actual,
                ingreso_promedio,
                ingreso_base_esperado,
                diferencia_vs_base,
                base_pre: basePre,
                base_pri: basePri
            },
            resumen_niveles: RN
        });
    } catch (e) {
        console.error('[alumnos/list] Error:', e);
        return res.status(500).json({ error: 'No se pudo obtener el listado' });
    }
}

// GET /api/alumnos/search?q=
async function h_search(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const q = (req.query.q || '').trim();
        if (q.length < 2) return res.status(200).json([]);

        const norm = normalizeNoAccents(q);
        const { data, error } = await supaAdmin
            .from('alumnos_busqueda')
            .select('id, nombre_completo, nivel, grado')
            .ilike('nombre_idx', `%${norm}%`)
            .order('nombre_completo', { ascending: true })
            .limit(12);
        if (error) throw error;

        return res.status(200).json(data || []);
    } catch (e) {
        console.error('[alumnos/search] Error:', e);
        return res.status(500).json({ error: 'Error buscando alumnos' });
    }
}

// POST /api/alumnos/update_full
async function h_update_full(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    try {
        const { id, alumno, contactos = [], colegiatura = null, inscripcion = null } = await readJson(req);
        if (!id) return res.status(400).json({ error: 'Falta id' });

        if (!alumno?.nombre_completo || !alumno?.sexo || !alumno?.nivel || !alumno?.grado) {
            return res.status(400).json({ error: 'Completa nombre, sexo, nivel y grado' });
        }

        // 1) Alumno
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

        // 2) Contactos (upsert + vínculo)
        const clean = (contactos || [])
            .slice(0, 5)
            .map((c, i) => ({
                idx: i,
                tutor_id: nz(c.tutor_id),
                nombre: (c.nombre || '').trim(),
                parentesco: nz(c.parentesco),
                whatsapp: nz(c.whatsapp),
                email: nz(c.email) ? c.email.toLowerCase() : null,
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

        const { data: actuales, error: eAct } = await supaAdmin
            .from('alumno_contacto').select('tutor_id').eq('alumno_id', id);
        if (eAct) return res.status(400).json({ error: eAct.message });
        const actualesSet = new Set((actuales || []).map(v => v.tutor_id));
        const nuevosSet = new Set();

        for (const c of clean) {
            let tutorIdFinal = c.tutor_id || null;

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
                    if (exist) tutorIdFinal = exist;
                    else return res.status(400).json({ error: 'Conflicto de contacto (único) y no se encontró destinatario.' });
                } else if (eUpC) {
                    return res.status(400).json({ error: eUpC.message });
                }
            } else {
                const exist = await findContacto({ email: c.email, whatsapp: c.whatsapp });
                if (exist) tutorIdFinal = exist;
                else {
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

        // 3) COLEGIATURA
        if (colegiatura) {
            const impNum = toNum(colegiatura.importe_base);
            const vig = nz(colegiatura.vigencia_desde);
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

        // 4) INSCRIPCION
        if (inscripcion) {
            const impNum = toNum(inscripcion.importe_base);
            const vig = nz(inscripcion.vigencia_desde);
            const notas = nz(inscripcion.notas);
            const hasAnything = (impNum !== null) || !!vig || (notas !== null);
            if (hasAnything) {
                const payloadIns = {
                    alumno_id: id,
                    concepto: 'INSCRIPCION',
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

// ========== ROUTER ==========

export default async function handler(req, res) {
    try {
        const action = getAction(req);
        switch (action) {
            case 'aplicaciones': return h_aplicaciones(req, res);
            case 'contactos': return h_contactos(req, res);
            case 'create': return h_create(req, res);
            case 'get_full': return h_get_full(req, res);
            case 'list': return h_list(req, res);
            case 'search': return h_search(req, res);
            case 'update_full': return h_update_full(req, res);
            default:
                return res.status(404).json({ error: 'Acción no soportada' });
        }
    } catch (e) {
        console.error('[alumnos/*] Error:', e);
        return res.status(500).json({ error: 'Error interno' });
    }
}
