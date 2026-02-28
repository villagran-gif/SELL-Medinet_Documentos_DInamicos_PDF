// Chilean RUT helpers

function computeDv(numberStr) {
  // modulus 11
  let sum = 0;
  let mul = 2;
  for (let i = numberStr.length - 1; i >= 0; i--) {
    sum += Number(numberStr[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const mod = 11 - (sum % 11);
  if (mod === 11) return '0';
  if (mod === 10) return 'K';
  return String(mod);
}

function normalizeRut(input) {
  const original = String(input || '').trim();

  // Common user mistake: they type the dash but forget the DV (e.g. "13.580.388-")
  if (/-\s*$/.test(original)) {
    const err = new Error('RUT inválido (falta dígito verificador)');
    err.code = 'MISSING_RUT_DV';
    throw err;
  }

  const raw = original
    .toUpperCase()
    .replace(/[^0-9K]/g, '');

  if (raw.length < 2) {
    return { normalized: '', normalizedNoDash: '', number: '', dv: '' };
  }

  let dv = raw.slice(-1);
  let number = raw.slice(0, -1).replace(/^0+/, '');
  if (!number) number = '0';

  const expected = computeDv(number);
  if (dv !== expected) {
    const err = new Error('RUT inválido (dígito verificador no coincide)');
    err.code = 'INVALID_RUT_DV';
    throw err;
  }

  const normalized = `${number}-${dv}`;
  const normalizedNoDash = `${number}${dv}`;
  return { normalized, normalizedNoDash, number, dv };
}

module.exports = {
  computeDv,
  normalizeRut,
};
