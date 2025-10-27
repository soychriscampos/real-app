// api/ping.js
export default function handler(_req, res) {
    res.json({
        ok: true,
        hasUrl: !!process.env.SUPABASE_URL,
        hasServiceRole: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        nodeEnv: process.env.NODE_ENV || null
    });
}
