CREATE TABLE dbo.student_document_requests (
  id UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_student_document_request_id DEFAULT NEWID() PRIMARY KEY,
  student_id INT NOT NULL,
  document_type NVARCHAR(50) NOT NULL,
  document_name NVARCHAR(150) NOT NULL,
  requested_on DATE NOT NULL,
  requested_by INT NOT NULL,
  reference_text NVARCHAR(200) NULL,
  status NVARCHAR(20) NOT NULL CONSTRAINT DF_student_document_request_status DEFAULT N'requested'
    CHECK (status IN (N'requested', N'processing', N'ready', N'released', N'cancelled')),
  released_on DATE NULL,
  recipient NVARCHAR(150) NULL,
  create_idempotency_key UNIQUEIDENTIFIER NOT NULL,
  create_request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_student_document_request_created DEFAULT SYSUTCDATETIME(),
  updated_at DATETIME2 NOT NULL CONSTRAINT DF_student_document_request_updated DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_student_document_request_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_student_document_request_actor FOREIGN KEY (requested_by) REFERENCES dbo.users(id),
  CONSTRAINT CK_student_document_request_release CHECK (
    (status = N'released' AND released_on IS NOT NULL AND released_on >= requested_on
      AND recipient IS NOT NULL AND LEN(LTRIM(RTRIM(recipient))) > 0)
    OR (status <> N'released' AND released_on IS NULL AND recipient IS NULL)
  ),
  CONSTRAINT UQ_student_document_request_create_key UNIQUE (requested_by, create_idempotency_key)
);
CREATE INDEX IX_student_document_request_student
  ON dbo.student_document_requests (student_id, requested_on DESC, created_at DESC);
GO

CREATE TABLE dbo.student_document_request_events (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  request_id UNIQUEIDENTIFIER NOT NULL,
  actor_id INT NOT NULL,
  event_type NVARCHAR(20) NOT NULL
    CHECK (event_type IN (N'requested', N'processing', N'ready', N'released', N'cancelled', N'corrected')),
  status_from NVARCHAR(20) NULL,
  status_to NVARCHAR(20) NOT NULL
    CHECK (status_to IN (N'requested', N'processing', N'ready', N'released', N'cancelled')),
  document_type_before NVARCHAR(50) NULL,
  document_type_after NVARCHAR(50) NULL,
  document_name_before NVARCHAR(150) NULL,
  document_name_after NVARCHAR(150) NULL,
  requested_on_before DATE NULL,
  requested_on_after DATE NULL,
  reference_before NVARCHAR(200) NULL,
  reference_after NVARCHAR(200) NULL,
  released_on_before DATE NULL,
  released_on_after DATE NULL,
  recipient_before NVARCHAR(150) NULL,
  recipient_after NVARCHAR(150) NULL,
  released_on DATE NULL,
  recipient NVARCHAR(150) NULL,
  reason NVARCHAR(500) NULL,
  idempotency_key UNIQUEIDENTIFIER NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_student_document_request_event_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_student_document_request_event_request FOREIGN KEY (request_id) REFERENCES dbo.student_document_requests(id),
  CONSTRAINT FK_student_document_request_event_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id),
  CONSTRAINT UQ_student_document_request_event_key UNIQUE (request_id, idempotency_key),
  CONSTRAINT CK_student_document_request_event_status_pair CHECK (
    (event_type = N'corrected' AND status_from IS NOT NULL AND status_from = status_to)
    OR (event_type <> N'corrected' AND event_type = status_to)
  ),
  CONSTRAINT CK_student_document_request_event_release CHECK (
    (event_type = N'released' AND released_on IS NOT NULL AND requested_on_after IS NOT NULL
      AND released_on >= requested_on_after AND recipient IS NOT NULL AND LEN(LTRIM(RTRIM(recipient))) > 0
      AND released_on_before IS NULL AND released_on_after IS NULL
      AND recipient_before IS NULL AND recipient_after IS NULL)
    OR (event_type = N'corrected' AND status_to = N'released'
      AND released_on IS NULL AND recipient IS NULL
      AND released_on_before IS NOT NULL AND released_on_after IS NOT NULL
      AND requested_on_after IS NOT NULL AND released_on_after >= requested_on_after
      AND recipient_before IS NOT NULL AND LEN(LTRIM(RTRIM(recipient_before))) > 0
      AND recipient_after IS NOT NULL AND LEN(LTRIM(RTRIM(recipient_after))) > 0)
    OR (event_type = N'corrected' AND status_to <> N'released'
      AND released_on IS NULL AND recipient IS NULL
      AND released_on_before IS NULL AND released_on_after IS NULL
      AND recipient_before IS NULL AND recipient_after IS NULL)
    OR (event_type NOT IN (N'released', N'corrected')
      AND released_on IS NULL AND recipient IS NULL
      AND released_on_before IS NULL AND released_on_after IS NULL
      AND recipient_before IS NULL AND recipient_after IS NULL)
  ),
  CONSTRAINT CK_student_document_request_event_reason CHECK (
    (event_type IN (N'cancelled', N'corrected') AND reason IS NOT NULL AND LEN(LTRIM(RTRIM(reason))) >= 5)
    OR (event_type NOT IN (N'cancelled', N'corrected'))
  )
);
CREATE INDEX IX_student_document_request_event_history
  ON dbo.student_document_request_events (request_id, created_at, id);
GO
CREATE TRIGGER dbo.TR_student_document_request_events_append_only
ON dbo.student_document_request_events
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51007, 'Document request history is append-only.', 1;
END;
GO

CREATE TABLE dbo.student_profile_revisions (
  id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  revision_group UNIQUEIDENTIFIER NOT NULL,
  student_id INT NOT NULL,
  actor_id INT NOT NULL,
  field_name NVARCHAR(40) NOT NULL,
  before_value NVARCHAR(MAX) NULL,
  after_value NVARCHAR(MAX) NULL,
  created_at DATETIME2 NOT NULL CONSTRAINT DF_student_profile_revision_created DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_student_profile_revision_student FOREIGN KEY (student_id) REFERENCES dbo.students(id),
  CONSTRAINT FK_student_profile_revision_actor FOREIGN KEY (actor_id) REFERENCES dbo.users(id),
  CONSTRAINT CK_student_profile_revision_field CHECK (field_name IN (
    N'student_no', N'lrn', N'first_name', N'middle_name', N'last_name', N'suffix',
    N'birth_date', N'sex', N'address', N'phone'
  ))
);
CREATE INDEX IX_student_profile_revision_history
  ON dbo.student_profile_revisions (student_id, created_at DESC, revision_group);
GO
CREATE TRIGGER dbo.TR_student_profile_revisions_append_only
ON dbo.student_profile_revisions
INSTEAD OF UPDATE, DELETE
AS
BEGIN
  SET NOCOUNT ON;
  THROW 51007, 'Student profile revision history is append-only.', 1;
END;
GO
