-- Whole-paper completion is recorded after registrar inspection.
-- Existing template and signature rows remain historical evidence and are not required for new decisions.
ALTER TABLE student_term_clearances
  ADD recording_mode VARCHAR(24) NOT NULL DEFAULT 'signature_checklist' AFTER template_id,
  DROP CONSTRAINT CK_student_term_clearance_attestation,
  ADD CONSTRAINT CK_student_term_clearance_recording_mode
    CHECK (recording_mode IN ('signature_checklist', 'paper_confirmation')),
  ADD CONSTRAINT CK_student_term_clearance_attestation CHECK (
  (recording_mode = 'signature_checklist'
    AND ((attested_by IS NULL AND attested_at IS NULL)
      OR (attested_by IS NOT NULL AND attested_at IS NOT NULL AND scope_status = 'attended' AND template_id IS NOT NULL))
    AND (inspected_on IS NULL OR (scope_status = 'attended' AND template_id IS NOT NULL)))
  OR (recording_mode = 'paper_confirmation'
    AND ((attested_by IS NULL AND attested_at IS NULL)
      OR (attested_by IS NOT NULL AND attested_at IS NOT NULL AND scope_status = 'attended' AND inspected_on IS NOT NULL))
    AND (inspected_on IS NULL OR scope_status = 'attended'))
  );

ALTER TABLE student_term_clearance_events
  DROP CONSTRAINT CK_student_term_clearance_event_type,
  ADD CONSTRAINT CK_student_term_clearance_event_type CHECK
    (event_type IN ('created', 'scope_reviewed', 'items_updated', 'attested', 'reopened', 'paper_confirmation'));
