function formatMoney(value) {
  const amount = typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : typeof value === 'string' ? value.trim() : '';
  const match = amount.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return '—';
  const whole = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (match[3] || '').padEnd(2, '0');
  return `${match[1]}${whole}.${fraction}`;
}

module.exports = { formatMoney };
