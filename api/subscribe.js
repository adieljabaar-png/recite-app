import { kv } from '@vercel/kv';

export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).json({ ok:false });

  const sub = req.body;
  if(!sub || !sub.endpoint || !sub.keys){
    return res.status(400).json({ ok:false, error:'bad subscription' });
  }

  await kv.hset('qc:subscriptions', { [sub.endpoint]: sub });
  return res.json({ ok:true });
}