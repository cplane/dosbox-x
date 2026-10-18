-- +goose Up
-- A user's dos-boxes. Running state is not stored: a box runs when its pod
-- (box-<id>) exists in the cluster.
CREATE TABLE box (
    id             uuid PRIMARY KEY,
    owner          uuid        NOT NULL,
    owner_name     text        NOT NULL,
    name           text        NOT NULL,
    created_at     timestamptz NOT NULL,
    last_active_at timestamptz NOT NULL,
    disk_limit_mb  integer     NOT NULL,
    used_bytes     bigint      NOT NULL DEFAULT 0
);
CREATE INDEX box_owner ON box (owner);

-- +goose Down
DROP TABLE box;
