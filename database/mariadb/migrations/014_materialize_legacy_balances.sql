-- Keep legacy-account and opening-liability balances readable with grouped source totals.
-- Each independent source is aggregated before joining, so multiple reconciliations,
-- releases, or allocations cannot multiply one another.
CREATE OR REPLACE ALGORITHM = TEMPTABLE VIEW v_finance_legacy_account_balance AS
SELECT account.id AS financial_account_id, account.student_id,
  CAST(account.balance + COALESCE(reconciliation_totals.total, 0) - COALESCE(opening_totals.total, 0)
    AS DECIMAL(12,2)) AS remaining_legacy_balance
FROM financial_accounts AS account
LEFT JOIN (
  SELECT transaction_record.financial_account_id, SUM(reconciliation.net_amount) AS total
  FROM financial_transactions AS transaction_record
  INNER JOIN v_finance_net_legacy_reconciliations AS reconciliation
    ON reconciliation.transaction_id = transaction_record.id
  GROUP BY transaction_record.financial_account_id
) AS reconciliation_totals ON reconciliation_totals.financial_account_id = account.id
LEFT JOIN (
  SELECT opening.financial_account_id, SUM(opening.amount) AS total
  FROM finance_legacy_opening_charges AS opening
  GROUP BY opening.financial_account_id
) AS opening_totals ON opening_totals.financial_account_id = account.id;

CREATE OR REPLACE ALGORITHM = TEMPTABLE VIEW v_finance_opening_liability_due AS
SELECT opening.id AS opening_charge_id, opening.student_id,
  CAST(opening.amount - COALESCE(allocation_totals.total, 0) AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE(allocation_totals.total, 0) AS DECIMAL(12,2)) AS allocated
FROM finance_legacy_opening_charges AS opening
LEFT JOIN (
  SELECT allocation.legacy_opening_charge_id, SUM(allocation.net_amount) AS total
  FROM v_finance_net_payment_allocations AS allocation
  INNER JOIN finance_payments AS payment
    ON payment.id = allocation.payment_id AND payment.is_reversed = 0
  WHERE allocation.legacy_opening_charge_id IS NOT NULL
  GROUP BY allocation.legacy_opening_charge_id
) AS allocation_totals ON allocation_totals.legacy_opening_charge_id = opening.id;
