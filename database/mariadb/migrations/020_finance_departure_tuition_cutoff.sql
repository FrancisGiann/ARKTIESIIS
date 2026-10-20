-- Record Finance's departure-term tuition cutoff and every reviewed charge decision.
-- Existing reviewed departure cases intentionally receive no inferred cutoff evidence.

CREATE TABLE finance_departure_cutoff_reviews (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  departure_case_id BIGINT NOT NULL,
  effective_enrollment_id INT NOT NULL,
  effective_term_number TINYINT NOT NULL,
  last_payable_installment VARCHAR(12) NOT NULL,
  review_reason VARCHAR(1000) NOT NULL,
  reviewed_by INT NOT NULL,
  reviewed_by_role VARCHAR(20) NOT NULL,
  idempotency_key CHAR(36) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  reviewed_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_departure_cutoff_case UNIQUE (departure_case_id),
  CONSTRAINT UQ_finance_departure_cutoff_key UNIQUE (idempotency_key),
  CONSTRAINT UQ_finance_departure_cutoff_context UNIQUE (id, departure_case_id),
  CONSTRAINT CK_finance_departure_cutoff_term CHECK (effective_term_number BETWEEN 1 AND 3),
  CONSTRAINT CK_finance_departure_cutoff_installment CHECK (last_payable_installment IN ('none', 'dp', 'prelim', 'midterm', 'finals')),
  CONSTRAINT CK_finance_departure_cutoff_role CHECK (reviewed_by_role IN ('finance', 'database_admin')),
  CONSTRAINT FK_finance_departure_cutoff_case FOREIGN KEY (departure_case_id) REFERENCES finance_departure_cases(id),
  CONSTRAINT FK_finance_departure_cutoff_enrollment FOREIGN KEY (effective_enrollment_id) REFERENCES enrollments(id),
  CONSTRAINT FK_finance_departure_cutoff_actor FOREIGN KEY (reviewed_by) REFERENCES users(id)
);

CREATE TABLE finance_departure_charge_reviews (
  id BIGINT AUTO_INCREMENT NOT NULL PRIMARY KEY,
  cutoff_review_id BIGINT NOT NULL,
  departure_case_id BIGINT NOT NULL,
  charge_id BIGINT NOT NULL,
  enrollment_id INT NOT NULL,
  term_number TINYINT NOT NULL,
  fee_category_snapshot VARCHAR(40) NOT NULL,
  line_name_snapshot VARCHAR(120) NOT NULL,
  installment_snapshot VARCHAR(40) NOT NULL,
  review_category VARCHAR(32) NOT NULL,
  decision VARCHAR(12) NOT NULL,
  payable_before_amount DECIMAL(12,2) NOT NULL,
  proposed_reduction_amount DECIMAL(12,2) NOT NULL CHECK (proposed_reduction_amount >= 0),
  reviewed_reduction_amount DECIMAL(12,2) NOT NULL CHECK (reviewed_reduction_amount >= 0),
  payable_after_amount DECIMAL(12,2) NOT NULL,
  review_reason VARCHAR(1000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
  CONSTRAINT UQ_finance_departure_charge_review UNIQUE (cutoff_review_id, charge_id),
  CONSTRAINT CK_finance_departure_charge_review_term CHECK (term_number BETWEEN 1 AND 3),
  CONSTRAINT CK_finance_departure_charge_review_category CHECK (review_category IN ('canonical_tuition', 'manual_tuition', 'individual_fee')),
  CONSTRAINT CK_finance_departure_charge_review_decision CHECK (decision IN ('retain', 'reduce')),
  CONSTRAINT CK_finance_departure_charge_review_result CHECK (
    payable_after_amount = payable_before_amount - reviewed_reduction_amount
    AND proposed_reduction_amount <= CASE WHEN payable_before_amount > 0 THEN payable_before_amount ELSE 0 END
    AND reviewed_reduction_amount <= CASE WHEN payable_before_amount > 0 THEN payable_before_amount ELSE 0 END
    AND (decision <> 'retain' OR reviewed_reduction_amount = 0)
    AND (decision <> 'reduce' OR reviewed_reduction_amount > 0)
  ),
  CONSTRAINT FK_finance_departure_charge_review_context FOREIGN KEY
    (cutoff_review_id, departure_case_id) REFERENCES finance_departure_cutoff_reviews (id, departure_case_id),
  CONSTRAINT FK_finance_departure_charge_review_charge FOREIGN KEY (charge_id) REFERENCES assessed_charges(id),
  CONSTRAINT FK_finance_departure_charge_review_enrollment FOREIGN KEY (enrollment_id) REFERENCES enrollments(id)
);

CREATE INDEX IX_finance_departure_charge_review_case
  ON finance_departure_charge_reviews (departure_case_id, term_number, charge_id);
