// api/logout.js
import { clearSession } from '../lib/session.js';

export default async function handler(_req, res) {
    clearSession(res);
    res.json({ ok: true });
}
