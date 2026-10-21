-- Preserve synthetic tuition-restatement provenance and hide logically reversed rows.
-- This migration is intentionally numbered after the separately reviewed auth v2.023.

CREATE TABLE finance_assessment_restatement_operations (
  operation_id CHAR(36) NOT NULL PRIMARY KEY,
  operation_kind VARCHAR(48) NOT NULL CHECK (operation_kind = 'synthetic_tuition_installments'),
  request_fingerprint CHAR(64) NOT NULL,
  manifest_sha256 CHAR(64) NOT NULL,
  target_lines_sha256 CHAR(64) NOT NULL,
  actor_id INT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_restatement_request UNIQUE (request_fingerprint),
  CONSTRAINT FK_finance_restatement_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);

CREATE TABLE finance_assessment_restatement_annuals (
  operation_id CHAR(36) NOT NULL,
  annual_enrollment_id INT NOT NULL,
  assessment_id INT NOT NULL,
  confirmation_id INT NOT NULL,
  source_schedule_id INT NOT NULL,
  source_schedule_version INT NOT NULL,
  target_tuition_schedule_id INT NOT NULL,
  target_tuition_schedule_version INT NOT NULL,
  before_image_json LONGTEXT NOT NULL CHECK (JSON_VALID(before_image_json) = 1),
  before_image_sha256 CHAR(64) NOT NULL,
  applied_image_json LONGTEXT NOT NULL CHECK (JSON_VALID(applied_image_json) = 1),
  applied_image_sha256 CHAR(64) NOT NULL,
  PRIMARY KEY (operation_id, annual_enrollment_id),
  CONSTRAINT UQ_finance_restatement_annual_once UNIQUE (annual_enrollment_id),
  CONSTRAINT UQ_finance_restatement_assessment_once UNIQUE (assessment_id),
  CONSTRAINT UQ_finance_restatement_confirmation_once UNIQUE (confirmation_id),
  CONSTRAINT FK_finance_restatement_annual_operation FOREIGN KEY (operation_id)
    REFERENCES finance_assessment_restatement_operations(operation_id),
  CONSTRAINT FK_finance_restatement_annual_parent FOREIGN KEY (annual_enrollment_id)
    REFERENCES annual_enrollments(id),
  CONSTRAINT FK_finance_restatement_annual_assessment FOREIGN KEY (assessment_id)
    REFERENCES annual_assessments(id),
  CONSTRAINT FK_finance_restatement_annual_confirmation FOREIGN KEY (confirmation_id)
    REFERENCES annual_registrar_confirmations(id),
  CONSTRAINT FK_finance_restatement_source_schedule FOREIGN KEY (source_schedule_id)
    REFERENCES finance_schedules(id),
  CONSTRAINT FK_finance_restatement_target_schedule FOREIGN KEY (target_tuition_schedule_id)
    REFERENCES finance_schedules(id)
);

CREATE TABLE finance_assessment_restatement_events (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  operation_id CHAR(36) NOT NULL,
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('applied', 'reversed')),
  idempotency_key CHAR(36) NOT NULL,
  actor_id INT NOT NULL,
  reason VARCHAR(1000) NOT NULL,
  manifest_sha256 CHAR(64) NOT NULL,
  resulting_state_sha256 CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_restatement_event_once UNIQUE (operation_id, event_type),
  CONSTRAINT UQ_finance_restatement_event_key UNIQUE (idempotency_key),
  CONSTRAINT FK_finance_restatement_event_operation FOREIGN KEY (operation_id)
    REFERENCES finance_assessment_restatement_operations(operation_id),
  CONSTRAINT FK_finance_restatement_event_actor FOREIGN KEY (actor_id) REFERENCES users(id)
);

ALTER TABLE assessed_charges
  ADD synthetic_restatement_operation_id CHAR(36) NULL,
  ADD synthetic_restatement_role VARCHAR(16) NULL,
  ADD INDEX IX_assessed_charge_restatement (synthetic_restatement_operation_id, annual_enrollment_id, synthetic_restatement_role, id),
  ADD CONSTRAINT CK_assessed_charge_restatement_role CHECK (
    (synthetic_restatement_operation_id IS NULL AND synthetic_restatement_role IS NULL)
    OR (synthetic_restatement_operation_id IS NOT NULL AND synthetic_restatement_role IS NOT NULL
      AND synthetic_restatement_role IN ('source', 'generated'))
  ),
  ADD CONSTRAINT FK_assessed_charge_restatement FOREIGN KEY (synthetic_restatement_operation_id)
    REFERENCES finance_assessment_restatement_operations(operation_id);

ALTER TABLE finance_payment_allocations
  ADD synthetic_restatement_operation_id CHAR(36) NULL,
  ADD synthetic_restatement_kind VARCHAR(16) NULL,
  ADD INDEX IX_finance_payment_allocation_restatement (synthetic_restatement_operation_id, id),
  ADD CONSTRAINT CK_finance_payment_allocation_restatement_kind CHECK (
    (synthetic_restatement_operation_id IS NULL AND synthetic_restatement_kind IS NULL)
    OR (synthetic_restatement_operation_id IS NOT NULL AND synthetic_restatement_kind IS NOT NULL
      AND synthetic_restatement_kind IN ('placement', 'restoration'))
  ),
  ADD CONSTRAINT FK_finance_payment_allocation_restatement FOREIGN KEY (synthetic_restatement_operation_id)
    REFERENCES finance_assessment_restatement_operations(operation_id);

ALTER TABLE finance_payment_allocation_releases
  ADD synthetic_restatement_operation_id CHAR(36) NULL,
  ADD INDEX IX_finance_payment_release_restatement (synthetic_restatement_operation_id, id),
  ADD CONSTRAINT FK_finance_payment_release_restatement FOREIGN KEY (synthetic_restatement_operation_id)
    REFERENCES finance_assessment_restatement_operations(operation_id);

CREATE TRIGGER trg_finance_restatement_operations_no_update BEFORE UPDATE ON finance_assessment_restatement_operations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only';
CREATE TRIGGER trg_finance_restatement_operations_no_delete BEFORE DELETE ON finance_assessment_restatement_operations
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only';
CREATE TRIGGER trg_finance_restatement_annuals_no_update BEFORE UPDATE ON finance_assessment_restatement_annuals
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only';
CREATE TRIGGER trg_finance_restatement_annuals_no_delete BEFORE DELETE ON finance_assessment_restatement_annuals
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only';
CREATE TRIGGER trg_finance_restatement_events_no_update BEFORE UPDATE ON finance_assessment_restatement_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only';
CREATE TRIGGER trg_finance_restatement_events_no_delete BEFORE DELETE ON finance_assessment_restatement_events
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance restatement history is append-only';

CREATE OR REPLACE VIEW v_finance_restatement_active_annuals AS
SELECT archive.operation_id, archive.annual_enrollment_id, archive.assessment_id,
  archive.source_schedule_id, archive.source_schedule_version,
  archive.target_tuition_schedule_id, archive.target_tuition_schedule_version,
  archive.before_image_sha256, archive.applied_image_sha256
FROM finance_assessment_restatement_annuals AS archive
INNER JOIN finance_assessment_restatement_events AS applied
  ON applied.operation_id = archive.operation_id AND applied.event_type = 'applied'
WHERE NOT EXISTS (
  SELECT 1 FROM finance_assessment_restatement_events AS reversed
  WHERE reversed.operation_id = archive.operation_id AND reversed.event_type = 'reversed'
);

CREATE OR REPLACE VIEW v_finance_restatement_active_operations AS
SELECT DISTINCT operation_id FROM v_finance_restatement_active_annuals;

CREATE OR REPLACE VIEW v_finance_restatement_applied_operations AS
SELECT DISTINCT operation_id FROM finance_assessment_restatement_events WHERE event_type = 'applied';

CREATE OR REPLACE VIEW v_finance_restatement_reversed_operations AS
SELECT DISTINCT operation_id FROM finance_assessment_restatement_events WHERE event_type = 'reversed';

CREATE OR REPLACE VIEW v_finance_effective_assessed_charges AS
SELECT charge.*
FROM assessed_charges AS charge
WHERE (charge.synthetic_restatement_operation_id IS NULL AND charge.synthetic_restatement_role IS NULL)
   OR (charge.synthetic_restatement_role = 'generated' AND EXISTS (
     SELECT 1 FROM v_finance_restatement_active_annuals AS active
     WHERE active.operation_id = charge.synthetic_restatement_operation_id
       AND active.annual_enrollment_id = charge.annual_enrollment_id
   ))
   OR (charge.synthetic_restatement_role = 'source' AND NOT EXISTS (
     SELECT 1 FROM v_finance_restatement_active_annuals AS active
     WHERE active.operation_id = charge.synthetic_restatement_operation_id
       AND active.annual_enrollment_id = charge.annual_enrollment_id
   ));

CREATE OR REPLACE VIEW v_finance_net_payment_allocations AS
SELECT allocation.id AS allocation_id, allocation.payment_id, allocation.charge_id,
  allocation.legacy_opening_charge_id, allocation.allocation_batch_id, allocation.allocated_by,
  allocation.synthetic_restatement_operation_id, allocation.synthetic_restatement_kind,
  CASE WHEN allocation.synthetic_restatement_operation_id IS NULL
      OR (allocation.synthetic_restatement_kind = 'placement' AND active.operation_id IS NOT NULL)
      OR (allocation.synthetic_restatement_kind = 'restoration' AND reversed.operation_id IS NOT NULL)
    THEN 1 ELSE 0 END AS is_effective,
  CAST(CASE WHEN allocation.synthetic_restatement_operation_id IS NULL
      OR (allocation.synthetic_restatement_kind = 'placement' AND active.operation_id IS NOT NULL)
      OR (allocation.synthetic_restatement_kind = 'restoration' AND reversed.operation_id IS NOT NULL)
    THEN allocation.amount - COALESCE(released.amount, 0) ELSE 0 END AS DECIMAL(12,2)) AS net_amount,
  CAST(CASE WHEN allocation.synthetic_restatement_operation_id IS NULL
      OR (allocation.synthetic_restatement_kind = 'placement' AND active.operation_id IS NOT NULL)
      OR (allocation.synthetic_restatement_kind = 'restoration' AND reversed.operation_id IS NOT NULL)
    THEN COALESCE(released.amount, 0) ELSE 0 END AS DECIMAL(12,2)) AS active_released_amount
FROM finance_payment_allocations AS allocation
LEFT JOIN (
  SELECT release_row.allocation_id, SUM(release_row.amount) AS amount
  FROM finance_payment_allocation_releases AS release_row
  INNER JOIN finance_payment_allocations AS released_allocation ON released_allocation.id = release_row.allocation_id
  LEFT JOIN v_finance_restatement_active_operations AS active_placement_release
    ON active_placement_release.operation_id = release_row.synthetic_restatement_operation_id
  LEFT JOIN v_finance_restatement_applied_operations AS applied_source_release
    ON applied_source_release.operation_id = release_row.synthetic_restatement_operation_id
  WHERE release_row.synthetic_restatement_operation_id IS NULL
    OR (released_allocation.synthetic_restatement_kind = 'placement' AND active_placement_release.operation_id IS NOT NULL)
    OR (released_allocation.synthetic_restatement_kind IS NULL AND applied_source_release.operation_id IS NOT NULL)
  GROUP BY release_row.allocation_id
) AS released ON released.allocation_id = allocation.id
LEFT JOIN v_finance_restatement_active_operations AS active
  ON active.operation_id = allocation.synthetic_restatement_operation_id
LEFT JOIN v_finance_restatement_reversed_operations AS reversed
  ON reversed.operation_id = allocation.synthetic_restatement_operation_id;

CREATE OR REPLACE VIEW v_finance_assessed_charge_due AS
SELECT charge.id AS charge_id, charge.annual_enrollment_id, charge.enrollment_id,
  CAST(charge.amount + COALESCE(adjustments.total, 0) - COALESCE(annual.total, 0) - COALESCE(legacy.total, 0)
    AS DECIMAL(12,2)) AS amount_due,
  CAST(COALESCE(annual.total, 0) AS DECIMAL(12,2)) AS annual_allocated,
  CAST(COALESCE(legacy.total, 0) AS DECIMAL(12,2)) AS legacy_allocated
FROM v_finance_effective_assessed_charges AS charge
LEFT JOIN (
  SELECT adjustment.charge_id, SUM(adjustment.amount) AS total
  FROM finance_charge_adjustments AS adjustment
  GROUP BY adjustment.charge_id
) AS adjustments ON adjustments.charge_id = charge.id
LEFT JOIN (
  SELECT allocation.charge_id, SUM(allocation.net_amount) AS total
  FROM v_finance_net_payment_allocations AS allocation
  INNER JOIN finance_payments AS payment ON payment.id = allocation.payment_id AND payment.is_reversed = 0
  WHERE allocation.charge_id IS NOT NULL AND allocation.is_effective = 1
  GROUP BY allocation.charge_id
) AS annual ON annual.charge_id = charge.id
LEFT JOIN (
  SELECT reconciliation.charge_id, SUM(reconciliation.net_amount) AS total
  FROM v_finance_net_legacy_reconciliations AS reconciliation
  GROUP BY reconciliation.charge_id
) AS legacy ON legacy.charge_id = charge.id;
