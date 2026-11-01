CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  public_key bytea NOT NULL,
  key_alg text NOT NULL CHECK (key_alg IN ('X25519', 'P-256')),
  fingerprint text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name_sealed text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_key_version integer NOT NULL DEFAULT 1 CHECK (current_key_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE workspace_keys (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  wrapped_key text NOT NULL,
  wrapper_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, key_version),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  wrapped_key text NOT NULL,
  key_version integer NOT NULL CHECK (key_version >= 1),
  expires_at timestamptz NOT NULL,
  used_by uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workspace_members_by_user ON workspace_members(user_id, workspace_id);
CREATE INDEX workspaces_by_owner ON workspaces(owner_id, created_at DESC);
CREATE INDEX workspace_keys_by_user ON workspace_keys(user_id, workspace_id, key_version);
CREATE INDEX invites_pending_by_workspace
  ON invites(workspace_id, expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invites_by_creator ON invites(created_by, workspace_id);
