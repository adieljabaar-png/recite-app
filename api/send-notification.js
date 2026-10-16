import webpush from 'web-push';
import { kv } from '@vercel/kv';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ ok:false });

  if(req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET){
    return res.status(401).json({ ok:false, error:'unauthorised' });
  }

  const { title, body, url } = req.body || {};
  if(!title || !body){
    return res.status(400).json({ ok:false, error:'title and body required' });
  }

  const all = (await kv.hgetall('qc:subscriptions')) || {};
  const payload = JSON.stringify({ title, body, url: url || './' });

  const endpoints = Object.keys(all);
  const results = await Promise.allSettled(
    endpoints.map(ep => webpush.sendNotification(all[ep], payload))
  );

  let sent = 0, pruned = 0;
  for(let i = 0; i < results.length; i++){
    const r = results[i];
    if(r.status === 'fulfilled'){ sent++; continue; }
    const code = r.reason && r.reason.statusCode;
    if(code === 404 || code === 410){
      await kv.hdel('qc:subscriptions', endpoints[i]);
      pruned++;
    }
  }

  return res.json({ ok:true, sent, pruned, total: endpoints.length });
}