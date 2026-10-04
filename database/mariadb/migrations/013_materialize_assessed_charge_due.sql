-- Keep assessed-charge balances readable under strict grouping and pooled prepared queries.
-- Aggregate each authoritative adjustment/allocation/reconciliation source once per charge.
CREATE OR REPLACE VIEW v_finance_assessed_charge_due AS
SELECT charge.id AS charge_id, charge.annual_enrollment_id, charge.enrollment_id,
  CAST(charge.amount + COALESCE(adjustments.total, 0) - COALESCE(annual.total, 0) - COALESCE(legacy.total, 0)
    AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE(annual.total, 0) AS DECIMAL(12,2)) AS annual_allocated,
  CAST(COALESCE(legacy.total, 0) AS DECIMAL(12,2)) AS legacy_allocated
FROM assessed_charges AS charge
LEFT JOIN (
  SELECT adjustment.charge_id, SUM(adjustment.amount) AS total
  FROM finance_charge_adjustments AS adjustment
  GROUP BY adjustment.charge_id
) AS adjustments ON adjustments.charge_id = charge.id
LEFT JOIN (
  SELECT allocation.charge_id, SUM(allocation.net_amount) AS total
  FROM v_finance_net_payment_allocations AS allocation
  INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
  WHERE allocation.charge_id IS NOT NULL
  GROUP BY allocation.charge_id
) AS annual ON annual.charge_id = charge.id
LEFT JOIN (
  SELECT reconciliation.charge_id, SUM(reconciliation.net_amount) AS total
  FROM v_finance_net_legacy_reconciliations AS reconciliation
  GROUP BY reconciliation.charge_id
) AS legacy ON legacy.charge_id = charge.id;
