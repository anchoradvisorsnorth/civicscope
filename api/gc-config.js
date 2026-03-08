// api/gc-config.js
// Fetches tenant config from the shared CivicScope Supabase project by slug
// Called on page load: GET /api/gc-config?slug=acme

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'Missing slug' });

  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('slug', slug)
    .eq('active', true)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  // Never expose contact_email or from_email to the browser
  const { contact_email, from_email, ...safeConfig } = data;

  return res.status(200).json(safeConfig);
}
