const clean = (s) => typeof s === 'string' && s.length <= 300 && !/[\u0000-\u001f\u007f]/.test(s);

export function validateConditions(precondition, postcondition, fileValidator) {
  for (const [label, value] of [['precondition', precondition], ['postcondition', postcondition]]) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['titleContains', 'textContains', 'path'].includes(k))) throw new TypeError(`Invalid ${label}`);
    if (value.titleContains !== undefined && !clean(value.titleContains)) throw new TypeError(`Invalid ${label} titleContains`);
    if (value.textContains !== undefined && !clean(value.textContains)) throw new TypeError(`Invalid ${label} textContains`);
    if(label==='precondition'&&value.path!==undefined)throw new TypeError('File paths are supported only as explicit postconditions');
    if (value.path !== undefined && (!clean(value.path) || !fileValidator)) throw new TypeError(`${label} path requires an injected file validator`);
    if (!Object.keys(value).length) throw new TypeError(`Empty ${label}`);
  }
}

export function verifyWindowEvidence(result, { pid, window_id }, expected = {}) {
  if (!result || result.isError === true) return { verified: false, evidence: 'missing' };
  const sc = result.structuredContent || result;
  const identity = sc.pid ?? sc.process_id;
  const hwnd = sc.window_id ?? sc.hwnd;
  if ((identity !== undefined && identity !== pid) || (hwnd !== undefined && hwnd !== window_id)) return { verified: false, evidence: 'wrong-target' };
  if (identity === undefined || hwnd === undefined) return { verified: false, evidence: 'identity-unknown' };
  const title = sc.title ?? sc.window_title;
  const text = [sc.text, sc.content, ...(Array.isArray(sc.elements) ? sc.elements.flatMap(e => [e?.label, e?.value, e?.name, e?.text]) : [])].filter(v => typeof v === 'string').join('\n');
  if (expected.titleContains && (typeof title !== 'string' || !title.includes(expected.titleContains))) return { verified: false, evidence: 'title-mismatch' };
  if (expected.textContains && !text.includes(expected.textContains)) return { verified: false, evidence: 'text-mismatch' };
  return { verified: Boolean(expected.titleContains || expected.textContains), evidence: expected.titleContains || expected.textContains ? 'postcondition-matched' : 'target-reobserved' };
}
