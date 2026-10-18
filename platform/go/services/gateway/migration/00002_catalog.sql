-- +goose Up
-- Ready-made DOS software a box can get a copy of on its C: drive. The files
-- live on the shared volume (<boxes>/_catalog/<slug>) and, zipped, in DO
-- Spaces (catalog/<slug>.zip); this row is the item's description.
CREATE TABLE catalog_item (
    slug        text PRIMARY KEY,
    title       text        NOT NULL,
    category    text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    dir         text        NOT NULL, -- folder created on C:, e.g. KEEN1
    run         text        NOT NULL DEFAULT '', -- program in dir, e.g. KEEN1.EXE
    source      text        NOT NULL DEFAULT '',
    license     text        NOT NULL DEFAULT '',
    size_bytes  bigint      NOT NULL DEFAULT 0,
    files       integer     NOT NULL DEFAULT 0,
    status      text        NOT NULL, -- ready | importing | failed
    error       text        NOT NULL DEFAULT '',
    created_by  text        NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
);

-- +goose Down
DROP TABLE catalog_item;
