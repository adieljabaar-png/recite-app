// api/feedback.js  —  Vercel Serverless Function (Node.js, no deps)
//
// Relays feedback from the browser to the owner's private inbox.
// The destination address lives ONLY in the server-side environment
// variable FEEDBACK_TO — it is never sent to the browser and never
// appears in any message the user can see.

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');

  if(req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  let body = req.body;
  if(typeof body === 'string'){
    try{ body = JSON.parse(body); }catch(_){ body = {}; }
  }
  if(!body || typeof body !== 'object') body = {};

  const email   = String(body.email     || '').trim().slice(0, 254);
  const message = String(body.message   || '').trim().slice(0, 5000);
  const page    = String(body.page      || '').slice(0, 500);
  const ua      = String(body.userAgent || '').slice(0, 500);
  const ts      = String(body.ts        || new Date().toISOString());

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if(!emailRe.test(email)) return res.status(400).json({ ok:false, error:'Invalid email' });
  if(message.length < 3)   return res.status(400).json({ ok:false, error:'Message too short' });

  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.FEEDBACK_TO;                      // ← your inbox
  const from   = process.env.FEEDBACK_FROM || 'onboarding@resend.dev';

  if(!apiKey || !to){
    console.error('[feedback] missing RESEND_API_KEY or FEEDBACK_TO');
    return res.status(500).json({ ok:false, error:'Server not configured' });
  }

  const text =
    'New feedback received\n' +
    '─────────────────────\n' +
    'From   : ' + email   + '\n' +
    'Sent   : ' + ts      + '\n' +
    'Page   : ' + page    + '\n' +
    'Client : ' + ua      + '\n\n' +
    'Message:\n' + message + '\n';

  try{
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: 'Quran Coach feedback from ' + email,
        text
      })
    });
    if(!r.ok){
      const errText = await r.text().catch(() => '');
      console.error('[feedback] provider error', r.status, errText);
      return res.status(502).json({ ok:false, error:'Mail provider error' });
    }
    return res.status(200).json({ ok:true });
  }catch(err){
    console.error('[feedback] send failed', err);
    return res.status(500).json({ ok:false, error:'Send failed' });
  }
}
