'use strict';
// Turns a parser result into Inbox rows. Pure apart from crypto.subtle.
//
// Parser result shape (every platform parser returns this):
//   session:   { platform, attemptKey, kind: 'drill'|'section'|'pt', timed, attemptDate, url, label? }
//   questions: [{ preptest, section, question, questionType, difficulty, timed?, firstAnswer,
//                 correctAnswer, brAnswer?, flagged?, timeSpentSec?, attemptDate?, link? }]
(function (LMC) {
  const PLATFORM_CODES = { '7Sage': '7S', 'LSAT Demon': 'LD', LawHub: 'LH' };

  const REASON_LABEL = {
    miss: 'Miss',
    'br-changed': 'Right → wrong in BR',
    flagged: 'Flagged (right)',
  };

  function letter(x) {
    if (x == null) return '';
    const m = String(x).trim().toUpperCase().match(/^\(?([A-E])\)?$/);
    return m ? m[1] : '';
  }

  // Why a question deserves a journal entry; [] if it does not.
  // A lucky guess (right but flagged) and a right answer you talked yourself
  // out of in blind review both count.
  function reasonsFor(q) {
    const correct = letter(q.correctAnswer);
    if (!correct) return [];
    const first = letter(q.firstAnswer);
    if (first !== correct) return ['miss'];
    const reasons = [];
    const br = letter(q.brAnswer);
    if (br && br !== correct) reasons.push('br-changed');
    if (q.flagged) reasons.push('flagged');
    return reasons;
  }

  async function sha256hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Stable per attempt: reopening the same results page yields the same ID,
  // re-drilling the question later yields a new one.
  async function captureId(platform, attemptKey, q) {
    if (!attemptKey) throw new Error('parser returned no attemptKey');
    const code = PLATFORM_CODES[platform] || String(platform).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
    const hash = await sha256hex([code, attemptKey, q.preptest, q.section, q.question].join('|'));
    return `${code}-PT${q.preptest || '?'}-S${q.section || '?'}-Q${q.question || '?'}-${hash.slice(0, 8)}`;
  }

  function defaultLabel(session, questions) {
    if (session.label) return session.label;
    const pts = new Set(questions.map((q) => q.preptest));
    const secs = new Set(questions.map((q) => `${q.preptest}/${q.section}`));
    const [pt] = pts;
    if (secs.size === 1) return `PT ${pt} S${questions[0].section}`;
    if (pts.size === 1) return `PT ${pt}`;
    return `${questions.length}-question ${session.kind || 'set'}`;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  function summarize(rows, label) {
    const count = (r) => rows.filter((x) => x.primaryReason === r).length;
    const parts = [];
    const misses = count('miss');
    const changed = count('br-changed');
    const flagged = count('flagged');
    if (misses) parts.push(plural(misses, 'miss', 'misses'));
    if (flagged) parts.push(`${flagged} flagged`);
    if (changed) parts.push(plural(changed, 'BR change', 'BR changes'));
    return parts.length ? `${parts.join(' + ')} from ${label}` : `Nothing to journal from ${label}`;
  }

  async function buildRows(result, config, now = new Date()) {
    const { session, questions } = result;
    const label = defaultLabel(session, questions);
    const rows = [];
    for (const q of questions) {
      const reasons = reasonsFor(q);
      if (!reasons.length) continue;
      const flags = [];
      const map = (field, raw) => LMC.mapping.mapValue(field, raw, session.platform, config, flags);
      for (const [k, v] of [['PT', q.preptest], ['section', q.section], ['question #', q.question]]) {
        if (v == null || v === '') flags.push(`Missing ${k}`);
      }
      if (q.firstAnswer && !letter(q.firstAnswer)) flags.push(`Odd first answer: ${q.firstAnswer}`);
      rows.push({
        captureId: await captureId(session.platform, session.attemptKey, q),
        capturedAt: now.toISOString(),
        platform: map('platform', session.platform),
        preptest: q.preptest == null ? '' : String(q.preptest),
        section: q.section == null ? '' : String(q.section),
        question: q.question == null ? '' : String(q.question),
        questionType: map('questionType', q.questionType),
        difficulty: map('difficulty', q.difficulty == null ? '' : String(q.difficulty)),
        timed: q.timed != null ? Boolean(q.timed) : session.timed != null ? Boolean(session.timed) : '',
        firstAnswer: letter(q.firstAnswer),
        correctAnswer: letter(q.correctAnswer),
        brAnswer: letter(q.brAnswer),
        flagged: q.flagged == null ? '' : Boolean(q.flagged),
        timeSpentSec: Number.isFinite(q.timeSpentSec) ? Math.round(q.timeSpentSec) : '',
        attemptDate: q.attemptDate || session.attemptDate || '',
        reason: reasons.map((r) => REASON_LABEL[r]).join('; '),
        primaryReason: reasons[0],
        link: q.link || session.url || '',
        session: label,
        sessionKey: session.attemptKey,
        needsReview: flags.join('; '),
      });
    }
    return { rows, label, summary: summarize(rows, label) };
  }

  LMC.capture = { buildRows, reasonsFor, captureId, letter, summarize, PLATFORM_CODES, REASON_LABEL, sha256hex };
})((globalThis.LMC = globalThis.LMC || {}));
