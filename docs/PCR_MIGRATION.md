# PCR Migration: console-paste flow

Imports historical PCRs from the PCR Apps Script into D1 `qpcr_log`.
Idempotent (re-run safely — uses INSERT OR IGNORE).

## Prerequisites
- Logged in to https://hajj.shuki.tech as **admin** or **leadership**
- DevTools console open on any page in `hajj.shuki.tech`

## One-liner

Paste in DevTools console:

```js
(async () => {
  const PCR_GAS = 'https://script.google.com/macros/s/AKfycbyQHzv0JAhNb4orNpkcXNpiM0dvT6wae8J8LoQLzVrvPeG3vStwhCN7-J27OFo4Rqj0RQ/exec';
  const D1_TOK = sessionStorage.getItem('hajj_token');
  const GAS_TOK = sessionStorage.getItem('hajj_gas_token') || prompt('GAS token (from old GAS login):');
  if (!D1_TOK) return console.error('Not logged in to D1');
  if (!GAS_TOK) return console.error('No GAS token');

  console.log('▸ Pulling PCRs from GAS...');
  const r = await fetch(`${PCR_GAS}?action=pcr_list&token=${encodeURIComponent(GAS_TOK)}`);
  const data = await r.json();
  if (!data.ok && !Array.isArray(data)) return console.error('GAS error:', data);
  const pcrs = data.pcrs || data.results || data;
  console.log(`▸ Got ${pcrs.length} PCRs from GAS`);

  console.log('▸ Posting to D1 /api/v2/migrate_pcr...');
  const m = await fetch('/api/v2/migrate_pcr', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + D1_TOK
    },
    body: JSON.stringify({ pcrs })
  });
  const result = await m.json();
  console.log('▸ Result:', result);
  if (result.ok) {
    console.log(`✅ Inserted ${result.result.inserted}, skipped ${result.result.skipped}, errors ${result.result.errors.length}`);
    if (result.result.errors.length) console.warn('Errors:', result.result.errors.slice(0, 5));
  }
})();
```

## After running

Verify in active.html — the **Q-PCRs filed** tile and **TOP CHIEF COMPLAINTS** panel should now reflect imported data.

## Re-run safety

Each PCR has a unique `pcr_id`. Subsequent imports skip duplicates (INSERT OR IGNORE), so you can run the script repeatedly.
