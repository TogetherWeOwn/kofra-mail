-- Link storage locations (docs/m3-outbound-plan.md, M3-15a).

-- Each deployment location id's fingerprint (SHA-256 of its fields), recorded on
-- first use. A later use with other fields is refused, so an id is never repointed.
CREATE TABLE link_location_fingerprints (
  location_id TEXT PRIMARY KEY NOT NULL CHECK (length(location_id) BETWEEN 1 AND 32
    AND location_id GLOB '[a-z0-9]*' AND NOT location_id GLOB '*[^a-z0-9_-]*'),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND NOT fingerprint GLOB '*[^0-9a-f]*'),
  recorded_at INTEGER NOT NULL
);

-- A workspace's own S3-compatible locations. The fields never change after the
-- insert; only the credential columns rotate. Secrets are stored sealed only
-- (AES-256-GCM under the versioned LINK_CRED_KEK, with the AAD binding workspace,
-- location, key version and role); the key ids' last 4 characters are the only
-- plain credential data. At most one location per workspace is `current`.
--
-- Anything that will reference a location (links, pending deletes, draft
-- attachments, unfinished uploads) must be written by a statement that requires
-- the location's `state = 'active'`: a delete first sets `deleting`, then checks
-- that nothing references the location, and only then removes the row.
CREATE TABLE link_storage_locations (
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 58 AND workspace_id NOT GLOB '*[^a-z0-9-]*' AND workspace_id NOT GLOB '*-'
    AND workspace_id NOT GLOB '*--*' AND workspace_id NOT GLOB '*-s3alias' AND instr(workspace_id, char(0)) = 0
    AND workspace_id NOT IN ('s3alias', '-ol-s3', '-x-s3', '-table-s3')),
  location_id TEXT NOT NULL CHECK (length(location_id) = 26 AND NOT location_id GLOB '*[^0-9a-z]*'),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 9 AND 512 AND endpoint GLOB 'https://*'),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 32),
  bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 3 AND 63),
  prefix TEXT NOT NULL CHECK (length(prefix) <= 256),
  path_style INTEGER NOT NULL CHECK (path_style IN (0, 1)),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND NOT fingerprint GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting')),
  current INTEGER NOT NULL CHECK (current IN (0, 1)),
  read_key_last4 TEXT NOT NULL CHECK (length(read_key_last4) = 4),
  read_key_version INTEGER NOT NULL CHECK (typeof(read_key_version) = 'integer' AND read_key_version BETWEEN 1 AND 255),
  read_sealed TEXT NOT NULL CHECK (length(read_sealed) BETWEEN 40 AND 2048),
  write_key_last4 TEXT NOT NULL CHECK (length(write_key_last4) = 4),
  write_key_version INTEGER NOT NULL CHECK (typeof(write_key_version) = 'integer' AND write_key_version BETWEEN 1 AND 255),
  write_sealed TEXT NOT NULL CHECK (length(write_sealed) BETWEEN 40 AND 2048),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  PRIMARY KEY (workspace_id, location_id)
);
CREATE UNIQUE INDEX link_storage_current ON link_storage_locations (workspace_id) WHERE current = 1;
-- The rewrap job's ordered walk and the version check's seeks, by key version.
CREATE INDEX link_storage_read_version ON link_storage_locations (read_key_version, workspace_id, location_id);
CREATE INDEX link_storage_write_version ON link_storage_locations (write_key_version, workspace_id, location_id);
