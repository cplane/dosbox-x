-- +goose Up

-- An account. The id is what a match seat is attached to, so it must never
-- change: it is generated here rather than derived from an email or a
-- provider subject, both of which a player can change or lose.
CREATE TABLE identity (
    id             uuid PRIMARY KEY,
    username       text        NOT NULL,
    email          text,
    -- Null for an account created through a federated provider: there is no
    -- password, rather than an empty one that could be guessed.
    password_hash  text,
    -- The provider's stable subject claim, never the email. An email can be
    -- reassigned by its domain owner; "sub" is the only identifier Google
    -- promises is permanent for an account.
    google_subject text,
    role           text        NOT NULL DEFAULT 'player',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: "Duncan" and "duncan" must not be two players,
-- or a display name becomes an impersonation vector.
CREATE UNIQUE INDEX identity_username_key ON identity (lower(username));

-- Partial, because most rows have neither column. A plain unique index would
-- treat every null as distinct on some engines and collide on others; this
-- says exactly what is meant — at most one account per address, and at most
-- one per Google subject.
CREATE UNIQUE INDEX identity_email_key ON identity (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX identity_google_subject_key ON identity (google_subject) WHERE google_subject IS NOT NULL;

-- Refresh tokens are stored hashed, like passwords: the database is the thing
-- most likely to leak, and a plaintext refresh token is a session.
CREATE TABLE refresh_token (
    id          uuid PRIMARY KEY,
    identity_id uuid        NOT NULL REFERENCES identity (id) ON DELETE CASCADE,
    token_hash  text        NOT NULL UNIQUE,
    issued_at   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    -- Set when this token was spent by rotation, left null when it was
    -- revoked by signing out. That distinction is load-bearing: "revoked with
    -- a successor" means the owner is simply racing itself and may be
    -- forgiven inside the grace window, while "revoked with none" means
    -- signed out and must never be honoured again.
    replaced_by uuid        REFERENCES refresh_token (id)
);

CREATE INDEX refresh_token_identity_idx ON refresh_token (identity_id);
-- Expired rows are swept periodically; the index keeps that from scanning.
CREATE INDEX refresh_token_expires_idx ON refresh_token (expires_at);

-- +goose Down
DROP TABLE refresh_token;
DROP TABLE identity;
