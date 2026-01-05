export function normalizeDecimalString(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;

  // Expand scientific notation if present (best-effort)
  if (/[eE]/.test(s)) {
    const expanded = expandExponentialToDecimal(s);
    if (!expanded) return null;
    s = expanded;
  }

  if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(s)) return null;

  if (s.startsWith('.')) s = `0${s}`;
  if (s.startsWith('+.')) s = `+0${s.slice(1)}`;
  if (s.startsWith('-.')) s = `-0${s.slice(1)}`;
  if (s.endsWith('.')) s = `${s}0`;

  return s;
}

export function isZeroDecimal(norm) {
  const s = normalizeDecimalString(norm);
  if (!s) return false;
  return /^-?0+(?:\.0+)?$/.test(s.replace(/^\+/, ''));
}

function expandExponentialToDecimal(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!m) return null;

  const sign = m[1] === '-' ? '-' : '';
  const intPart = m[2] || '0';
  const fracPart = m[3] || '';
  const exp = parseInt(m[4], 10);
  if (!Number.isFinite(exp)) return null;

  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '') || '0';
  const fracLen = fracPart.length;
  let point = digits.length - fracLen + exp;

  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function decimalSubtract(a, b) {
  const normA = normalizeDecimalString(a);
  const normB = normalizeDecimalString(b);
  if (!normA || !normB) return null;

  const scaleA = normA.includes('.') ? (normA.length - normA.indexOf('.') - 1) : 0;
  const scaleB = normB.includes('.') ? (normB.length - normB.indexOf('.') - 1) : 0;
  const scale = Math.max(scaleA, scaleB);

  const toScaledBigInt = (norm, targetScale) => {
    const sign = norm.startsWith('-') ? -1n : 1n;
    const unsigned = norm.replace(/^[+-]/, '');
    const [intPart, fracPart = ''] = unsigned.split('.');
    const paddedFrac = fracPart.padEnd(targetScale, '0');
    const digits = `${intPart || '0'}${paddedFrac}`.replace(/^0+(?=\d)/, '') || '0';
    return BigInt(digits) * sign;
  };

  const diff = toScaledBigInt(normA, scale) - toScaledBigInt(normB, scale);
  const sign = diff < 0n ? '-' : '';
  const abs = diff < 0n ? -diff : diff;

  let digits = abs.toString();
  if (scale > 0) {
    if (digits.length <= scale) digits = digits.padStart(scale + 1, '0');
    const intPart = digits.slice(0, digits.length - scale);
    const fracPart = digits.slice(digits.length - scale);
    return normalizeLeadingZeros(`${sign}${intPart}.${fracPart}`);
  }

  return normalizeLeadingZeros(`${sign}${digits}`);
}

export function decimalShiftPow10(value, places) {
  const norm = normalizeDecimalString(value);
  if (!norm) return null;
  const p = Number(places);
  if (!Number.isFinite(p) || !Number.isInteger(p)) return null;
  if (p === 0) return normalizeLeadingZeros(norm.replace(/^\+/, ''));

  const sign = norm.startsWith('-') ? '-' : '';
  const unsigned = norm.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = unsigned.split('.');
  const digits = (intPart + fracPart) || '0';
  const fracLen = fracPart.length;
  const point = intPart.length;

  const newPoint = point + p;
  if (newPoint <= 0) {
    return normalizeLeadingZeros(`${sign}0.${'0'.repeat(-newPoint)}${digits}`.replace(/^\+/, ''));
  }
  if (newPoint >= digits.length) {
    return normalizeLeadingZeros(`${sign}${digits}${'0'.repeat(newPoint - digits.length)}`.replace(/^\+/, ''));
  }
  return normalizeLeadingZeros(`${sign}${digits.slice(0, newPoint)}.${digits.slice(newPoint)}`.replace(/^\+/, ''));
}

function normalizeLeadingZeros(value) {
  const s = String(value ?? '').trim();
  if (!s) return s;
  const sign = s.startsWith('-') ? '-' : (s.startsWith('+') ? '+' : '');
  const body = s.replace(/^[+-]/, '');
  const parts = body.split('.');
  const intPart = parts[0] ?? '0';
  const fracPart = parts[1];
  const intNorm = (intPart.replace(/^0+(?=\d)/, '') || '0');
  const out = fracPart !== undefined ? `${intNorm}.${fracPart}` : intNorm;
  return sign === '+' ? out : `${sign}${out}`;
}
