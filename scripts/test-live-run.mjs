const API = 'https://fkvvrndb17.execute-api.us-east-1.amazonaws.com';

async function test() {
  console.log('1. Health check...');
  const health = await fetch(`${API}/health`).then(r => r.json());
  console.log('Health:', health);

  console.log('2. Creating a test run with 1 agent...');
  const createRes = await fetch(`${API}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      configuration: {
        target_url: 'https://www.apple.com/',
        product_description: 'Apple official website',
        target_audience: 'General consumers',
        objective: 'Explore Apple homepage products',
        user_count: 1,
        batch_size: 1,
        max_session_seconds: 60,
        run_hard_cap_usd: 10,
        authorization_acknowledged: true
      }
    })
  });
  const runData = await createRes.json();
  console.log('Created run:', runData);
  if (!runData.run_id) throw new Error('No run_id: ' + JSON.stringify(runData));

  console.log('3. Starting run:', runData.run_id);
  const startRes = await fetch(`${API}/runs/${encodeURIComponent(runData.run_id)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxConcurrency: 1 })
  });
  const startData = await startRes.json();
  console.log('Start result:', startData);

  console.log('4. Polling run status...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const [run, sessions] = await Promise.all([
      fetch(`${API}/runs/${encodeURIComponent(runData.run_id)}`).then(r => r.json()),
      fetch(`${API}/runs/${encodeURIComponent(runData.run_id)}/sessions`).then(r => r.json())
    ]);
    const session = sessions.sessions?.[0];
    console.log(`[${i * 5}s] Run Status: ${run.status}, Session Status: ${session?.status}, Actions: ${session?.actions_taken ?? 0}`);
    if (run.status === 'COMPLETED' || run.status === 'FAILED') {
      console.log('Run finished with status:', run.status);
      break;
    }
  }
}

test().catch(console.error);
