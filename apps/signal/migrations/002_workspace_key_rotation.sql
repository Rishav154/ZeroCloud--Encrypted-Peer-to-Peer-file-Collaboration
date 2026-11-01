ALTER TABLE workspaces
  ADD COLUMN needs_rotation boolean NOT NULL DEFAULT false;
