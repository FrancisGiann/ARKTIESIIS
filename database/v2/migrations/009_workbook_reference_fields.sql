/* Add optional staff-managed profile, annual administration, and finance reference fields. */

ALTER TABLE dbo.students ADD birthplace NVARCHAR(160) NULL;
ALTER TABLE dbo.students ADD facebook_name NVARCHAR(120) NULL;
ALTER TABLE dbo.students ADD emergency_contact_person NVARCHAR(160) NULL;
ALTER TABLE dbo.students ADD emergency_contact_relationship NVARCHAR(80) NULL;
ALTER TABLE dbo.students ADD emergency_contact_phone NVARCHAR(50) NULL;
ALTER TABLE dbo.students ADD emergency_contact_address NVARCHAR(500) NULL;
ALTER TABLE dbo.students ADD mother_name NVARCHAR(160) NULL;
ALTER TABLE dbo.students ADD mother_phone NVARCHAR(50) NULL;
ALTER TABLE dbo.students ADD father_name NVARCHAR(160) NULL;
ALTER TABLE dbo.students ADD father_phone NVARCHAR(50) NULL;
GO

ALTER TABLE dbo.annual_enrollments ADD esc_id NVARCHAR(80) NULL;
ALTER TABLE dbo.annual_enrollments ADD eform_status NVARCHAR(20) NOT NULL CONSTRAINT DF_annual_enrollment_eform_status DEFAULT N'not_recorded';
ALTER TABLE dbo.annual_enrollments ADD eform_remarks NVARCHAR(500) NULL;
ALTER TABLE dbo.annual_enrollments ADD lis_status NVARCHAR(20) NOT NULL CONSTRAINT DF_annual_enrollment_lis_status DEFAULT N'not_recorded';
ALTER TABLE dbo.annual_enrollments ADD lis_remarks NVARCHAR(500) NULL;
ALTER TABLE dbo.annual_enrollments ADD vms_status NVARCHAR(20) NOT NULL CONSTRAINT DF_annual_enrollment_vms_status DEFAULT N'not_recorded';
ALTER TABLE dbo.annual_enrollments ADD vms_remarks NVARCHAR(500) NULL;
ALTER TABLE dbo.annual_enrollments ADD acquaintance_waiver_status NVARCHAR(20) NOT NULL CONSTRAINT DF_annual_enrollment_acquaintance_status DEFAULT N'not_recorded';
ALTER TABLE dbo.annual_enrollments ADD acquaintance_party NVARCHAR(120) NULL;
ALTER TABLE dbo.annual_enrollments ADD educational_tour_status NVARCHAR(24) NOT NULL CONSTRAINT DF_annual_enrollment_tour_status DEFAULT N'not_recorded';
ALTER TABLE dbo.annual_enrollments ADD internal_agreement_remarks NVARCHAR(1000) NULL;
ALTER TABLE dbo.annual_enrollments ADD modules_claimed_date DATE NULL;
ALTER TABLE dbo.annual_enrollments ADD student_id_claimed_date DATE NULL;
ALTER TABLE dbo.annual_enrollments ADD uniform_claimed_date DATE NULL;
ALTER TABLE dbo.annual_enrollments ADD pe_uniform_claimed_date DATE NULL;
ALTER TABLE dbo.annual_enrollments ADD finance_handbook_number NVARCHAR(80) NULL;
GO

ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_eform_status
  CHECK (eform_status IN (N'not_recorded', N'pending', N'submitted', N'complete', N'not_applicable'));
ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_lis_status
  CHECK (lis_status IN (N'not_recorded', N'pending', N'submitted', N'complete', N'not_applicable'));
ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_vms_status
  CHECK (vms_status IN (N'not_recorded', N'pending', N'submitted', N'complete', N'not_applicable'));
ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_acquaintance_status
  CHECK (acquaintance_waiver_status IN (N'not_recorded', N'complete', N'not_applicable'));
ALTER TABLE dbo.annual_enrollments ADD CONSTRAINT CK_annual_enrollment_tour_status
  CHECK (educational_tour_status IN (N'not_recorded', N'participating', N'not_participating'));
GO

CREATE TABLE dbo.annual_enrollment_admin_revisions (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  revision_group UNIQUEIDENTIFIER NOT NULL,
  annual_enrollment_id INT NOT NULL,
  actor_id INT NOT NULL,
  field_name NVARCHAR(50) NOT NULL,
  before_value NVARCHAR(MAX) NULL,
  after_value NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_annual_enrollment_admin_revision_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_annual_enrollment_admin_revision_annual FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_annual_enrollment_admin_revision_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id),
  CONSTRAINT CK_annual_enrollment_admin_revision_field CHECK (field_name IN (
    N'esc_id', N'eform_status', N'eform_remarks', N'lis_status', N'lis_remarks', N'vms_status', N'vms_remarks',
    N'acquaintance_waiver_status', N'acquaintance_party', N'educational_tour_status', N'internal_agreement_remarks',
    N'modules_claimed_date', N'student_id_claimed_date', N'uniform_claimed_date', N'pe_uniform_claimed_date'
  ))
);
CREATE INDEX IX_annual_enrollment_admin_revision_history
  ON dbo.annual_enrollment_admin_revisions (annual_enrollment_id, created_at DESC, revision_group);
GO
CREATE TRIGGER dbo.TR_annual_enrollment_admin_revisions_append_only
ON dbo.annual_enrollment_admin_revisions
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51011, 'Annual enrollment administration history is append-only.', 1;
END;
GO

/* Existing profile history gains the optional fields without changing its append-only behavior. */
ALTER TABLE dbo.student_profile_revisions DROP CONSTRAINT CK_student_profile_revision_field;
ALTER TABLE dbo.student_profile_revisions ALTER COLUMN field_name NVARCHAR(50) NOT NULL;
ALTER TABLE dbo.student_profile_revisions ADD CONSTRAINT CK_student_profile_revision_field CHECK (field_name IN (
  N'student_no', N'lrn', N'first_name', N'middle_name', N'last_name', N'suffix',
  N'birth_date', N'sex', N'address', N'phone', N'birthplace', N'facebook_name',
  N'emergency_contact_person', N'emergency_contact_relationship', N'emergency_contact_phone',
  N'emergency_contact_address', N'mother_name', N'mother_phone', N'father_name', N'father_phone'
));
GO

CREATE TABLE dbo.finance_fee_comment_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  charge_id BIGINT NOT NULL,
  actor_id INT NOT NULL,
  comment NVARCHAR(1000) NOT NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_fee_comment_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_finance_fee_comment_charge FOREIGN KEY (charge_id) REFERENCES dbo.assessed_charges(id),
  CONSTRAINT FK_finance_fee_comment_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id),
  CONSTRAINT UQ_finance_fee_comment_token UNIQUE (idempotency_key)
);
CREATE INDEX IX_finance_fee_comment_charge_history ON dbo.finance_fee_comment_events(charge_id, created_at, id);
GO
CREATE TRIGGER dbo.TR_finance_fee_comment_events_append_only
ON dbo.finance_fee_comment_events
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51009, 'Finance fee comment history is append-only.', 1;
END;
GO

CREATE TABLE dbo.finance_handbook_number_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  annual_enrollment_id INT NOT NULL,
  actor_id INT NOT NULL,
  before_value NVARCHAR(80) NULL,
  after_value NVARCHAR(80) NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_finance_handbook_event_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_finance_handbook_event_annual FOREIGN KEY (annual_enrollment_id) REFERENCES dbo.annual_enrollments(id),
  CONSTRAINT FK_finance_handbook_event_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id),
  CONSTRAINT UQ_finance_handbook_event_token UNIQUE (idempotency_key)
);
CREATE INDEX IX_finance_handbook_event_history ON dbo.finance_handbook_number_events(annual_enrollment_id, created_at, id);
GO
CREATE TRIGGER dbo.TR_finance_handbook_number_events_append_only
ON dbo.finance_handbook_number_events
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51010, 'Finance handbook number history is append-only.', 1;
END;
GO
