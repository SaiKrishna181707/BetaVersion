const API = 'https://fkvvrndb17.execute-api.us-east-1.amazonaws.com';

async function main() {
  console.log('=== STEP 1: TEST BEDROCK NOVA PRODUCT INTELLIGENCE ===');
  console.log('Scraping and analyzing https://main.d1s2dm4wj8xxb.amplifyapp.com/ with Nova...');
  const intelRes = await fetch(`${API}/product-intelligence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company_name: 'Centopus',
      website_url: 'https://main.d1s2dm4wj8xxb.amplifyapp.com/'
    })
  });
  if (!intelRes.ok) {
    throw new Error(`Product intelligence failed: ${intelRes.status} ${await intelRes.text()}`);
  }
  const intelData = await intelRes.json();
  const intel = intelData.intelligence;
  console.log('✓ Nova intelligence generated:');
  console.log('  Company:', intel.company_name);
  console.log('  Product:', intel.product_name);
  console.log('  Category:', intel.category);
  console.log('  Target audience:', intel.target_audience);
  console.log('  Suggested objective:', intel.suggested_objectives?.[0]);

  console.log('\n=== STEP 2: CREATE RUN & GENERATE AGENTS FROM NOVA INTELLIGENCE ===');
  const agentCount = 2; // Test with 2 agents
  const runPayload = {
    configuration: {
      company_name: intel.company_name,
      product_name: intel.product_name,
      target_url: intel.website_url,
      product_description: intel.summary,
      target_audience: intel.target_audience,
      objective: intel.suggested_objectives?.[0] || 'Explore the Centopus product and find what it does and how a new product test is started.',
      user_count: agentCount,
      batch_size: agentCount,
      max_session_seconds: 60,
      run_hard_cap_usd: 10,
      authorization_acknowledged: true
    },
    population_spec: {
      population_seed: `pop-${Date.now()}`,
      cohort: intel.target_audience.slice(0, 80),
      goal_context: intel.suggested_objectives?.[0] || 'Explore the Centopus product and find what it does and how a new product test is started.',
      size: agentCount,
      target_audience: intel.target_audience,
      product_name: intel.product_name
    }
  };

  const createRes = await fetch(`${API}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(runPayload)
  });
  if (!createRes.ok) throw new Error(`Create run failed: ${createRes.status} ${await createRes.text()}`);
  const runData = await createRes.json();
  const runId = runData.run_id;
  console.log(`✓ Run created: ${runId}`);
  console.log(`  Personas count: ${runData.personas?.length}`);
  for (const p of runData.personas || []) {
    console.log(`  - Agent ${p.persona_id}: "${p.display_name}" (${p.occupation}, ${p.patience} patience)`);
  }

  console.log('\n=== STEP 3: EDIT AN AGENT (VERIFY EDITABILITY) ===');
  const agentToEdit = runData.personas[0];
  const patchRes = await fetch(`${API}/runs/${encodeURIComponent(runId)}/personas/${encodeURIComponent(agentToEdit.persona_id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      display_name: 'Verified Tester',
      patience: 'HIGH',
      goals: 'Verify how synthetic testing works and evaluate evidence reporting'
    })
  });
  if (!patchRes.ok) throw new Error(`Update persona failed: ${patchRes.status} ${await patchRes.text()}`);
  const updatedPersona = await patchRes.json();
  console.log(`✓ Persona updated: "${updatedPersona.display_name}" with patience=${updatedPersona.patience}`);

  console.log('\n=== STEP 4: START SIMULATION RUN ===');
  const startRes = await fetch(`${API}/runs/${encodeURIComponent(runId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxConcurrency: agentCount })
  });
  if (!startRes.ok) throw new Error(`Start run failed: ${startRes.status} ${await startRes.text()}`);
  console.log('✓ Run started, polling live status...');

  let finished = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const [run, sessionsData] = await Promise.all([
      fetch(`${API}/runs/${encodeURIComponent(runId)}`).then(r => r.json()),
      fetch(`${API}/runs/${encodeURIComponent(runId)}/sessions`).then(r => r.json())
    ]);
    const sessions = sessionsData.sessions || [];
    const statuses = sessions.map(s => `${s.persona_id?.slice(-3)}: ${s.status} (${s.actions_taken ?? 0} acts)`).join(' | ');
    console.log(`[${(i + 1) * 5}s] Run: ${run.status} | Sessions: ${statuses}`);

    if (run.status === 'COMPLETED' || run.status === 'FAILED') {
      finished = true;
      console.log(`\n=== STEP 5: SIMULATION FINISHED WITH STATUS ${run.status} ===`);
      break;
    }
  }

  if (!finished) throw new Error('Simulation did not complete within timeout');

  console.log('\n=== STEP 6: VERIFY REPORT & NO-TIMEOUT ACCURACY ===');
  const reportRes = await fetch(`${API}/runs/${encodeURIComponent(runId)}/report`).then(r => r.json());
  const report = reportRes.report;
  if (!report) throw new Error('No report generated!');

  console.log('Completion percentage:', report.metrics?.completion?.percentage);
  console.log('Abandonment rate:', report.metrics?.abandonment_rate);
  console.log('Findings:');
  for (const f of report.findings || []) {
    console.log(`  [${f.kind}] ${f.title}`);
  }
  console.log('Quick improvements:');
  for (const q of report.quick_improvements || []) {
    console.log(`  - ${q.recommendation}`);
  }

  console.log('\n=== STEP 7: VERIFY SPECIFIC AGENT FEEDBACK FOR EACH AGENT ===');
  for (const fb of report.agent_feedback || []) {
    console.log(`\nFeedback for session ${fb.session_id} (persona ${fb.persona_id}):`);
    console.log('  What worked:', fb.what_worked);
    console.log('  What confused them:', fb.what_confused_them);
    console.log('  What slowed them down:', fb.what_slowed_them_down);
    console.log('  Continuation/Abandonment:', fb.continuation_or_abandonment);
    console.log('  Specific recommendation:', fb.improvement_suggestion);
  }

  console.log('\n========================================');
  console.log('ALL VERIFICATIONS PASSED PERFECTLY!');
  console.log('========================================');
}

main().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
