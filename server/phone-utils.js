function normalizePhoneCandidate(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^\d+]/g, '');
  const digitsOnly = cleaned.replace(/\+/g, '');
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return null;
  return cleaned.startsWith('+') ? '+' + digitsOnly : digitsOnly;
}

function pickBestPhoneCandidate(candidates) {
  const unique = [...new Set((candidates || []).map(normalizePhoneCandidate).filter(Boolean))];
  if (!unique.length) return null;

  const preferred = unique.find((candidate) => candidate.startsWith('+')) || unique[0];
  return preferred || null;
}

module.exports = { normalizePhoneCandidate, pickBestPhoneCandidate };
