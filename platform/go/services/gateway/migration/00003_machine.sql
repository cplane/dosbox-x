-- +goose Up
-- What the box emulates (gateway/machine.go): CPU model, memory, cycles.
ALTER TABLE box ADD COLUMN machine jsonb NOT NULL DEFAULT '{}'::jsonb;

-- +goose Down
ALTER TABLE box DROP COLUMN machine;
