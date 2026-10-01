'use strict';
// Maps site labels (platform, question type, difficulty) to the exact values
// in the sheet's Lists tab, using the editable Mapping tab first.
(function (LMC) {
  const FIELD_LABEL = { platform: 'Platform', questionType: 'Question type', difficulty: 'Difficulty' };

  function norm(v) {
    return String(v == null ? '' : v)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[‐-―]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .replace(/[\s.:;]+$/, '')
      .trim();
  }

  // Returns the sheet value for `raw`, pushing a human-readable note onto
  // `flags` when the value had to pass through unmapped.
  function mapValue(fieldKey, raw, platform, config, flags) {
    if (raw == null || raw === '') return '';
    const label = FIELD_LABEL[fieldKey] || fieldKey;
    const header = config && config.fields && config.fields[fieldKey];
    if (!header) {
      flags.push(`${label} not checked (sheet lists not loaded): ${raw}`);
      return String(raw);
    }
    const n = norm(raw);
    const fieldNames = new Set([norm(header), norm(label), norm(fieldKey)]);
    const rows = (config.mapping || []).filter((r) => fieldNames.has(norm(r.field)) && norm(r.from) === n);
    const hit =
      rows.find((r) => r.platform && norm(r.platform) === norm(platform)) || rows.find((r) => !norm(r.platform));
    const allowed = (config.lists && config.lists[header]) || [];
    if (hit) {
      if (allowed.length && !allowed.includes(hit.to)) {
        flags.push(`Mapping gives ${label} "${hit.to}", which is not in Lists`);
      }
      return hit.to;
    }
    const direct = allowed.find((v) => norm(v) === n);
    if (direct !== undefined) return direct;
    flags.push(`Unmapped ${label}: ${raw}`);
    return String(raw);
  }

  LMC.mapping = { mapValue, norm, FIELD_LABEL };
})((globalThis.LMC = globalThis.LMC || {}));
