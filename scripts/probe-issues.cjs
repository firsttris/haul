// The hoster probe's issues (.github/workflows/hoster-probe.yml): one per case that needs
// someone, opened when it breaks, a comment when what is wrong changes, closed when it works
// again. A hoster that is only unavailable (busy, limited, unreachable) gets an issue after
// UNAVAILABLE_RUNS runs in a row. `state` remembers since when a case fails and when it
// last worked; the workflow keeps it in the Actions cache.
const fs = require('node:fs');
const path = require('node:path');

const LABEL = 'hoster-probe';
const UNAVAILABLE_RUNS = 3;
const PASSING = new Set(['ok', 'checked', 'captcha']);
const ATTENTION = new Set(['broken', 'offline', 'account']);

const day = (secs) => (secs ? new Date(secs * 1000).toISOString().slice(0, 10) : 'never (since the probe runs)');
const title = (c) => `Hoster probe: ${c.case} (${c.plugin ?? 'no plugin'})`;
const HINT = {
  broken: 'The plugin failed or returned something wrong: the hoster probably changed its pages or API.',
  offline: 'The hoster says the test file is gone. Upload it again and update its `PROBE_*` secret, unless the plugin misreads the page.',
  account: 'The account of this case was rejected or is out of traffic.',
  unavailable: `The hoster was busy, limited or unreachable in ${UNAVAILABLE_RUNS} runs in a row.`,
};

function body(c, s, runUrl) {
  return [
    `**${c.status}**: ${c.message ?? ''}`,
    '',
    HINT[c.status] ?? '',
    '',
    `| | |`,
    `|---|---|`,
    `| Plugin | ${c.plugin ?? '-'} v${c.pluginVersion ?? '?'} |`,
    `| Failing since | ${day(s.failingSince)} |`,
    `| Last worked | ${day(s.lastOk)} |`,
    `| Steps | ${c.steps.map((st) => `${st.ok ? '✅' : '❌'} ${st.step}`).join(' → ') || '-'} |`,
    `| Run | ${runUrl} |`,
    '',
    'The pages the hoster sent are in the run\'s encrypted `probe-pages` artifact (if `HAUL_PROBE_ZIP_PASSWORD` is set); locally: `haul probe --secrets links.json --only ' +
      c.case +
      ' .github/hoster-probe.json`.',
  ].join('\n');
}

module.exports = async ({ github, context, core, report, state: statePath }) => {
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const { startedAt, cases } = JSON.parse(fs.readFileSync(report, 'utf8'));
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    // First run.
  }
  const open = await github.paginate(github.rest.issues.listForRepo, { owner, repo, labels: LABEL, state: 'open', per_page: 100 });

  for (const c of cases) {
    const s = (state[c.case] ??= {});
    const issue = open.find((i) => i.title === title(c) || i.title.startsWith(`Hoster probe: ${c.case} (`));
    if (PASSING.has(c.status)) {
      Object.assign(s, { lastOk: startedAt, failingSince: null, failedRuns: 0, alerted: null });
      if (issue) {
        await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: `Works again (**${c.status}**): ${runUrl}` });
        await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' });
        core.info(`${c.case}: works again, closed #${issue.number}`);
      }
      continue;
    }
    s.failingSince ??= startedAt;
    s.failedRuns = (s.failedRuns ?? 0) + 1;
    const alert = ATTENTION.has(c.status) || (c.status === 'unavailable' && s.failedRuns >= UNAVAILABLE_RUNS);
    if (!alert) {
      core.info(`${c.case}: ${c.status} (${s.failedRuns} run(s) in a row), no issue yet`);
      continue;
    }
    // One comment per change, not one per day.
    const what = `${c.status}: ${c.message ?? ''}`;
    if (!issue) {
      const created = await github.rest.issues.create({ owner, repo, title: title(c), labels: [LABEL], body: body(c, s, runUrl) });
      core.warning(`${c.case}: ${what}, opened #${created.data.number}`);
    } else if (s.alerted !== what) {
      await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: body(c, s, runUrl) });
      core.warning(`${c.case}: ${what}, commented on #${issue.number}`);
    }
    s.alerted = what;
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
};
