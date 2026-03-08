// api/gc-log.js
// Logs GC white label sessions and tool runs to the shared CivicScope Supabase project
// Uses same env vars as Free/Pro: SUPABASE_URL + SUPABASE_SERVICE_KEY
// Product field is set to "gc-[slug]" (e.g. "gc-acme") to distinguish GC runs

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, data } = req.body;

  try {
    if (action === 'create_session') {
      const { data: session, error } = await supabase
        .from('sessions')
        .insert({})
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ sessionId: session.id });
    }

    if (action === 'log_run') {
      const {
        session_id,
        slug,
        municipality,
        project_type,
        scope_description,
        cost_low,
        cost_high,
        cost_midpoint,
        confidence,
        narrative,
        assumptions
      } = data;

      const { data: run, error } = await supabase
        .from('tool_runs')
        .insert({
          session_id:        session_id || null,
          municipality:      municipality || null,
          project_type:      project_type || null,
          scope_description: scope_description || null,
          cost_low:          cost_low || null,
          cost_high:         cost_high || null,
          cost_midpoint:     cost_midpoint || null,
          confidence:        confidence || null,
          narrative:         narrative || null,
          assumptions:       assumptions || [],
          product:           `gc-${slug}`
        })
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json({ runId: run.id });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('gc-log error:', err);
    return res.status(500).json({ error: err.message });
  }
}
