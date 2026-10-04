#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const localRequire = createRequire(import.meta.url);
let playwrightModule = process.env.SHIELDED_PLAYWRIGHT_MODULE || process.env.CODEX_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  try { playwrightModule = localRequire.resolve('playwright'); } catch {}
}
if (!playwrightModule) throw new Error('Set SHIELDED_PLAYWRIGHT_MODULE to the installed Playwright module path');
const playwright = /\.(?:c?js)$/i.test(playwrightModule)
  ? localRequire(path.resolve(playwrightModule))
  : await import(pathToFileURL(path.resolve(playwrightModule)).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error('The installed Playwright module does not export Chromium');

const root = process.cwd();
const baseUrl = (process.env.SHIELDED_UI_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const parsedBaseUrl = new URL(baseUrl);
assert(parsedBaseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsedBaseUrl.hostname) && parsedBaseUrl.port === '8788' && parsedBaseUrl.pathname === '/' && !parsedBaseUrl.username && !parsedBaseUrl.password && !parsedBaseUrl.search && !parsedBaseUrl.hash, 'UI smoke is restricted to the local loopback service on port 8788');
const tokenPath = path.resolve(process.env.SHIELDED_API_TOKEN_FILE || path.join(root, '.recovery/compact-live/api-token'));
const recoveryDir = path.resolve(root, '.recovery/compact-live');
const reportPath = path.resolve(root, 'validation/compact-ui.json');
const screenshotDir = path.join(recoveryDir, 'ui-smoke');
const timeoutMs = 15_000;
let secretToken = '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeError(error, token) {
  return String(error instanceof Error ? error.message : error)
    .replace(token ? new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '[redacted]')
    .replace(/(?:tark1|ark1|tb1|bc1)[a-z0-9]{20,}/gi, '[address redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240);
}

async function browserGet(page, pathname) {
  assert(['/api/state', '/api/session'].includes(pathname), 'Browser API helper accepts only read-only session endpoints');
  return page.evaluate(async (path) => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  }, pathname);
}

async function safeAuthDiagnostics(page, baseUrl, apiStateStatus) {
  const [browserSession, browserState, apiSessionResponse] = await Promise.all([
    browserGet(page, '/api/session'),
    browserGet(page, '/api/state'),
    page.request.get(`${baseUrl}/api/session`),
  ]);
  const apiSession = apiSessionResponse.ok() ? await apiSessionResponse.json().catch(() => ({})) : {};
  return `APIRequestContextState=${apiStateStatus}; APIRequestContextAuthenticated=${apiSession.authenticated === true}; browserState=${browserState.status}; browserSessionAuthenticated=${browserSession.body?.authenticated === true}`;
}

const expectedUnauthorizedConsoleText = 'Failed to load resource: the server responded with a status of 401 (Unauthorized)';
function isExpectedUnauthorizedConsoleError(messageText, locationUrl) {
  if (messageText !== expectedUnauthorizedConsoleText) return false;
  try {
    const location = new URL(locationUrl);
    return location.origin === parsedBaseUrl.origin && ['/api/state', '/api/session'].includes(location.pathname) && !location.search && !location.hash;
  } catch {
    return false;
  }
}
assert(isExpectedUnauthorizedConsoleError(expectedUnauthorizedConsoleText, `${parsedBaseUrl.origin}/api/state`), 'Expected API 401 console filter did not match');
assert(isExpectedUnauthorizedConsoleError(expectedUnauthorizedConsoleText, `${parsedBaseUrl.origin}/api/session`), 'Expected session 401 console filter did not match');
assert(!isExpectedUnauthorizedConsoleError(expectedUnauthorizedConsoleText, 'http://127.0.0.2:8788/api/state'), '401 console filter accepted the wrong origin');
assert(!isExpectedUnauthorizedConsoleError(expectedUnauthorizedConsoleText, `${parsedBaseUrl.origin}/api/other`), '401 console filter accepted the wrong path');
assert(!isExpectedUnauthorizedConsoleError('Failed to load resource: the server responded with a status of 403 (Forbidden)', `${parsedBaseUrl.origin}/api/state`), 'Console filter accepted a non-401 response');
assert(!isExpectedUnauthorizedConsoleError('Uncaught Error: UI failure', `${parsedBaseUrl.origin}/api/state`), 'Console filter accepted an unrelated console error');
function financialFingerprint(state) {
  const wallets = (state.wallets || []).map((wallet) => ({
    id: wallet.id,
    balance: wallet.publicBalance || null,
    notes: (wallet.notes || []).map((note) => ({
      id: note.id,
      asset: note.asset,
      amount: note.amount,
      status: note.status,
      commitment: note.commitment,
      nullifier: note.nullifier,
      index: note.index,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const value = {
    status: {
      network: state.status?.network,
      ready: state.status?.ready,
      profileId: state.status?.profileId,
      proofTransport: state.status?.proofTransport,
      allowedActions: state.status?.allowedActions,
    },
    epoch: state.epoch,
    reserves: state.reserves,
    wallets,
    activity: state.activity,
    lanes: state.lanes,
    anchors: state.anchors,
    profile: state.profile,
    native: {
      network: state.native?.network,
      profileId: state.native?.profileId,
      heads: state.native?.heads,
      state: state.native?.state,
      gateFunding: state.native?.gateFunding ?? state.native?.funding,
      funding: state.native?.funding,
    },
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function baselineFinancialDigest(state) {
  const activity = (state.activity || []).map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => [
    'boundary', 'checkpointWeights', 'commitments', 'id', 'nativeWeight', 'nullifiers', 'proofBytes', 'proofTransport',
    'statement', 'status', 'summary', 'txid', 'type',
  ].includes(key))));
  const wallets = (state.wallets || []).map((wallet) => ({ id: wallet.id, publicBalance: wallet.publicBalance,
    notes: (wallet.notes || []).map((note) => ({ id: note.id, asset: note.asset, amount: note.amount, status: note.status,
      commitment: note.commitment, index: note.index, owner: note.owner, ciphertext: note.ciphertext })) }));
  const value = canonical({ profileId: state.status?.profileId, heads: state.native?.heads, epoch: state.epoch,
    lanes: state.lanes, anchors: state.anchors, allocatedFunding: state.native?.funding?.allocated,
    treasuryFunding: state.native?.funding?.treasury,
    encryptedLog: state.encryptedLog?.map((entry) => ({ commitment: entry.commitment, ciphertext: entry.ciphertext })),
    nativeAssets: state.native?.assets, genesis: state.native?.genesis, activity, reserves: state.reserves, wallets });
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function loadReplayPlan() {
  if (process.env.SHIELDED_UI_REPLAY !== '1') return undefined;
  const prefix = process.env.SHIELDED_SMOKE_KEY_PREFIX || 'compact-mutinynet-v1';
  assert(/^[A-Za-z0-9._:-]{1,90}$/.test(prefix), 'The configured smoke idempotency prefix is invalid');
  const baselinePath = path.resolve(root, 'validation/compact-mutinynet.json');
  const baselineStat = await lstat(baselinePath);
  assert(baselineStat.isFile() && !baselineStat.isSymbolicLink(), 'The funded baseline report must be a regular file');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  assert(baseline.network === 'mutinynet' && baseline.proofTransport === 'compact' && baseline.fundedMutinynet === true &&
    baseline.idempotencyVerified === true && baseline.negativeScenariosVerified === true, 'The funded Mutinynet baseline is incomplete');
  assert(baseline.idempotencyKeyPrefix === prefix, 'The configured idempotency prefix does not match the completed funded baseline');
  assert(typeof baseline.verifiedAt === 'string' && Number.isFinite(Date.parse(baseline.verifiedAt)), 'The funded baseline timestamp is invalid');
  assert(/^[0-9a-f]{64}$/.test(baseline.profileId || ''), 'The funded baseline profile ID is invalid');
  assert(/^[0-9a-f]{64}$/.test(baseline.finalFinancialStateSha256 || ''), 'The funded baseline state digest is invalid');
  assert(Number.isSafeInteger(baseline.finalActivityCount) && Array.isArray(baseline.finalActivityTxids), 'The funded baseline activity summary is incomplete');
  assert(Array.isArray(baseline.measurements) && baseline.measurements.length === 20, 'The funded baseline must contain all 20 accepted lifecycle receipts');
  const expected = [
    ['shield', 'btc-shield', { from: 'alice', asset: 'BTC', amount: 100000 }],
    ['seal', 'btc-seal-1', {}],
    ['transfer', 'btc-transfer', { from: 'alice', to: 'bob', asset: 'BTC', amount: 25000 }],
    ['seal', 'btc-seal-2', {}],
    ['withdraw', 'btc-withdraw', { from: 'bob', asset: 'BTC', amount: 10000 }],
    ['shield', 'token-shield', { from: 'alice', asset: 'DEMO', amount: 10000 }],
    ['seal', 'token-seal-1', {}],
    ['transfer', 'token-transfer', { from: 'alice', to: 'bob', asset: 'DEMO', amount: 2500 }],
    ['seal', 'token-seal-2', {}],
    ['withdraw', 'token-withdraw', { from: 'bob', asset: 'DEMO', amount: 1000 }],
    ['shield', 'bob-btc-shield', { from: 'bob', asset: 'BTC', amount: 1000 }],
    ['seal', 'bob-btc-seal-1', {}],
    ['transfer', 'bob-btc-transfer', { from: 'bob', to: 'alice', asset: 'BTC', amount: 1000 }],
    ['seal', 'bob-btc-seal-2', {}],
    ['withdraw', 'alice-btc-withdraw', { from: 'alice', asset: 'BTC', amount: 1000 }],
    ['shield', 'bob-token-shield', { from: 'bob', asset: 'DEMO', amount: 100 }],
    ['seal', 'bob-token-seal-1', {}],
    ['transfer', 'bob-token-transfer', { from: 'bob', to: 'alice', asset: 'DEMO', amount: 100 }],
    ['seal', 'bob-token-seal-2', {}],
    ['withdraw', 'alice-token-withdraw', { from: 'alice', asset: 'DEMO', amount: 100 }],
  ];
  assert(sameJson(baseline.parties, ['Alice', 'Bob']) && sameJson(baseline.assets, ['BTC', 'DEMO']), 'The funded baseline does not cover Alice, Bob, BTC, and DEMO');
  const keys = new Set();
  const measurements = baseline.measurements.map((measurement, index) => {
    assert(measurement.action === expected[index][0] && measurement.suffix === expected[index][1], 'The funded baseline lifecycle order or label is incomplete');
    assert(measurement.indexed === true && sameJson(measurement.body, expected[index][2]), 'A funded baseline request does not match its expected party, asset, and amount');
    assert(measurement.body && typeof measurement.body === 'object' && /^[0-9a-f]{64}$/.test(measurement.resultSha256 || '') &&
      /^[0-9a-f]{64}$/.test(measurement.txid || ''), 'The funded baseline receipt record is incomplete');
    const key = `${prefix}-${measurement.suffix}`;
    assert(key.length <= 128 && !keys.has(key), 'The funded baseline idempotency keys are invalid or duplicated');
    keys.add(key);
    return { ...measurement, idempotencyKey: key };
  });
  return { baseline, baselinePath, prefix, measurements };
}

async function replayFinancialUi(page, baseUrl, replayPlan, initialState, initialFingerprint) {
  const replayed = [];
  let activeReplay;
  let unplannedPost = false;
  const onResponse = (response) => {
    if (!activeReplay || response.request().method() !== 'POST') return;
    const responseUrl = new URL(response.url());
    if (responseUrl.origin === parsedBaseUrl.origin && responseUrl.pathname === `/api/actions/${activeReplay.measurement.action}`) {
      activeReplay.resolveResponse(response);
    }
  };
  const routeHandler = async (route) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (!activeReplay) {
      unplannedPost = true;
      await route.abort('blockedbyclient');
      return;
    }
    const plan = activeReplay;
    if (plan.routeCount !== 0) {
      plan.violation = 'More than one financial POST was issued for a single UI action';
      plan.resolveResponse(undefined);
      await route.abort('blockedbyclient');
      return;
    }
    plan.routeCount++;
    const requestAction = requestUrl.pathname.startsWith('/api/actions/') ? requestUrl.pathname.slice('/api/actions/'.length) : '';
    let body;
    try { body = request.postDataJSON(); } catch {
      plan.violation = 'The UI request body was not valid JSON';
      plan.resolveResponse(undefined);
      await route.abort('blockedbyclient');
      return;
    }
    const generatedKey = request.headers()['idempotency-key'];
    if (request.method() !== 'POST' || requestUrl.origin !== parsedBaseUrl.origin || requestAction !== plan.measurement.action ||
        !sameJson(body, plan.measurement.body) || !/^[0-9a-f]{32}$/.test(generatedKey || '')) {
      plan.violation = 'The UI request did not exactly match the selected accepted baseline action, body, and generated key';
      plan.resolveResponse(undefined);
      await route.abort('blockedbyclient');
      return;
    }
    const headers = { ...request.headers(), 'idempotency-key': plan.measurement.idempotencyKey };
    await route.continue({ headers });
  };

  page.on('response', onResponse);
  await page.route('**/api/actions/**', routeHandler);
  try {
    const tabs = page.getByRole('tablist', { name: 'Payment lifecycle' });
    for (const measurement of replayPlan.measurements) {
      const tabName = measurement.action[0].toUpperCase() + measurement.action.slice(1);
      await tabs.getByRole('tab', { name: new RegExp(`^\\d+ ${tabName}\\b`, 'i') }).click();
      if (measurement.action !== 'seal') {
        const assetButton = measurement.body.asset === 'DEMO' ? 'Demo token' : 'Bitcoin';
        await page.getByRole('button', { name: assetButton }).click();
        if (measurement.action === 'shield') {
          await page.getByLabel('Recipient wallet').selectOption(measurement.body.from);
        } else {
          await page.getByLabel('From wallet').selectOption(measurement.body.from);
          if (measurement.action === 'transfer') await page.getByLabel('To wallet').selectOption(measurement.body.to);
        }
        await page.getByLabel('Amount').fill(String(measurement.body.amount));
      }

      const priorAction = replayed.length > 0 ? replayed[replayed.length - 1].action : undefined;
      const buttonName = measurement.action === 'seal' && priorAction === 'transfer'
        ? 'Seal & continue to withdraw'
        : ({ shield: 'Shield assets', seal: 'Seal current epoch', transfer: 'Prove & transfer', withdraw: 'Prove & withdraw' })[measurement.action];
      const submitButton = page.getByRole('button', { name: buttonName });
      if (await submitButton.count() !== 1) {
        await page.screenshot({ path: path.join(screenshotDir, `failure-${measurement.suffix}.png`), fullPage: true });
        throw new Error(`The ${measurement.suffix} UI action button was not rendered (${replayed.length}/20 completed; expected ${buttonName})`);
      }
      assert(await submitButton.isEnabled(), `The ${measurement.suffix} UI action is disabled`);
      let resolveResponse;
      const responsePromise = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        resolveResponse = (response) => { clearTimeout(timer); resolve(response); };
      });
      activeReplay = { measurement, routeCount: 0, violation: '', resolveResponse };
      await submitButton.click();
      const response = await responsePromise;
      const currentReplay = activeReplay;
      activeReplay = undefined;
      assert(!currentReplay.violation, currentReplay.violation || 'Unexpected UI request');
      assert(!unplannedPost, 'An unplanned financial POST was blocked');
      assert(currentReplay.routeCount === 1, 'The UI action did not issue exactly one guarded financial POST');
      assert(response, `The ${measurement.suffix} UI action did not receive a response`);
      assert(response.status() === 200, `The ${measurement.suffix} UI action returned HTTP ${response.status()}`);
      const payload = await response.json();
      const resultSha256 = createHash('sha256').update(JSON.stringify(payload.result)).digest('hex');
      assert(resultSha256 === measurement.resultSha256, `The ${measurement.suffix} UI action returned a different saved receipt`);
      assert(payload.state?.status?.profileId === replayPlan.baseline.profileId, 'The replay response changed the registered profile');
      assert(financialFingerprint(payload.state) === initialFingerprint, `The ${measurement.suffix} UI replay changed financial state`);
      const notification = page.locator('.notification[role="status"]');
      await notification.waitFor({ state: 'visible' });
      assert((await notification.innerText()).trim().length > 0, `The ${measurement.suffix} UI action did not show success feedback`);
      assert(await page.locator('.notification[role="alert"]').count() === 0, `The ${measurement.suffix} UI action showed an error notice`);
      const currentResponse = await browserGet(page, '/api/state');
      assert(currentResponse.status === 200, `Authenticated browser state API failed during UI replay (HTTP ${currentResponse.status})`);
      const currentState = currentResponse.body;
      assert(financialFingerprint(currentState) === initialFingerprint, `The ${measurement.suffix} UI replay changed persisted financial state`);
      assert(baselineFinancialDigest(currentState) === replayPlan.baseline.finalFinancialStateSha256, 'The UI replay changed the funded baseline state digest');
      replayed.push({ action: measurement.action, suffix: measurement.suffix, resultSha256 });
      process.stdout.write(`Cached UI replay verified ${measurement.suffix} (${replayed.length}/20).\n`);
    }
  } catch (error) {
    const failedMeasurement = replayPlan.measurements[replayed.length];
    const suffix = failedMeasurement?.suffix ?? 'complete';
    await page.screenshot({ path: path.join(screenshotDir, `failure-${suffix}.png`), fullPage: true }).catch(() => {});
    throw new Error(`UI cached replay stopped at ${suffix} (${replayed.length}/20 completed): ${safeError(error, '')}`);
  } finally {
    activeReplay = undefined;
    page.off('response', onResponse);
    await page.unroute('**/api/actions/**', routeHandler);
  }
  assert(replayed.length === 20, 'UI replay did not cover all funded lifecycle actions');
  return replayed;
}

async function verifyNotePrivacy(page, state) {
  const notes = (state.wallets || []).flatMap((wallet) => wallet.notes || []);
  assert(notes.length > 0, 'The completed funded lifecycle has no notes to inspect');
  const rows = page.locator('.notes-table tbody tr');
  assert(await rows.count() === notes.length, 'The note registry row count does not match authenticated state');
  const byCommitment = new Map(notes.map((note) => [note.commitment, note]));
  const inspectRows = async (isPrivate) => {
    for (let index = 0; index < await rows.count(); index++) {
      const row = rows.nth(index);
      const cells = row.locator('td');
      const hashes = row.locator('code[title]');
      const note = byCommitment.get(await hashes.nth(0).getAttribute('title'));
      assert(note, 'The note registry showed an unknown commitment');
      const nullifierCell = cells.nth(5);
      if (typeof note.nullifier === 'string' && note.nullifier.length > 0) {
        assert(await nullifierCell.locator('code[title]').getAttribute('title') === note.nullifier, 'The note registry nullifier does not match state');
      } else {
        assert(await nullifierCell.locator('code[title]').count() === 0 &&
          (await nullifierCell.innerText()).includes('Awaiting execution'), 'The note registry showed an unpublished nullifier');
      }
      if (isPrivate) {
        assert((await cells.nth(1).innerText()).trim() === note.owner, 'Wallet view showed the wrong note owner');
        assert((await cells.nth(2).innerText()).trim() === (note.asset === 'TOKEN' ? 'DEMO' : note.asset), 'Wallet view showed the wrong note asset');
        const amount = Number(note.amount).toLocaleString('en-US', { maximumFractionDigits: 8 });
        assert((await cells.nth(3).innerText()).includes(amount), 'Wallet view showed the wrong note amount');
      } else {
        for (const index of [1, 2, 3]) assert((await cells.nth(index).innerText()).trim() === 'Encrypted', 'Public view exposed private note details');
      }
    }
  };
  await inspectRows(true);
  await page.getByRole('button', { name: 'Public view' }).click();
  await inspectRows(false);
  assert((await page.locator('.table-caption').innerText()).includes('Owner, asset, and value stay hidden'), 'Public note view privacy text is missing');
  await page.getByRole('button', { name: 'Wallet view' }).click();
  await inspectRows(true);
}

async function verifyPublicReceipts(page, state, replayPlan) {
  const measurements = [...replayPlan.measurements].reverse();
  const activityByTxid = new Map((state.activity || []).filter((item) => item.txid).map((item) => [item.txid, item]));
  const records = page.locator('.record-list > button');
  assert(await records.count() === measurements.length, 'The inspector record count does not match the 20 accepted UI receipts');
  for (let index = 0; index < measurements.length; index++) {
    const measurement = measurements[index];
    const activity = activityByTxid.get(measurement.txid);
    assert(activity, `No public activity record exists for ${measurement.suffix}`);
    await records.nth(index).click();
    const detail = page.locator('.inspector-detail');
    await detail.getByRole('heading', { level: 2, name: activity.type }).waitFor({ state: 'visible' });
    const fields = detail.locator('.transaction-fields code[title]');
    assert(await fields.nth(0).getAttribute('title') === measurement.txid, `The inspector showed the wrong transaction for ${measurement.suffix}`);
    assert(await fields.nth(1).getAttribute('title') === activity.statement, `The inspector showed the wrong statement for ${measurement.suffix}`);
    assert((await detail.locator('.verification-cards').innerText()).includes('Verified') &&
      (await detail.locator('.verification-cards').innerText()).includes('Not used'), `The inspector misreported compact verification for ${measurement.suffix}`);
    const effects = detail.locator('.public-effects');
    assert(await effects.count() === 2, 'The inspector omitted nullifier or output-commitment groups');
    for (const [groupIndex, key] of [[0, 'nullifiers'], [1, 'commitments']]) {
      const displayed = await effects.nth(groupIndex).locator('.public-effect code[title]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
      assert(sameJson(displayed, activity[key] || []), `The inspector public ${key} do not match the receipt`);
    }
    await detail.getByRole('button', { name: 'Raw public data' }).click();
    const raw = JSON.parse(await detail.locator('pre.raw-json').innerText());
    assert(raw.txid === measurement.txid && sameJson(raw.nullifiers || [], activity.nullifiers || []) &&
      sameJson(raw.commitments || [], activity.commitments || []), `Raw public data does not match ${measurement.suffix}`);
    assert(!Object.hasOwn(raw, 'proof'), `Raw public data unexpectedly contains a proof for ${measurement.suffix}`);
    await detail.getByRole('button', { name: 'Effects & verification' }).click();
  }
  return measurements.length;
}

async function verifyReserveLedger(page, state) {
  const byAsset = new Map((state.reserves || []).map((entry) => [entry.asset, entry]));
  const expected = ['BTC', 'TOKEN'].map((asset) => byAsset.get(asset)).filter(Boolean);
  const rows = page.locator('.reserves-panel .reserve-row');
  assert(expected.length === 2 && await rows.count() === expected.length, 'The reserve ledger does not show both funded assets');
  for (let index = 0; index < expected.length; index++) {
    const reserve = expected[index];
    assert(Number(reserve.reserve) >= Number(reserve.liabilities), `The ${reserve.asset} reserve is below liabilities`);
    const row = rows.nth(index);
    assert((await row.innerText()).includes('Backed'), `The ${reserve.asset} reserve is not labeled backed`);
    const amounts = row.locator('.reserve-numbers > div strong');
    for (const [amountIndex, expectedAmount] of [reserve.reserve, reserve.liabilities].entries()) {
      const text = await amounts.nth(amountIndex).innerText();
      const value = text.match(/[\d,]+/)?.[0]?.replaceAll(',', '');
      assert(value !== undefined && Number(value) === Number(expectedAmount), `The ${reserve.asset} reserve ledger amount is incorrect`);
    }
  }
  assert((await page.locator('.invariant-formula').innerText()).includes('private liabilities ≤ native reserves'), 'The reserve invariant is not visible');
}

async function main() {
  const replayPlan = await loadReplayPlan();
  assert(path.resolve(reportPath).startsWith(`${root}${path.sep}`), 'Report path escaped the checkout');
  assert(path.resolve(screenshotDir).startsWith(`${root}${path.sep}`), 'Screenshot path escaped the recovery directory');
  const tokenStat = await lstat(tokenPath);
  assert(tokenStat.isFile() && !tokenStat.isSymbolicLink(), 'The local API token path must be a regular file');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  secretToken = token;
  assert(token.length >= 32, 'The local API token file is missing or unexpectedly short');
  await mkdir(screenshotDir, { recursive: true });

  let browser;
  const consoleErrors = [];
  const pageErrors = [];
  const unexpectedResponses = [];
  try {
    const localBrowser = chromium.executablePath();
    const executablePath = process.env.SHIELDED_BROWSER_PATH || (existsSync(localBrowser) ? undefined : [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ].find((candidate) => existsSync(candidate)));
    assert(executablePath !== undefined || existsSync(localBrowser), 'No installed Chromium, Edge, or Chrome executable is available');
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const responseUrl = new URL(response.url());
      const expectedUnauthorized = response.status() === 401 && responseUrl.origin === parsedBaseUrl.origin && ['/api/state', '/api/session'].includes(responseUrl.pathname);
      if (!expectedUnauthorized) unexpectedResponses.push(`${response.status()} ${responseUrl.pathname}`);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location();
      if (!isExpectedUnauthorizedConsoleError(message.text(), location.url)) consoleErrors.push(safeError(message.text(), token));
    });
    page.on('pageerror', (error) => pageErrors.push(safeError(error, token)));

    const beforeResponse = await page.request.get(`${baseUrl}/api/state`);
    assert(beforeResponse.status() === 401, 'Unauthenticated state API did not return HTTP 401');
    const sessionResponse = await page.request.get(`${baseUrl}/api/session`);
    assert(sessionResponse.ok(), 'Session discovery endpoint did not respond successfully');
    const sessionInfo = await sessionResponse.json();
    assert(sessionInfo.enabled === true && sessionInfo.authenticated === false, 'Initial session state was not anonymous');

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const tokenInput = page.getByLabel('Operator API token');
    await tokenInput.waitFor({ state: 'visible' });
    assert((await page.locator('body').innerText()).includes('Sign in to your wallet service.'), 'Anonymous UI did not show the login screen');
    await page.screenshot({ path: path.join(screenshotDir, 'login.png'), fullPage: true });

    await tokenInput.fill('invalid-token-for-ui-smoke');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').waitFor({ state: 'visible' });
    assert(await tokenInput.isVisible(), 'A failed login left the login screen');
    await tokenInput.fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor({ state: 'visible' });
    await page.getByRole('heading', { name: 'From native assets' }).waitFor({ state: 'visible' });
    await page.getByText('Mutinynet', { exact: false }).first().waitFor({ state: 'visible' });
    const apiContextAfterResponse = await page.request.get(`${baseUrl}/api/state`);
    const browserSessionAfterLogin = await browserGet(page, '/api/session');
    const browserAfterResponse = await browserGet(page, '/api/state');
    if (browserAfterResponse.status !== 200 || browserSessionAfterLogin.body?.authenticated !== true) {
      throw new Error(`Authenticated browser state API was not available after login (${await safeAuthDiagnostics(page, baseUrl, apiContextAfterResponse.status())})`);
    }
    const before = browserAfterResponse.body;
    const statusNetwork = String(before.status?.network ?? '').toLowerCase();
    const nativeNetwork = String(before.native?.network ?? '').toLowerCase();
    assert(statusNetwork === 'mutinynet' || nativeNetwork === 'mutinynet', 'Authenticated UI is not connected to Mutinynet');
    assert(before.status?.proofTransport === 'compact' || before.status?.transport === 'compact', 'Compact proof transport is not active');
    assert(before.status?.ready === true, 'Compact service is not ready');
    assert(typeof before.status?.profileId === 'string' && /^[0-9a-f]{64}$/.test(before.status.profileId), 'Registered profile ID is not a 64-character lowercase hex digest');
    assert(before.native?.profileId === before.status.profileId, 'Runtime profile does not match the registered UI profile');
    const initialFingerprint = financialFingerprint(before);
    let uiNotesPrivacyVerified = false;
    let uiReserveLedgerVerified = false;
    let inspectedPublicReceiptCount = 0;
    if (replayPlan) {
      assert(before.status.profileId === replayPlan.baseline.profileId, 'Current runtime profile does not match the completed funded baseline');
      assert(baselineFinancialDigest(before) === replayPlan.baseline.finalFinancialStateSha256, 'Current funded state does not match the completed baseline digest');
      assert((before.activity || []).length === replayPlan.baseline.finalActivityCount, 'Current activity count does not match the funded baseline');
      const activityTxids = (before.activity || []).map((item) => item.txid).filter(Boolean);
      assert(sameJson(activityTxids, replayPlan.baseline.finalActivityTxids), 'Current transaction history does not match the funded baseline');
    }

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    for (const [label, heading] of [
      ['Notes & reserves', 'The private balance sheet.'],
      ['Primitives', 'The registered verifier path.'],
      ['Public inspector', 'What does an observer see?'],
    ]) {
      await nav.getByRole('button', { name: label }).click();
      await page.getByRole('heading', { name: heading }).waitFor({ state: 'visible' });
    }
    if (replayPlan) {
      await nav.getByRole('button', { name: 'Notes & reserves' }).click();
      await verifyNotePrivacy(page, before);
      uiNotesPrivacyVerified = true;
      await nav.getByRole('button', { name: 'Public inspector' }).click();
      inspectedPublicReceiptCount = await verifyPublicReceipts(page, before, replayPlan);
    }
    await nav.getByRole('button', { name: 'Payment flow' }).click();
    await page.getByRole('heading', { name: 'Run the flow' }).waitFor({ state: 'visible' });

    const tabs = page.getByRole('tablist', { name: 'Payment lifecycle' });
    await tabs.getByRole('tab', { name: /transfer/i }).click();
    await page.getByLabel('From wallet').selectOption('bob');
    await page.getByLabel('To wallet').selectOption('alice');
    assert(await page.getByLabel('From wallet').inputValue() === 'bob', 'Sender selector did not retain Bob');
    assert(await page.getByLabel('To wallet').inputValue() === 'alice', 'Recipient selector did not retain Alice');
    await page.getByRole('button', { name: 'Demo token' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '250', 'DEMO selector did not update the transfer amount');
    await page.getByRole('button', { name: 'Bitcoin' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '25000', 'BTC selector did not restore the transfer amount');
    await page.getByLabel('From wallet').selectOption('alice');
    await page.getByLabel('To wallet').selectOption('bob');
    await page.getByRole('button', { name: 'Demo token' }).click();
    await tabs.getByRole('tab', { name: /shield/i }).click();
    await page.getByLabel('Recipient wallet').selectOption('bob');
    assert(await page.getByLabel('Amount').inputValue() === '1000', 'DEMO shield form did not update its amount');
    await page.getByRole('button', { name: 'Bitcoin' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '100000', 'BTC shield form did not update its amount');
    await tabs.getByRole('tab', { name: /withdraw/i }).click();
    await page.getByLabel('From wallet').selectOption('alice');
    await page.getByRole('button', { name: 'Demo token' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '100', 'DEMO withdrawal form did not update its amount');
    await page.getByRole('button', { name: 'Bitcoin' }).click();
    assert(await page.getByLabel('Amount').inputValue() === '10000', 'BTC withdrawal form did not update its amount');

    const replayedUiActions = replayPlan ? await replayFinancialUi(page, baseUrl, replayPlan, before, initialFingerprint) : [];
    if (replayPlan) {
      await nav.getByRole('button', { name: 'Payment flow' }).click();
      await page.getByRole('heading', { name: 'The reserve ledger' }).waitFor({ state: 'visible' });
      await verifyReserveLedger(page, before);
      uiReserveLedgerVerified = true;
    }

    await page.screenshot({ path: path.join(screenshotDir, 'authenticated.png'), fullPage: true });
    const afterUiResponse = await browserGet(page, '/api/state');
    assert(afterUiResponse.status === 200, `Authenticated browser state API failed after UI navigation (HTTP ${afterUiResponse.status})`);
    const afterUi = afterUiResponse.body;
    assert(financialFingerprint(afterUi) === initialFingerprint, 'Read-only UI navigation changed financial state, profile, activity, or heads');
    assert(consoleErrors.length === 0, `Browser console reported ${consoleErrors.length} error(s)`);
    assert(unexpectedResponses.length === 0, 'Browser observed unexpected HTTP error responses: ' + unexpectedResponses.length);
    assert(pageErrors.length === 0, `Browser runtime reported ${pageErrors.length} error(s)`);

    await page.getByRole('button', { name: 'Sign out' }).click();
    const loggedOutTokenInput = page.getByLabel('Operator API token');
    await loggedOutTokenInput.waitFor({ state: 'visible' });
    assert(await loggedOutTokenInput.inputValue() === '', 'Sign out did not clear the operator token field');
    const afterLogout = await browserGet(page, '/api/state');
    assert(afterLogout.status === 401, 'State API remained accessible in the browser after sign out');
    const afterLogoutSession = await browserGet(page, '/api/session');
    assert(afterLogoutSession.status === 200 && afterLogoutSession.body?.authenticated === false, 'Browser session discovery still reports an authenticated user after sign out');
    const apiAfterLogout = await page.request.get(`${baseUrl}/api/state`);
    assert(apiAfterLogout.status() === 401, 'APIRequestContext state API remained accessible after sign out');
    await page.screenshot({ path: path.join(screenshotDir, 'logout.png'), fullPage: true });

    const report = {
      schema: 1,
      result: 'passed',
      timestamp: new Date().toISOString(),
      baseUrl,
      browser: 'headless Chromium bundled with Playwright; installed browser executable only',
      checks: {
        anonymousApi401: true,
        anonymousLoginScreen: true,
        invalidTokenRejected: true,
        validTokenLogin: true,
        mutinynetCompactReady: true,
        paymentFlowPartiesAndAssetsSelectable: true,
        notesReservesPrimitivesInspectorRendered: true,
        notePrivacyViews: replayPlan ? uiNotesPrivacyVerified : false,
        backingReserveLedger: replayPlan ? uiReserveLedgerVerified : false,
        publicReceiptInspection: replayPlan ? inspectedPublicReceiptCount === 20 : false,
        signedOutApi401: true,
        signedOutSessionUnauthenticated: true,
        logoutTokenFieldCleared: true,
        readOnlyFinancialFingerprintUnchanged: true,
        browserConsoleClean: true,
        noUnexpectedHttpErrors: true,
        baselineReceiptReplay: replayPlan ? replayedUiActions.length === 20 : false,
        noNewFinancialActions: replayPlan ? true : false,
      },
      uiReplay: replayPlan ? { executed: true, actionCount: replayedUiActions.length, inspectedPublicReceiptCount: inspectedPublicReceiptCount, sourceReport: 'validation/compact-mutinynet.json', sourceReportSha256: createHash('sha256').update(JSON.stringify(replayPlan.baseline)).digest('hex'), newFinancialActions: 0, replayed: replayedUiActions } : { executed: false, actionCount: 0, inspectedPublicReceiptCount: 0, newFinancialActions: 0 },
      state: {
        network: nativeNetwork || statusNetwork,
        profileId: before.status.profileId,
        profileIdFormat: 'sha256-hex',
        epoch: before.epoch,
        noteCount: (before.wallets || []).reduce((total, wallet) => total + (wallet.notes || []).length, 0),
        activityCount: (before.activity || []).length,
        laneCount: (before.lanes || []).length,
      },
      screenshots: ['ui-smoke/login.png', 'ui-smoke/authenticated.png', 'ui-smoke/logout.png'],
    };
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    process.stdout.write('Compact UI smoke passed; sanitized report saved.\n');
  } finally {
    if (browser) await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Compact UI smoke failed: ${safeError(error, secretToken)}\n`);
  process.exitCode = 1;
});
